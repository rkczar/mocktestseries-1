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
import {
  AI_FEATURE_KEYS,
  DEFAULT_PRICES,
  DEFAULT_ROUTE,
  FEATURE_LABELS,
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
export class AiProviderFailure extends Error {}

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
  const routes = Object.fromEntries(AI_FEATURE_KEYS.map((f) => [f, raw.routes?.[f] ? normalizeRoute(raw.routes[f]) : { ...DEFAULT_ROUTE }])) as Record<AiFeature, FeatureRoute>;
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

export async function isGatewayProviderUsable(p: GatewayProvider): Promise<boolean> {
  if (p === "anthropic") return (await resolveClaude()) !== null;
  return isProviderUsable(p);
}

/** True when the feature has at least one usable provider (replaces isAiGenerationConfigured for routed features). */
export async function isFeatureConfigured(feature: AiFeature): Promise<boolean> {
  const { routes } = await getGatewayConfig();
  const route = routes[feature];
  if (route.mode === "inherit") return isAiGenerationConfigured();
  if (isStudentFeature(feature) && !(await getAiSettings()).askAiEnabled) return false;
  for (const p of routeChain(route)) if (await isGatewayProviderUsable(p)) return true;
  return false;
}

function isStudentFeature(f: AiFeature) {
  return f === "explanation" || f === "variant";
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
  const { routes, prices } = await getGatewayConfig();
  const route = routes[feature];
  await assertUnderDailyCap(feature, route);

  // Default: the unchanged production path.
  if (route.mode === "inherit" && !ctx.providerOverride) {
    const started = Date.now();
    try {
      const r = await generateWithAi(prompt, opts);
      await logCall({ feature, provider: r.provider, model: r.model, ok: true, latencyMs: Date.now() - started, usage: r.usage, attempt: 1, actorId: ctx.actorId, prices });
      return r;
    } catch (error) {
      if (!(error instanceof AiNotConfiguredError)) {
        await logCall({ feature, provider: "default", model: "-", ok: false, errorCategory: categorizeLegacyError(error), errorSummary: error instanceof Error ? error.message : "", latencyMs: Date.now() - started, attempt: 1, actorId: ctx.actorId, prices });
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
        await logCall({ feature, provider: p, model: r.model, ok: true, latencyMs: Date.now() - started, usage: r.usage, attempt, actorId: ctx.actorId, prices });
        if (p === "anthropic") await recordClaudeOutcome({ ok: true });
        return r;
      } catch (error) {
        last = error;
        const info = errorInfo(p, error);
        await logCall({ feature, provider: p, model: p === "anthropic" ? route.models.anthropic || "claude" : route.models[p] || p, ok: false, errorCategory: info.category, errorSummary: info.message, latencyMs: Date.now() - started, attempt, actorId: ctx.actorId, prices });
        if (p === "anthropic") await recordClaudeOutcome({ ok: false, category: info.category, message: sanitizeProviderMessage(info.message) });
        if (!info.transient) break; // move to the next provider
      }
    }
  }
  const lastProvider = usable[usable.length - 1];
  const message = last instanceof Error ? last.message : "AI request failed.";
  throw new AiProviderFailure(`${PROVIDER_LABELS[lastProvider]} failed${usable.length > 1 ? " (after trying every configured provider)" : ""}: ${sanitizeProviderMessage(message)}`);
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
