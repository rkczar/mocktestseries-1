import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { AiNotConfiguredError, type AiGenerationOptions, type AiGenerationResult } from "@/lib/ai-provider";
import type { AiFeature } from "@/lib/ai-gateway-config";
import { ENGINE_FEATURE_MAP, estimateTokens, usdToInr, type FeatureEngineConfig } from "@/lib/ai-engine/config";
import { getEngineConfig, patchOpenRouterState, resolveOpenRouterKey, type EngineConfig } from "@/lib/ai-engine/settings";
import { getUsdInr, type FxRate } from "@/lib/ai-engine/fx";
import { releaseBudget, reserveBudget, settleBudget } from "@/lib/ai-engine/budget";
import { IMAGE_ASPECT, IMAGE_RESOLUTION, planImage, planText } from "@/lib/ai-engine/router";
import { OpenRouterError, TRANSIENT_OPENROUTER_ERRORS, chatCompletion, describeCategory, generateImage, sanitize, type ProviderPreferences } from "@/lib/ai-engine/openrouter";

/**
 * AI Engine execution: one priced, budgeted, logged OpenRouter request.
 *
 *   plan model(s) → worst-case cost → per-request cap → reserve budget
 *   → OpenRouter (provider.sort=price, max_price ceiling, privacy policy,
 *     approved `models` fallbacks) → settle to the reported cost → log.
 *
 * Every attempt is one AiGatewayCall row (provider "openrouter") with tokens,
 * estimated and actual USD/INR, the USD→INR rate used, fallback flag, quote id
 * and the related Instagram post. An unknown cost is stored as NULL (never 0).
 * Retries: only after rate-limit / provider 5xx / network errors, at most the
 * feature's maxRetries; never after a timeout (the provider may have billed).
 */

export class AiEngineFailure extends Error {}

export interface EngineContext {
  actorId?: string | null;
  quoteId?: string | null;
  /** Model chosen in a one-time cost quote (admin cost preview). */
  modelOverride?: string | null;
  instagramPostId?: string | null;
  /** Model quality evaluation run (Admin → AI → Models): the model under test only. */
  evaluation?: boolean;
}

const MAX_FALLBACK_LOG = 80;

function capUsdFor(engine: EngineConfig, cfg: FeatureEngineConfig, kind: "text" | "image", fx: FxRate): number {
  const capInr = cfg.maxCostInr ?? (kind === "image" ? engine.budgets.maxImageRequestInr : engine.budgets.maxTextRequestInr);
  return capInr / (fx.rate as number);
}

