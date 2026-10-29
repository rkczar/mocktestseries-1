import "server-only";
import { prisma } from "@/lib/prisma";
import { getAiSettings } from "@/lib/ai-settings";
import {
  AiNotConfiguredError,
  assertAiGenerationOpen,
  generateWithAi,
  generateWithSingleProvider,
  isAiGenerationConfigured,
  isProviderUsable,
  type AiGenerationOptions,
  type AiGenerationResult,
} from "@/lib/ai-provider";
import { ClaudeError, TRANSIENT_CLAUDE_ERRORS, callClaude, sanitizeProviderMessage } from "@/lib/anthropic-client";
import { recordClaudeOutcome, resolveClaude } from "@/lib/anthropic-config";
import { istStartOfDay } from "@/lib/ist-time";
import { getEngineConfig, resolveOpenRouterKey } from "@/lib/ai-engine/settings";
import { ENGINE_FEATURE_MAP } from "@/lib/ai-engine/config";
import { AiEngineFailure, checkOutput, generateTextViaOpenRouter } from "@/lib/ai-engine/engine";
import { AiBudgetError } from "@/lib/ai-engine/budget";
import { profileFor } from "@/lib/ai-engine/profiles";
import type { RuntimeConfig } from "@/lib/ai-engine/config";
import {
  AI_FEATURE_KEYS,
  DEFAULT_PRICES,
  DEFAULT_ROUTE,
  FEATURE_LABELS,
  LEGACY_ROUTE_PARENT,
  PROVIDER_LABELS,
  estimateCost,
  normalizeRoute,
  routeChain,
  type AiFeature,
  type FeatureRoute,
  type GatewayProvider,
  type ModelPrice,
} from "@/lib/ai-gateway-config";

/**
 * Unified AI Gateway — every AI feature asks for text through
 * generateForFeature(feature, …). Per feature, Admin → AI Solutions → AI
 * Providers sets the route: primary provider, two fallbacks, model, timeout,
 * retries and a daily cap. Routes are stored in the `ai.gateway` Setting and
 * read from the DB on every call, so a change applies on all PM2 workers at
 * once, without a restart.
 *
 * A feature whose route is "inherit" (the default for every feature) runs
 * exactly the existing production path, lib/ai-provider.ts#generateWithAi —
 * so installing the gateway changes no provider routing by itself.
 *
 * Every provider attempt is logged to AiGatewayCall (feature, provider, model,
 * tokens, estimated cost, latency, sanitized error) — never prompts, responses
 * or keys.
 */

export const GATEWAY_SETTING_KEY = "ai.gateway";

/** Every configured provider failed. The message is sanitized and safe to show an admin. */
export class AiProviderFailure extends Error {
  constructor(
    message: string,
    /** Last failure category (lib/ai-engine/errors.ts → normalized code), when known. */
    public category: string | null = null,
    public requestId: string | null = null
  ) {
    super(message);
  }
}

interface StoredGateway {
  routes?: Partial<Record<AiFeature, unknown>>;
  prices?: Record<string, ModelPrice>;
  updatedAt?: string;
}

export interface GatewayConfig {
  routes: Record<AiFeature, FeatureRoute>;
  prices: Record<string, ModelPrice>;
  updatedAt: string | null;
}

export async function getGatewayConfig(): Promise<GatewayConfig> {
  const row = await prisma.setting.findUnique({ where: { key: GATEWAY_SETTING_KEY } });
  const raw = (row?.value as StoredGateway | undefined) ?? {};
  const stored = (f: AiFeature) => raw.routes?.[f] ?? (LEGACY_ROUTE_PARENT[f] ? raw.routes?.[LEGACY_ROUTE_PARENT[f]!] : undefined);
  const routes = Object.fromEntries(AI_FEATURE_KEYS.map((f) => [f, stored(f) ? normalizeRoute(stored(f)) : { ...DEFAULT_ROUTE }])) as Record<AiFeature, FeatureRoute>;
  const prices: Record<string, ModelPrice> = { ...DEFAULT_PRICES };
  for (const [model, p] of Object.entries(raw.prices ?? {})) {
    if (p && Number.isFinite(p.input) && Number.isFinite(p.output) && p.input >= 0 && p.output >= 0) prices[model] = { input: p.input, output: p.output };
  }
  return { routes, prices, updatedAt: raw.updatedAt ?? null };
}

