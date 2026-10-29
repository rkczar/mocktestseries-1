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
import { OpenRouterError, TRANSIENT_OPENROUTER_ERRORS, chatCompletion, describeCategory, generateImage, sanitize, type ChatContentPart, type OpenRouterErrorCategory, type ProviderPreferences } from "@/lib/ai-engine/openrouter";
import { profileFor } from "@/lib/ai-engine/profiles";
import { STRUCTURED_MESSAGES, extractJsonObject, isClassifierVerdict, type StructuredFailure } from "@/lib/ai-engine/structured";
import { isOutputFailure } from "@/lib/ai-engine/errors";

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
 * Retries, fallbacks and output checks: see generateTextViaOpenRouter.
 */

export class AiEngineFailure extends Error {
  constructor(
    message: string,
    /** Last adapter / output category (lib/ai-engine/errors.ts maps it to a normalized code). */
    public category: string | null = null,
    /** Correlation id of the AiGatewayCall rows. */
    public requestId: string | null = null
  ) {
    super(message);
  }
}

export interface EngineContext {
  actorId?: string | null;
  quoteId?: string | null;
  /** Model chosen in a one-time cost quote (admin cost preview). */
  modelOverride?: string | null;
  instagramPostId?: string | null;
  /** Model quality evaluation run (Admin → AI → Models): the model under test only. */
  evaluation?: boolean;
  /** Reuse a caller's correlation id (one id across a multi-call action such as trap + re-solve). */
  correlationId?: string | null;
  /** Tighter whole-request deadline than the task profile's (ms from now). */
  deadlineMs?: number;
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

/** Thinking tokens allowed on reasoning models: a quarter of the output limit, 256…2,000 (the rest stays for the answer). */
export function reasoningBudget(maxOutputTokens: number): number {
  return Math.max(256, Math.min(2000, Math.floor(maxOutputTokens / 4)));
}

/** Wait before retry n (1-based) after a transient error: Retry-After when sent, else 1 s · 2^(n-1) with ±25 % jitter, at most 8 s. */
export function backoffMs(n: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const base = Math.min(8_000, 1_000 * 2 ** (n - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

/** Errors tied to the requested model: the next planned model may work. */
const MODEL_SPECIFIC: OpenRouterErrorCategory[] = ["model_unavailable", "no_endpoint"];
/** Time an attempt needs to be worth starting. */
const MIN_ATTEMPT_MS = 4_000;
/** Hard ceiling on provider attempts for one request (transient retries + model fallbacks). */
export const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Text generation through OpenRouter for one feature. Same contract as the gateway's other providers.
 *
 * Reliability policy (2026-10-29):
 *  - one deadline for the whole request (the feature's task profile; interactive features stay under the
 *    60 s proxy timeout), covering every attempt, its body read and any retry wait;
 *  - transient errors (429, 5xx, network) are retried up to the feature's maxRetries with exponential backoff
 *    and jitter, honouring Retry-After; never after a timeout (the provider may have billed);
 *  - an unusable answer (empty, cut off, not JSON, classifier verdict, failed `opts.check`) is a failed
 *    attempt: the answering model is dropped and the next planned model is asked — never the same answer twice;
 *  - model-specific errors (model / route unavailable) move to the next planned model;
 *  - auth, credits, bad requests and moderation stop at once (no other model can fix them);
 *  - at most MAX_ATTEMPTS provider calls, each logged with the same requestId.
 * `extra.content`: optional multimodal parts (AI Video Studio image sources); sent instead of `prompt` when set.
 */
export async function generateTextViaOpenRouter(feature: AiFeature, prompt: string, opts: AiGenerationOptions, ctx: EngineContext = {}, extra: { content?: ChatContentPart[] } = {}): Promise<AiGenerationResult> {
  const { apiKey, engine, fx, cfg } = await prepare(feature, "text");
  const def = ENGINE_FEATURE_MAP[feature];
  const profile = profileFor(feature);
  const deadline = Date.now() + Math.min(profile.deadlineMs, ctx.deadlineMs ?? Number.POSITIVE_INFINITY);
  const maxOut = cfg.maxOutputTokens ?? opts.maxOutputTokens;
  const inputTokens = estimateTokens(prompt);
  const typicalOut = await typicalOutputTokens(feature, maxOut);
  const capUsd = capUsdFor(engine, cfg, "text", fx);
  // Re-planned at execution time from the current catalog prices, even when a quote was approved.
  const plan = await planText({ feature, cfg, inputTokens, maxOut, typicalOut, override: ctx.modelOverride ?? null, capUsd, evaluation: ctx.evaluation });
  const maxInr = usdToInr(plan.maxUsd, fx.rate)!;
  const requested = plan.models[0]?.id ?? "openrouter/auto";
  const requestId = ctx.correlationId ?? crypto.randomUUID();
  const wantJson = opts.json === true;

  let chain = plan.models.map((m) => m.id);
  let lastError: OpenRouterError | null = null;
  let transientRetries = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      lastError ??= new OpenRouterError("timeout", `No answer within the ${Math.round(profile.deadlineMs / 1000)} s limit for this feature.`);
      break;
    }
    const first = chain[0] ?? requested;
    const params = plan.supported[first] ?? [];
    const requestKey = `${requestId}:${attempt}`;
    await reserveBudget({ requestKey, feature, featureLabel: def?.label ?? feature, reservedInr: maxInr, budgets: engine.budgets, featureDailyInr: cfg.dailyBudgetInr });
    const started = Date.now();
    try {
      const r = await chatCompletion({
        apiKey,
        models: chain.length ? chain : [requested],
        prompt,
        ...(extra.content ? { content: extra.content } : {}),
        maxTokens: maxOut,
        temperature: opts.temperature,
        provider: providerPrefs(engine, { prompt: plan.maxPricePerM.prompt, completion: plan.maxPricePerM.completion }),
        timeoutMs: Math.min(cfg.timeoutMs, remaining),
        totalDeadline: true,
        autoRouter: plan.mode === "auto" ? { costTier: cfg.autoCostTier, allowedModels: plan.autoAllowed ?? undefined } : undefined,
        // JSON mode where the first planned model accepts it (OpenRouter drops it for fallbacks that do not).
        ...(wantJson && params.includes("response_format") ? { responseFormat: { type: "json_object" as const } } : {}),
        // Reasoning models could spend the whole output limit thinking and answer nothing (2026-10: 28 empty explanations).
        ...(params.includes("reasoning") ? { reasoning: { max_tokens: reasoningBudget(maxOut), exclude: true } } : {}),
      });
      const costStatus = r.costUsd !== null ? "actual" : r.generationId ? "pending" : "unknown";
      if (r.costUsd !== null) await settleBudget(requestKey, usdToInr(r.costUsd, fx.rate));
      else await settleBudget(requestKey, null);
      const fallbackUsed = plan.mode !== "auto" && r.model !== requested && !r.model.startsWith(`${requested}-`);
      const outcome = checkOutput(r.text, r.finishReason, r.reasoningOnly === true, opts);
      await logEngineCall({
        feature, requestId, attempt, model: r.model, modelRequested: first, kind: "text", routingMode: plan.mode, ok: outcome === null, latencyMs: Date.now() - started,
        errorCategory: outcome?.category ?? null, errorSummary: outcome?.message ?? null,
        inputTokens: r.inputTokens, outputTokens: r.outputTokens, generationId: r.generationId,
        estUsd: plan.typicalUsd, actualUsd: r.costUsd, costStatus, fx, fallbackUsed, ctx,
      });
      await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
      if (outcome === null) return { text: r.text, provider: "openrouter", model: r.model, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens }, requestId, attempts: attempt, fallbackUsed };
      // Unusable answer: never ask the same model again for this request.
      lastError = new OpenRouterError(outcome.category as OpenRouterErrorCategory, outcome.message, 200, r.generationId);
      const answered = r.model;
      chain = chain.filter((id) => id !== answered && !answered.startsWith(`${id}-`) && id !== first);
      if (!chain.length) break;
    } catch (error) {
      const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
      lastError = e;
      // Timeout: the provider may still finish and bill → keep the worst case. Reported generation id → pending.
      const billedUnknown = e.category === "timeout" || e.generationId !== null;
      if (billedUnknown) await settleBudget(requestKey, null);
      else await releaseBudget(requestKey);
      await logEngineCall({
        feature, requestId, attempt, model: first, modelRequested: first, kind: "text", routingMode: plan.mode, ok: false, latencyMs: Date.now() - started,
        errorCategory: e.category, errorSummary: e.message, generationId: e.generationId,
        estUsd: plan.typicalUsd, actualUsd: null, costStatus: e.generationId ? "pending" : billedUnknown ? "unknown" : "none", fx, fallbackUsed: false, ctx,
      });
      await patchOpenRouterState({ lastError: { category: e.category, message: sanitize(e.message), at: new Date().toISOString() } });
      if (MODEL_SPECIFIC.includes(e.category)) {
        chain = chain.slice(1);
        if (!chain.length) break;
        continue;
      }
      if (!TRANSIENT_OPENROUTER_ERRORS.includes(e.category) || transientRetries >= cfg.maxRetries) break;
      transientRetries++;
      const wait = backoffMs(transientRetries, e.retryAfterMs);
      if (Date.now() + wait + MIN_ATTEMPT_MS > deadline) break;
      await sleep(wait);
    }
  }
  const e = lastError!;
  const label = isOutputFailure(e.category) ? STRUCTURED_MESSAGES[e.category as StructuredFailure] ?? describeCategory(e.category) : describeCategory(e.category);
  throw new AiEngineFailure(`OpenRouter failed: ${label} ${e.message !== label ? `(${sanitize(e.message).slice(0, 160)})` : ""}`.trim(), e.category, requestId);
}

/** null = usable answer; otherwise why it is not (pure; exported for the test suite). */
export function checkOutput(text: string, finishReason: string | null, reasoningOnly: boolean, opts: Pick<AiGenerationOptions, "check" | "json">): { category: StructuredFailure; message: string } | null {
  const empty = !text.trim();
  if (empty) return finishReason === "length" || reasoningOnly ? { category: "truncated", message: "The model used its whole output limit (reasoning) and returned no answer." } : { category: "empty_response", message: STRUCTURED_MESSAGES.empty_response };
  if (opts.check) {
    const c = opts.check(text);
    if (!c.ok) return finishReason === "length" && c.category !== "non_answer" ? { category: "truncated", message: STRUCTURED_MESSAGES.truncated } : { category: c.category, message: c.message };
    return null;
  }
  if (isClassifierVerdict(text)) return { category: "non_answer", message: STRUCTURED_MESSAGES.non_answer };
  if (opts.json) {
    const j = extractJsonObject(text);
    if (!j.ok) return { category: finishReason === "length" ? "truncated" : j.category, message: j.message };
  } else if (finishReason === "length") return { category: "truncated", message: STRUCTURED_MESSAGES.truncated };
  return null;
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