async function typicalOutputTokens(feature: AiFeature, maxOut: number): Promise<number> {
  const agg = await prisma.aiGatewayCall.aggregate({ where: { feature, ok: true, outputTokens: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _avg: { outputTokens: true } });
  const avg = agg._avg.outputTokens;
  return Math.min(maxOut, Math.max(1, Math.round(avg ?? maxOut * 0.5)));
}

interface LogEntry {
  feature: AiFeature;
  requestId: string;
  attempt: number;
  model: string;
  modelRequested: string | null;
  kind: "text" | "image";
  routingMode: string;
  ok: boolean;
  latencyMs: number;
  errorCategory?: string | null;
  errorSummary?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  generationId?: string | null;
  estUsd: number | null;
  actualUsd: number | null;
  costStatus: "actual" | "pending" | "unknown" | "none";
  fx: FxRate;
  fallbackUsed: boolean;
  imageCount?: number | null;
  ctx: EngineContext;
}

async function logEngineCall(e: LogEntry): Promise<void> {
  try {
    await prisma.aiGatewayCall.create({
      data: {
        feature: e.feature,
        provider: "openrouter",
        model: e.model.slice(0, MAX_FALLBACK_LOG),
        modelRequested: e.modelRequested?.slice(0, MAX_FALLBACK_LOG) ?? null,
        kind: e.kind,
        routingMode: e.routingMode,
        ok: e.ok,
        errorCategory: e.errorCategory ?? null,
        errorSummary: e.errorSummary ? sanitize(e.errorSummary) : null,
        latencyMs: e.latencyMs,
        inputTokens: e.inputTokens ?? null,
        outputTokens: e.outputTokens ?? null,
        estCostUsd: e.estUsd,
        estCostInr: usdToInr(e.estUsd, e.fx.rate),
        actualCostUsd: e.actualUsd,
        actualCostInr: usdToInr(e.actualUsd, e.fx.rate),
        fxRate: e.fx.rate,
        fxAt: e.fx.at,
        costStatus: e.costStatus,
        generationId: e.generationId ?? null,
        fallbackUsed: e.fallbackUsed,
        imageCount: e.imageCount ?? null,
        attempt: e.attempt,
        requestId: e.requestId,
        actorId: e.ctx.actorId ?? null,
        quoteId: e.ctx.quoteId ?? null,
        instagramPostId: e.ctx.instagramPostId ?? null,
      },
    });
  } catch (error) {
    // A duplicate generationId means this cost is already recorded — never double count.
    console.error("[ai-engine] could not log call", error instanceof Error ? error.message.slice(0, 120) : "unknown");
  }
}

async function prepare(feature: AiFeature, kind: "text" | "image") {
  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) throw new AiNotConfiguredError(`${ENGINE_FEATURE_MAP[feature]?.label ?? feature} is set to OpenRouter, but OpenRouter is not configured or is disabled (AI → Providers).`);
  const engine = await getEngineConfig();
  if (engine.budgets.emergencyStop) throw new AiNotConfiguredError("AI generation is stopped by the AI emergency stop (Admin → AI → Budgets).");
  const fx = await getUsdInr();
  if (fx.rate === null) throw new AiNotConfiguredError(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate."} Nothing was sent to the AI provider.`);
  const cfg = engine.features[feature];
  void kind;
  return { apiKey, engine, fx, cfg };
}

function providerPrefs(engine: EngineConfig, maxPrice: ProviderPreferences["max_price"]): ProviderPreferences {
  return {
    sort: "price",
    max_price: maxPrice,
    data_collection: engine.privacy.dataCollection,
    ...(engine.privacy.zdr ? { zdr: true } : {}),
    allow_fallbacks: true,
  };
}

/** Text generation through OpenRouter for one feature. Same contract as the gateway's other providers. */
export async function generateTextViaOpenRouter(feature: AiFeature, prompt: string, opts: AiGenerationOptions, ctx: EngineContext = {}): Promise<AiGenerationResult> {
  const { apiKey, engine, fx, cfg } = await prepare(feature, "text");
  const def = ENGINE_FEATURE_MAP[feature];
  const maxOut = cfg.maxOutputTokens ?? opts.maxOutputTokens;
  const inputTokens = estimateTokens(prompt);
  const typicalOut = await typicalOutputTokens(feature, maxOut);
  const capUsd = capUsdFor(engine, cfg, "text", fx);
  // Re-planned at execution time from the current catalog prices, even when a quote was approved.
  const plan = await planText({ feature, cfg, inputTokens, maxOut, typicalOut, override: ctx.modelOverride ?? null, capUsd, evaluation: ctx.evaluation });
  const maxInr = usdToInr(plan.maxUsd, fx.rate)!;
  const requested = plan.models[0]?.id ?? "openrouter/auto";
  const requestId = crypto.randomUUID();

  let lastError: OpenRouterError | null = null;
  for (let attempt = 1; attempt <= 1 + cfg.maxRetries; attempt++) {
    const requestKey = `${requestId}:${attempt}`;
    await reserveBudget({ requestKey, feature, featureLabel: def?.label ?? feature, reservedInr: maxInr, budgets: engine.budgets, featureDailyInr: cfg.dailyBudgetInr });
    const started = Date.now();
    try {
      const r = await chatCompletion({
        apiKey,
        models: plan.models.map((m) => m.id),
        prompt,
        maxTokens: maxOut,
        temperature: opts.temperature,
        provider: providerPrefs(engine, { prompt: plan.maxPricePerM.prompt, completion: plan.maxPricePerM.completion }),
        timeoutMs: cfg.timeoutMs,
        autoRouter: plan.mode === "auto" ? { costTier: cfg.autoCostTier, allowedModels: plan.autoAllowed ?? undefined } : undefined,
      });
      const costStatus = r.costUsd !== null ? "actual" : r.generationId ? "pending" : "unknown";
      if (r.costUsd !== null) await settleBudget(requestKey, usdToInr(r.costUsd, fx.rate));
      else await settleBudget(requestKey, null);
      const fallbackUsed = plan.mode !== "auto" && r.model !== requested && !r.model.startsWith(`${requested}-`);
      const empty = !r.text.trim();
      await logEngineCall({
        feature, requestId, attempt, model: r.model, modelRequested: requested, kind: "text", routingMode: plan.mode, ok: !empty, latencyMs: Date.now() - started,
        errorCategory: empty ? "empty_response" : null, errorSummary: empty ? describeCategory("empty_response") : null,
        inputTokens: r.inputTokens, outputTokens: r.outputTokens, generationId: r.generationId,
        estUsd: plan.typicalUsd, actualUsd: r.costUsd, costStatus, fx, fallbackUsed, ctx,
      });
      await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
      if (empty) throw new OpenRouterError("empty_response", describeCategory("empty_response"));
      return { text: r.text, provider: "openrouter", model: r.model, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } };
    } catch (error) {
      if (error instanceof OpenRouterError && error.category === "empty_response") throw new AiEngineFailure(`OpenRouter: ${error.message}`);
      const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
      lastError = e;
      // Timeout: the provider may still finish and bill → keep the worst case. Reported generation id → pending.
      const billedUnknown = e.category === "timeout" || e.generationId !== null;
      if (billedUnknown) await settleBudget(requestKey, null);
      else await releaseBudget(requestKey);
      await logEngineCall({
        feature, requestId, attempt, model: requested, modelRequested: requested, kind: "text", routingMode: plan.mode, ok: false, latencyMs: Date.now() - started,
        errorCategory: e.category, errorSummary: e.message, generationId: e.generationId,
        estUsd: plan.typicalUsd, actualUsd: null, costStatus: e.generationId ? "pending" : billedUnknown ? "unknown" : "none", fx, fallbackUsed: false, ctx,
      });
      await patchOpenRouterState({ lastError: { category: e.category, message: sanitize(e.message), at: new Date().toISOString() } });
      if (!TRANSIENT_OPENROUTER_ERRORS.includes(e.category)) break;
    }
  }
  const e = lastError!;
  throw new AiEngineFailure(`OpenRouter failed: ${describeCategory(e.category)} ${e.message !== describeCategory(e.category) ? `(${sanitize(e.message).slice(0, 160)})` : ""}`.trim());
}