export async function saveGatewayConfig(update: { routes?: Partial<Record<AiFeature, unknown>>; prices?: Record<string, ModelPrice> }): Promise<GatewayConfig> {
  const row = await prisma.setting.findUnique({ where: { key: GATEWAY_SETTING_KEY } });
  const raw = (row?.value as StoredGateway | undefined) ?? {};
  const routes = { ...(raw.routes ?? {}) };
  for (const [f, r] of Object.entries(update.routes ?? {})) {
    if ((AI_FEATURE_KEYS as string[]).includes(f)) routes[f as AiFeature] = normalizeRoute(r);
  }
  const next: StoredGateway = { routes, prices: update.prices ?? raw.prices ?? {}, updatedAt: new Date().toISOString() };
  await prisma.setting.upsert({
    where: { key: GATEWAY_SETTING_KEY },
    update: { value: next as unknown as object },
    create: { key: GATEWAY_SETTING_KEY, value: next as unknown as object },
  });
  return getGatewayConfig();
}

// ---- Provider availability ---------------------------------------------------------

/** Direct Claude / OpenAI REST calls are refused at runtime unless the (rollback-only) switch is on. */
export function isDirectProviderBlocked(p: GatewayProvider, runtime: RuntimeConfig): boolean {
  return (p === "anthropic" || p === "openai") && !runtime.directClaudeOpenAi;
}

export async function isGatewayProviderUsable(p: GatewayProvider): Promise<boolean> {
  if (isDirectProviderBlocked(p, (await getEngineConfig()).runtime)) return false;
  if (p === "anthropic") return (await resolveClaude()) !== null;
  return isProviderUsable(p);
}

/** True when the feature has at least one usable provider (replaces isAiGenerationConfigured for routed features). */
export async function isFeatureConfigured(feature: AiFeature): Promise<boolean> {
  const engine = await getEngineConfig();
  const fc = engine.features[feature];
  if (!fc.enabled || engine.budgets.emergencyStop) return false;
  if (fc.provider === "openrouter") {
    if (isStudentFeature(feature) && !(await getAiSettings()).askAiEnabled) return false;
    return (await resolveOpenRouterKey()) !== null || (engine.runtime.geminiFallback && (await isProviderUsable("gemini")));
  }
  const { routes } = await getGatewayConfig();
  const route = routes[feature];
  if (route.mode === "inherit") return isAiGenerationConfigured();
  if (isStudentFeature(feature) && !(await getAiSettings()).askAiEnabled) return false;
  for (const p of routeChain(route)) if (await isGatewayProviderUsable(p)) return true;
  return false;
}

function isStudentFeature(f: AiFeature) {
  return f === "explanation" || f === "variant" || f === "explanation_admin" || f === "variant_admin";
}

/**
 * AI Engine switches checked before ANY provider call (OpenRouter or legacy):
 * the emergency stop and the per-feature on/off (Admin → AI → Budgets / Features).
 */
export async function assertEngineAllows(feature: AiFeature) {
  const engine = await getEngineConfig();
  if (engine.budgets.emergencyStop) throw new AiNotConfiguredError("AI generation is stopped by the AI emergency stop (Admin → AI → Budgets).");
  const fc = engine.features[feature];
  if (!fc.enabled) throw new AiNotConfiguredError(`${ENGINE_FEATURE_MAP[feature]?.label ?? FEATURE_LABELS[feature]} is turned off in AI → Features.`);
  return fc;
}

// ---- Logging ------------------------------------------------------------------------------

export type GatewayErrorCategory = string;

/** Best-effort category for a Gemini/OpenAI error (their own modules throw plain Errors). */
export function categorizeLegacyError(error: unknown): GatewayErrorCategory {
  if (error instanceof AiNotConfiguredError) return "not_configured";
  const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (m.includes("timed out") || m.includes("timeout")) return "timeout";
  if (m.includes("quota")) return "quota_exhausted";
  if (m.includes("rate")) return "rate_limited";
  if (m.includes("api key") || m.includes("unauthorized") || m.includes("401") || m.includes("permission")) return "auth_invalid";
  if (m.includes("not found") || m.includes("not supported") || m.includes("model")) return "model_unavailable";
  if (m.includes("could not reach") || m.includes("fetch failed")) return "network";
  if (m.includes("empty")) return "empty_response";
  if (m.includes("malformed") || m.includes("truncated")) return "malformed_response";
  return "provider_error";
}

const LEGACY_TRANSIENT = new Set(["timeout", "rate_limited", "network", "provider_error", "empty_response", "malformed_response"]);

async function logCall(entry: {
  feature: AiFeature;
  provider: string;
  model: string;
  ok: boolean;
  errorCategory?: string;
  errorSummary?: string;
  latencyMs: number;
  usage?: { inputTokens: number | null; outputTokens: number | null };
  attempt: number;
  actorId?: string | null;
  prices: Record<string, ModelPrice>;
  requestId?: string;
  quoteId?: string | null;
  instagramPostId?: string | null;
  /** "legacy" (direct route) or "gemini_fallback" (OpenRouter failed, Gemini asked). */
  routingMode?: string;
}) {
  try {
    await prisma.aiGatewayCall.create({
      data: {
        feature: entry.feature,
        provider: entry.provider,
        model: entry.model.slice(0, 80),
        ok: entry.ok,
        errorCategory: entry.errorCategory ?? null,
        errorSummary: entry.errorSummary ? sanitizeProviderMessage(entry.errorSummary) : null,
        latencyMs: entry.latencyMs,
        inputTokens: entry.usage?.inputTokens ?? null,
        outputTokens: entry.usage?.outputTokens ?? null,
        estCostUsd: entry.ok ? estimateCost(entry.prices, entry.model, entry.usage?.inputTokens ?? null, entry.usage?.outputTokens ?? null) : null,
        attempt: entry.attempt,
        actorId: entry.actorId ?? null,
        // Legacy providers report no billed cost: only the price-table estimate above (if any).
        kind: "text",
        routingMode: entry.routingMode ?? "legacy",
        costStatus: entry.ok ? "unknown" : null,
        requestId: entry.requestId ?? null,
        quoteId: entry.quoteId ?? null,
        instagramPostId: entry.instagramPostId ?? null,
      },
    });
  } catch (error) {
    // Logging must never break an AI feature.
    console.error("[ai-gateway] could not log call", error instanceof Error ? error.message : "unknown");
  }
}

async function assertUnderDailyCap(feature: AiFeature, route: FeatureRoute) {
  if (route.dailyCap === null) return;
  const used = await prisma.aiGatewayCall.count({ where: { feature, ok: true, createdAt: { gte: istStartOfDay(new Date()) } } });
  if (used >= route.dailyCap) {
    throw new AiNotConfiguredError(`The daily AI limit for ${FEATURE_LABELS[feature]} (${route.dailyCap}) has been reached. An admin can raise it in AI Solutions → AI Providers.`);
  }
}

// ---- Generation -------------------------------------------------------------------------

export interface GatewayContext {
  actorId?: string | null;
  /** Admin's per-request "use this provider" choice (Instagram Studio). Must be configured and enabled. */
  providerOverride?: GatewayProvider | null;
  /** One-time cost quote consumed by the admin action (AI Engine cost preview). */
  quoteId?: string | null;
  /** OpenRouter model the admin picked in that quote. */
  modelOverride?: string | null;
  /** Related Instagram post, for per-post cost tracking. */
  instagramPostId?: string | null;
}

async function callOne(
  p: GatewayProvider,
  route: FeatureRoute,
  prompt: string,
  opts: AiGenerationOptions
): Promise<AiGenerationResult> {
  if (p === "anthropic") {
    const claude = await resolveClaude();
    if (!claude) throw new AiNotConfiguredError("Claude is not configured or is disabled.");
    const model = route.models.anthropic || claude.model;
    const r = await callClaude({ apiKey: claude.apiKey, model, prompt, maxOutputTokens: opts.maxOutputTokens, timeoutMs: route.timeoutMs, effort: claude.effort });
    return { text: r.text, provider: "anthropic", model: r.model, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } };
  }
  return generateWithSingleProvider(p, prompt, opts, { model: route.models[p], timeoutMs: route.timeoutMs });
}

function errorInfo(p: GatewayProvider, error: unknown): { category: string; message: string; transient: boolean } {
  if (error instanceof ClaudeError) return { category: error.category, message: error.message, transient: TRANSIENT_CLAUDE_ERRORS.includes(error.category) };
  const category = categorizeLegacyError(error);
  const message = error instanceof Error ? error.message : `${PROVIDER_LABELS[p]} request failed.`;
  return { category, message, transient: LEGACY_TRANSIENT.has(category) };
}