/** One image through the OpenRouter Images API. Returns the raw bytes; the caller re-encodes and stores them. */
export async function generateImageViaOpenRouter(feature: AiFeature, prompt: string, ctx: EngineContext = {}): Promise<{ bytes: Buffer; model: string }> {
  const { apiKey, engine, fx, cfg } = await prepare(feature, "image");
  const def = ENGINE_FEATURE_MAP[feature];
  const plan = await planImage({ feature, cfg, override: ctx.modelOverride ?? null, capUsd: capUsdFor(engine, cfg, "image", fx) });
  const maxInr = usdToInr(plan.maxUsd, fx.rate)!;
  const requestId = crypto.randomUUID();
  const requestKey = `${requestId}:1`;
  await reserveBudget({ requestKey, feature, featureLabel: def?.label ?? feature, reservedInr: maxInr, budgets: engine.budgets, featureDailyInr: cfg.dailyBudgetInr });
  const started = Date.now();
  try {
    const r = await generateImage({
      apiKey,
      model: plan.model.id,
      prompt,
      aspectRatio: IMAGE_ASPECT,
      resolution: IMAGE_RESOLUTION,
      provider: providerPrefs(engine, plan.model.imageUnit === "image" ? { image: plan.model.imageUnitCostUsd ?? undefined } : undefined),
      timeoutMs: Math.max(cfg.timeoutMs, 90_000),
    });
    const costStatus = r.costUsd !== null ? "actual" : r.generationId ? "pending" : "unknown";
    await settleBudget(requestKey, r.costUsd !== null ? usdToInr(r.costUsd, fx.rate) : null);
    await logEngineCall({ feature, requestId, attempt: 1, model: r.model, modelRequested: plan.model.id, kind: "image", routingMode: ctx.modelOverride ? "manual" : cfg.mode === "manual" ? "manual" : "cheapest", ok: true, latencyMs: Date.now() - started, generationId: r.generationId, estUsd: plan.maxUsd, actualUsd: r.costUsd, costStatus, fx, fallbackUsed: false, imageCount: 1, ctx });
    await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
    return { bytes: r.bytes, model: r.model };
  } catch (error) {
    const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
    // The Images API bills only completed images; a timeout is the one case it may have completed.
    if (e.category === "timeout") await settleBudget(requestKey, null);
    else await releaseBudget(requestKey);
    await logEngineCall({ feature, requestId, attempt: 1, model: plan.model.id, modelRequested: plan.model.id, kind: "image", routingMode: cfg.mode, ok: false, latencyMs: Date.now() - started, errorCategory: e.category, errorSummary: e.message, generationId: e.generationId, estUsd: plan.maxUsd, actualUsd: null, costStatus: e.category === "timeout" ? "unknown" : "none", fx, fallbackUsed: false, imageCount: 0, ctx });
    await patchOpenRouterState({ lastError: { category: e.category, message: sanitize(e.message), at: new Date().toISOString() } });
    throw new AiEngineFailure(`OpenRouter image generation failed: ${describeCategory(e.category)}`);
  }
}