/**
 * Generate text for one feature. Throws AiNotConfiguredError when no provider
 * can be used (not configured, disabled, paused, or over the daily cap) and the
 * last provider error when every configured provider failed.
 */
export async function generateForFeature(feature: AiFeature, prompt: string, opts: AiGenerationOptions, ctx: GatewayContext = {}): Promise<AiGenerationResult> {
  await assertAiGenerationOpen();
  const fc = await assertEngineAllows(feature);
  // Provider policy (lib/ai-engine/config.ts RuntimeConfig): direct Claude / OpenAI calls are refused; Claude and
  // OpenAI models run through OpenRouter. Gemini stays available (fallback, or an explicit admin choice).
  const runtime = (await getEngineConfig()).runtime;
  if (ctx.providerOverride && isDirectProviderBlocked(ctx.providerOverride, runtime)) {
    throw new AiNotConfiguredError(`Direct ${PROVIDER_LABELS[ctx.providerOverride]} calls are switched off: ${PROVIDER_LABELS[ctx.providerOverride]} models run through OpenRouter. Choose "Default (OpenRouter)" or Google Gemini.`);
  }
  // AI Engine: OpenRouter (priced, budgeted, logged with actual cost). An explicit Gemini choice wins.
  if (fc.provider === "openrouter" && !ctx.providerOverride) {
    if (isStudentFeature(feature) && !(await getAiSettings()).askAiEnabled) throw new AiNotConfiguredError("Ask AI is currently disabled by an admin.");
    // Gemini fallback keeps GEMINI_RESERVE_MS of the feature's deadline, so both fit under the page timeout.
    const profileMs = profileFor(feature).deadlineMs;
    const deadline = Date.now() + profileMs;
    const fallback = runtime.geminiFallback && (await isProviderUsable("gemini"));
    let error: unknown;
    try {
      return await generateTextViaOpenRouter(feature, prompt, opts, { actorId: ctx.actorId, quoteId: ctx.quoteId, modelOverride: ctx.modelOverride, instagramPostId: ctx.instagramPostId, ...(fallback ? { deadlineMs: profileMs - GEMINI_RESERVE_MS } : {}) });
    } catch (e) {
      error = e;
    }
    let geminiMessage: string | null = null;
    if (fallback && geminiMayRescue(error)) {
      const requestId = error instanceof AiEngineFailure && error.requestId ? error.requestId : crypto.randomUUID();
      try {
        return await geminiFallback(feature, prompt, opts, ctx, deadline, requestId);
      } catch (g) {
        geminiMessage = sanitizeProviderMessage(g instanceof Error ? g.message : "Gemini request failed.");
      }
    }
    // Students never see admin wording (budgets, model approval, provider errors); the details are in AI → History.
    if (ENGINE_FEATURE_MAP[feature]?.trigger === "student") {
      if (error instanceof AiNotConfiguredError && geminiMessage === null) throw new AiNotConfiguredError("AI explanations are temporarily unavailable. Please try again later.");
      throw new Error("The AI service could not answer right now. Please try again in a moment.");
    }
    const also = geminiMessage === null ? "" : ` Gemini fallback also failed: ${geminiMessage.slice(0, 200)}`;
    if (error instanceof AiEngineFailure) throw new AiProviderFailure(`${error.message}${also}`, error.category, error.requestId);
    if (also && error instanceof AiNotConfiguredError) throw new AiProviderFailure(`${error.message}${also}`);
    throw error;
  }
  const { routes, prices } = await getGatewayConfig();
  const route = routes[feature];
  await assertUnderDailyCap(feature, route);

  // Default: the unchanged production path.
  if (route.mode === "inherit" && !ctx.providerOverride) {
    const started = Date.now();
    try {
      // The old default path may pick OpenAI (AI Settings active / fallback provider): Gemini only while direct OpenAI is off.
      if (!runtime.directClaudeOpenAi && !(await getAiSettings()).askAiEnabled) throw new AiNotConfiguredError("Ask AI is currently disabled by an admin.");
      const r = runtime.directClaudeOpenAi ? await generateWithAi(prompt, opts) : await generateWithSingleProvider("gemini", prompt, opts);
      assertLegacyOutput(r, opts);
      await logCall({ feature, provider: r.provider, model: r.model, ok: true, latencyMs: Date.now() - started, usage: r.usage, attempt: 1, actorId: ctx.actorId, prices, quoteId: ctx.quoteId, instagramPostId: ctx.instagramPostId });
      return r;
    } catch (error) {
      if (!(error instanceof AiNotConfiguredError)) {
        await logCall({ feature, provider: "default", model: "-", ok: false, errorCategory: categorizeLegacyError(error), errorSummary: error instanceof Error ? error.message : "", latencyMs: Date.now() - started, attempt: 1, actorId: ctx.actorId, prices, quoteId: ctx.quoteId, instagramPostId: ctx.instagramPostId });
        // Student features keep their existing error handling unchanged; admin features get a readable message.
        if (!isStudentFeature(feature)) throw new AiProviderFailure(`AI request failed: ${sanitizeProviderMessage(error instanceof Error ? error.message : "unknown error")}`);
      }
      throw error;
    }
  }

  if (isStudentFeature(feature) && !(await getAiSettings()).askAiEnabled) {
    throw new AiNotConfiguredError("Ask AI is currently disabled by an admin.");
  }

  let chain: GatewayProvider[];
  if (ctx.providerOverride) {
    if (!(await isGatewayProviderUsable(ctx.providerOverride))) {
      throw new AiNotConfiguredError(`${PROVIDER_LABELS[ctx.providerOverride]} is not configured or is disabled (AI Solutions → AI Providers).`);
    }
    const rest = route.mode === "custom" ? routeChain(route) : [];
    chain = [ctx.providerOverride, ...rest.filter((p) => p !== ctx.providerOverride)];
  } else chain = routeChain(route);
  chain = chain.filter((p) => !isDirectProviderBlocked(p, runtime));
  if (chain.length === 0) {
    throw new AiNotConfiguredError(`${FEATURE_LABELS[feature]} is routed only to direct Claude / OpenAI, which are switched off. Set it to OpenRouter in AI → Features (Claude and OpenAI models run through OpenRouter).`);
  }

  const usable: GatewayProvider[] = [];
  for (const p of chain) if (await isGatewayProviderUsable(p)) usable.push(p);
  if (usable.length === 0) {
    throw new AiNotConfiguredError(`No AI provider is configured for ${FEATURE_LABELS[feature]}. Configure ${chain.map((p) => PROVIDER_LABELS[p]).join(" / ")} in AI Solutions → AI Providers.`);
  }

  let last: unknown = null;
  for (const p of usable) {
    for (let attempt = 1; attempt <= 1 + route.maxRetries; attempt++) {
      const started = Date.now();
      try {
        const r = await callOne(p, route, prompt, opts);
        assertLegacyOutput(r, opts);
        await logCall({ feature, provider: p, model: r.model, ok: true, latencyMs: Date.now() - started, usage: r.usage, attempt, actorId: ctx.actorId, prices, quoteId: ctx.quoteId, instagramPostId: ctx.instagramPostId });
        if (p === "anthropic") await recordClaudeOutcome({ ok: true });
        return r;
      } catch (error) {
        last = error;
        const info = errorInfo(p, error);
        await logCall({ feature, provider: p, model: p === "anthropic" ? route.models.anthropic || "claude" : route.models[p] || p, ok: false, errorCategory: info.category, errorSummary: info.message, latencyMs: Date.now() - started, attempt, actorId: ctx.actorId, prices, quoteId: ctx.quoteId, instagramPostId: ctx.instagramPostId });
        if (p === "anthropic") await recordClaudeOutcome({ ok: false, category: info.category, message: sanitizeProviderMessage(info.message) });
        if (!info.transient) break; // move to the next provider
      }
    }
  }
  const lastProvider = usable[usable.length - 1];
  const message = last instanceof Error ? last.message : "AI request failed.";
  throw new AiProviderFailure(`${PROVIDER_LABELS[lastProvider]} failed${usable.length > 1 ? " (after trying every configured provider)" : ""}: ${sanitizeProviderMessage(message)}`);
}

/** Time kept for the Gemini fallback out of the feature's deadline (OpenRouter gets the rest). */
export const GEMINI_RESERVE_MS = 20_000;

/**
 * OpenRouter failures Gemini may fix: every engine failure (provider errors, timeouts, unusable answers, credits,
 * auth) and "not configured" (no key, no eligible model). Never a budget refusal — that is the owner's limit.
 */
function geminiMayRescue(error: unknown): boolean {
  if (error instanceof AiBudgetError) return false;
  return error instanceof AiEngineFailure || error instanceof AiNotConfiguredError;
}

/** One Gemini request after OpenRouter failed: same output check, logged under the OpenRouter request id. */
async function geminiFallback(feature: AiFeature, prompt: string, opts: AiGenerationOptions, ctx: GatewayContext, deadline: number, requestId: string): Promise<AiGenerationResult> {
  const { prices } = await getGatewayConfig();
  const started = Date.now();
  try {
    const r = await generateWithSingleProvider("gemini", prompt, opts, { deadlineAt: deadline });
    assertLegacyOutput(r, opts);
    await logCall({ feature, provider: "gemini", model: r.model, ok: true, latencyMs: Date.now() - started, usage: r.usage, attempt: 1, actorId: ctx.actorId, prices, requestId, quoteId: ctx.quoteId, instagramPostId: ctx.instagramPostId, routingMode: "gemini_fallback" });
    return { ...r, requestId, fallbackUsed: true };
  } catch (error) {
    await logCall({ feature, provider: "gemini", model: "gemini", ok: false, errorCategory: categorizeLegacyError(error), errorSummary: error instanceof Error ? error.message : "", latencyMs: Date.now() - started, attempt: 1, actorId: ctx.actorId, prices, requestId, quoteId: ctx.quoteId, instagramPostId: ctx.instagramPostId, routingMode: "gemini_fallback" });
    throw error;
  }
}

/** Legacy providers get the same output check as the AI Engine; an unusable answer is an error, never a result. */
function assertLegacyOutput(r: AiGenerationResult, opts: AiGenerationOptions) {
  const bad = checkOutput(r.text, null, false, opts);
  if (bad) throw new Error(`${bad.category === "truncated" ? "truncated" : "malformed"} response: ${bad.message}`);
}

// ---- Usage summary (admin) ------------------------------------------------------------------

export interface ProviderUsage {
  provider: string;
  calls: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  unpricedCalls: number;
}

export async function usageSince(since: Date): Promise<{ byProvider: ProviderUsage[]; byFeature: { feature: string; calls: number; ok: number; estCostUsd: number }[]; recentErrors: { at: string; feature: string; provider: string; category: string | null; summary: string | null }[] }> {
  const [grouped, featureGroups, errors, unpriced] = await Promise.all([
    prisma.aiGatewayCall.groupBy({ by: ["provider", "ok"], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, estCostUsd: true } }),
    prisma.aiGatewayCall.groupBy({ by: ["feature", "ok"], where: { createdAt: { gte: since } }, _count: { _all: true }, _sum: { estCostUsd: true } }),
    prisma.aiGatewayCall.findMany({ where: { ok: false, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 15, select: { createdAt: true, feature: true, provider: true, errorCategory: true, errorSummary: true } }),
    prisma.aiGatewayCall.groupBy({ by: ["provider"], where: { createdAt: { gte: since }, ok: true, estCostUsd: null }, _count: { _all: true } }),
  ]);
  const byProvider = new Map<string, ProviderUsage>();
  for (const g of grouped) {
    const u = byProvider.get(g.provider) ?? { provider: g.provider, calls: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0, unpricedCalls: 0 };
    u.calls += g._count._all;
    if (g.ok) u.ok += g._count._all;
    else u.failed += g._count._all;
    u.inputTokens += g._sum.inputTokens ?? 0;
    u.outputTokens += g._sum.outputTokens ?? 0;
    u.estCostUsd += g._sum.estCostUsd ?? 0;
    byProvider.set(g.provider, u);
  }
  for (const u of unpriced) {
    const row = byProvider.get(u.provider);
    if (row) row.unpricedCalls = u._count._all;
  }
  const byFeature = new Map<string, { feature: string; calls: number; ok: number; estCostUsd: number }>();
  for (const g of featureGroups) {
    const f = byFeature.get(g.feature) ?? { feature: g.feature, calls: 0, ok: 0, estCostUsd: 0 };
    f.calls += g._count._all;
    if (g.ok) f.ok += g._count._all;
    f.estCostUsd += g._sum.estCostUsd ?? 0;
    byFeature.set(g.feature, f);
  }
  return {
    byProvider: [...byProvider.values()],
    byFeature: [...byFeature.values()],
    recentErrors: errors.map((e) => ({ at: e.createdAt.toISOString(), feature: e.feature, provider: e.provider, category: e.errorCategory, summary: e.errorSummary })),
  };
}
