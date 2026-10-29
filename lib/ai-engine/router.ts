import "server-only";
import type { AiModel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import type { AiFeature } from "@/lib/ai-gateway-config";
import { toPriced } from "@/lib/ai-engine/catalog";
import { ENGINE_FEATURE_MAP, imageMaxUsd, textCallMaxUsd, textCallTypicalUsd, type FeatureEngineConfig, type PricedModel, type RoutingMode } from "@/lib/ai-engine/config";
import { isFreeModel, nonGenerativeReason, profileFor } from "@/lib/ai-engine/profiles";

/**
 * Model selection for the AI Engine.
 *
 *  - Cheapest Approved (default): the lowest-estimated-cost model from the
 *    ADMIN-APPROVED catalog that can do the task — text output, enough context
 *    for prompt + output, a published price, medically approved for medical
 *    features, not disabled / delisted / expired, and not failing right now.
 *    This is cheapest-MODEL selection across models; within the chosen model
 *    OpenRouter's `provider.sort = "price"` picks the cheapest provider.
 *  - Manual: exactly the admin's model (must pass the same checks).
 *  - OpenRouter Auto: `openrouter/auto` restricted to the same approved list
 *    (`allowed_models`), with the cost ceiling of the most expensive allowed
 *    model, since Auto itself has no fixed price.
 *  - Task-aware (recommended): the same eligible list ranked for the feature's
 *    task profile (lib/ai-engine/profiles.ts) — verified registry models in
 *    their order first, then the rest by recent health, then price; free routes
 *    only when nothing else is approved.
 *
 * Every mode first drops models that cannot answer the task at all (safety
 * classifiers, batch-only ids, music/audio models, meta-routers), models
 * without the input modality the task needs, and models in a short cooldown
 * after repeated failures (circuit breaker).
 */

/**
 * Recent failure rate check: ≥ 5 calls in the last 24 h and under 50 % success → skipped.
 * AI Question Importer calls (qimport_*) are not counted: they run under the importer's own privacy
 * and price constraints, so their failures must not move other AI features off a model.
 */
async function unhealthyModels(): Promise<Set<string>> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await prisma.aiGatewayCall.groupBy({ by: ["model", "ok"], where: { provider: "openrouter", createdAt: { gte: since }, NOT: { feature: { startsWith: "qimport_" } } }, _count: { _all: true } });
  const stats = new Map<string, { ok: number; all: number }>();
  for (const r of rows) {
    const s = stats.get(r.model) ?? { ok: 0, all: 0 };
    s.all += r._count._all;
    if (r.ok) s.ok += r._count._all;
    stats.set(r.model, s);
  }
  const out = new Set([...stats].filter(([, s]) => s.all >= 5 && s.ok / s.all < 0.5).map(([m]) => m));
  for (const m of await coolingDownModels()) out.add(m);
  return out;
}

/** Circuit breaker: a model whose last COOLDOWN_FAILS calls (within COOLDOWN_MS) all failed rests until COOLDOWN_MS after the last failure. */
export const COOLDOWN_FAILS = 3;
export const COOLDOWN_MS = 10 * 60_000;

async function coolingDownModels(): Promise<string[]> {
  const recent = await prisma.aiGatewayCall.findMany({
    where: { provider: "openrouter", createdAt: { gte: new Date(Date.now() - COOLDOWN_MS) }, NOT: { feature: { startsWith: "qimport_" } } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { model: true, ok: true, errorCategory: true },
  });
  const byModel = new Map<string, { ok: boolean; errorCategory: string | null }[]>();
  for (const r of recent) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  // Only the model's own failures count (not a missing key, credits or a bad request, which no other model fixes).
  const own = (c: string | null) => !["auth_invalid", "insufficient_credits", "bad_request", "moderation"].includes(c ?? "");
  return [...byModel].filter(([, rows]) => rows.length >= COOLDOWN_FAILS && rows.slice(0, COOLDOWN_FAILS).every((r) => !r.ok && own(r.errorCategory))).map(([m]) => m);
}

/** Successful-call share and average latency per model over the last 24 h (Task-aware ranking). */
async function modelHealth(): Promise<Map<string, { okRate: number; avgMs: number; n: number }>> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const rows = await prisma.aiGatewayCall.groupBy({ by: ["model", "ok"], where: { provider: "openrouter", createdAt: { gte: since } }, _count: { _all: true }, _avg: { latencyMs: true } });
  const acc = new Map<string, { ok: number; n: number; ms: number }>();
  for (const r of rows) {
    const a = acc.get(r.model) ?? { ok: 0, n: 0, ms: 0 };
    a.n += r._count._all;
    if (r.ok) {
      a.ok += r._count._all;
      a.ms += (r._avg.latencyMs ?? 0) * r._count._all;
    }
    acc.set(r.model, a);
  }
  return new Map([...acc].map(([m, a]) => [m, { okRate: a.n ? a.ok / a.n : 1, avgMs: a.ok ? a.ms / a.ok : 0, n: a.n }]));
}

export interface Eligibility {
  ok: boolean;
  reason: string | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function textEligibility(m: AiModel, feature: AiFeature, tokensNeeded: number, maxOut: number, opts: { ignoreMedical?: boolean } = {}): Eligibility {
  const def = ENGINE_FEATURE_MAP[feature];
  if (!m.approved) return { ok: false, reason: "not approved" };
  if (m.disabled) return { ok: false, reason: "disabled" };
  if (m.missingSince) return { ok: false, reason: "no longer listed by OpenRouter" };
  if (m.expirationDate && m.expirationDate <= today()) return { ok: false, reason: `expired ${m.expirationDate}` };
  if (!m.outputModalities.includes("text") || (m.inputModalities.length && !m.inputModalities.includes("text"))) return { ok: false, reason: "not a text model" };
  const unfit = nonGenerativeReason(m.id, m.outputModalities);
  if (unfit) return { ok: false, reason: unfit };
  const needs = profileFor(feature).inputModalities.filter((x) => !m.inputModalities.includes(x));
  if (m.inputModalities.length && needs.length) return { ok: false, reason: `cannot read ${needs.join(", ")} input` };
  if (m.promptPrice === null || m.completionPrice === null) return { ok: false, reason: "no published price" };
  if (def?.medical && !m.medicallyApproved && !opts.ignoreMedical) return { ok: false, reason: "not medically approved" };
  if (m.contextLength !== null && m.contextLength < tokensNeeded + maxOut) return { ok: false, reason: "context too small" };
  if (m.maxCompletionTokens !== null && m.maxCompletionTokens < Math.min(maxOut, 1000)) return { ok: false, reason: "output limit too small" };
  return { ok: true, reason: null };
}

export function imageEligibility(m: AiModel, feature: AiFeature): Eligibility {
  const def = ENGINE_FEATURE_MAP[feature];
  if (!m.approved) return { ok: false, reason: "not approved" };
  if (m.disabled) return { ok: false, reason: "disabled" };
  if (m.missingSince) return { ok: false, reason: "no longer listed by OpenRouter" };
  if (!m.isImageModel) return { ok: false, reason: "not an image model" };
  if (m.id.toLowerCase().endsWith(":batch")) return { ok: false, reason: "a batch-only id (not served by the Images API)" };
  if (def?.medical && !m.medicallyApproved) return { ok: false, reason: "not medically approved" };
  if (imageMaxUsd(toPriced(m), IMAGE_MEGAPIXELS) === null) return { ok: false, reason: "image price cannot be estimated (set units per image)" };
  return { ok: true, reason: null };
}

/** Medical image slide: 4:3 at the "1K" tier (1024 × 768 ≈ 0.79 MP). */
export const IMAGE_ASPECT = "4:3";
export const IMAGE_RESOLUTION = "1K";
export const IMAGE_MEGAPIXELS = (1024 * 768) / 1_000_000;

export interface TextPlan {
  mode: RoutingMode;
  /** Ordered: preferred model first, then fallbacks (sent as OpenRouter `models`). Empty for Auto. */
  models: PricedModel[];
  /** Auto mode: approved ids passed as `allowed_models`. */
  autoAllowed: string[] | null;
  /** Worst-case USD for one call over every model that may answer. */
  maxUsd: number;
  /** Ceiling sent as provider.max_price (USD per MILLION tokens). */
  maxPricePerM: { prompt: number; completion: number };
  /** Typical USD for one call on the preferred model (Auto: the cheapest allowed). */
  typicalUsd: number;
  /** OpenRouter `supported_parameters` per planned model (JSON mode / reasoning bound are sent only where accepted). */
  supported: Record<string, string[]>;
}

export interface CandidateView {
  id: string;
  typicalUsd: number;
  maxUsd: number;
  medical: boolean;
}

/** Every eligible text model for this feature, cheapest (typical) first — or, with `mode: "task"`, in Task-aware order. */
export async function textCandidates(feature: AiFeature, inputTokens: number, maxOut: number, typicalOut: number, opts: { ignoreMedical?: boolean; mode?: RoutingMode } = {}): Promise<{ model: AiModel; typicalUsd: number; maxUsd: number }[]> {
  const [models, unhealthy, health] = await Promise.all([prisma.aiModel.findMany({ where: { approved: true, disabled: false, missingSince: null } }), unhealthyModels(), modelHealth()]);
  const cands = models
    .filter((m) => textEligibility(m, feature, inputTokens, maxOut, opts).ok && !unhealthy.has(m.id))
    .map((m) => ({ model: m, typicalUsd: textCallTypicalUsd(toPriced(m), inputTokens, typicalOut)!, maxUsd: textCallMaxUsd(toPriced(m), inputTokens, maxOut)! }))
    // Equal prices (e.g. several free routes) are broken by recent health, not by name (2026-10: the failing
    // liquid/lfm-2.5-2.6b:free won every tie alphabetically and answered 20 of 23 requests with nothing).
    .sort((a, b) => a.typicalUsd - b.typicalUsd || a.maxUsd - b.maxUsd || healthRank(health, a.model.id) - healthRank(health, b.model.id) || a.model.id.localeCompare(b.model.id));
  return opts.mode === "task" ? rankForTask(feature, cands, health) : cands;
}

/** 0 = healthy, 1 = unknown (fewer than 3 calls in 24 h), 2 = under 80 % success or slower than 45 s on average. */
export function healthRank(health: Map<string, { okRate: number; avgMs: number; n: number }>, id: string): number {
  const h = health.get(id);
  if (!h || h.n < 3) return 1;
  return h.okRate < 0.8 || h.avgMs > 45_000 ? 2 : 0;
}

/**
 * Task-aware order (pure; exported for the test suite):
 *  1. verified registry models of the feature's profile, in registry order;
 *  2. other paid models, healthiest first (success rate, then latency), then cheapest;
 *  3. free routes last, and only when the profile allows them as a last resort.
 */
export function rankForTask<T extends { model: { id: string }; typicalUsd: number }>(feature: AiFeature, cands: T[], health: Map<string, { okRate: number; avgMs: number; n: number }>): T[] {
  const profile = profileFor(feature);
  const reg = (id: string) => {
    const i = profile.preferred.indexOf(id);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const healthKey = (id: string) => healthRank(health, id);
  const paid = cands.filter((c) => !isFreeModel(c.model.id));
  const free = cands.filter((c) => isFreeModel(c.model.id));
  paid.sort((a, b) => reg(a.model.id) - reg(b.model.id) || healthKey(a.model.id) - healthKey(b.model.id) || a.typicalUsd - b.typicalUsd || a.model.id.localeCompare(b.model.id));
  free.sort((a, b) => healthKey(a.model.id) - healthKey(b.model.id) || a.model.id.localeCompare(b.model.id));
  return paid.length || !profile.freeLastResort ? paid : free;
}

const noModel = (feature: AiFeature, why: string) => new AiNotConfiguredError(`No usable OpenRouter model for ${ENGINE_FEATURE_MAP[feature]?.label ?? feature}: ${why} Approve a suitable model in AI → Models.`);

export async function planText(input: {
  feature: AiFeature;
  cfg: FeatureEngineConfig;
  inputTokens: number;
  maxOut: number;
  typicalOut: number;
  /** A one-time quote's model (admin picked it in the cost preview). */
  override?: string | null;
  /** Per-request USD ceiling — fallbacks above it are dropped. */
  capUsd: number;
  /** Model quality evaluation: the model under test only (no fallbacks), before it is medically approved. */
  evaluation?: boolean;
}): Promise<TextPlan> {
  const { feature, cfg, inputTokens, maxOut, typicalOut, capUsd } = input;
  const mode: RoutingMode = input.override ? "manual" : cfg.mode;
  const cands = await textCandidates(feature, inputTokens, maxOut, typicalOut, { ignoreMedical: input.evaluation, mode });
  if (cands.length === 0) throw noModel(feature, "no approved model passes the checks.");
  const byId = new Map(cands.map((c) => [c.model.id, c]));

  if (mode === "auto") {
    const allowed = cands.filter((c) => c.maxUsd <= capUsd);
    if (allowed.length === 0) throw noModel(feature, "every approved model is above the per-request cost limit.");
    const worst = allowed.reduce((a, c) => (c.maxUsd > a.maxUsd ? c : a));
    return {
      mode,
      models: [],
      autoAllowed: allowed.map((c) => c.model.id),
      maxUsd: worst.maxUsd,
      maxPricePerM: {
        prompt: Math.max(...allowed.map((c) => c.model.promptPrice ?? 0)) * 1_000_000,
        completion: Math.max(...allowed.map((c) => Math.max(c.model.completionPrice ?? 0, c.model.reasoningPrice ?? 0))) * 1_000_000,
      },
      typicalUsd: allowed[0].typicalUsd,
      supported: {},
    };
  }

  let primary: (typeof cands)[number] | undefined;
  if (mode === "manual") {
    const id = input.override ?? cfg.model;
    if (!id) throw noModel(feature, "Manual routing is selected but no model is chosen.");
    primary = byId.get(id);
    if (!primary) {
      const row = await prisma.aiModel.findUnique({ where: { id } });
      const why = row ? textEligibility(row, feature, inputTokens, maxOut).reason ?? "currently failing (recent error rate)" : "not in the catalog";
      throw noModel(feature, `the selected model "${id}" is ${why}.`);
    }
  } else if (mode === "task") {
    // Task-aware: the best-ranked model that fits the per-request ceiling (a quality model above it yields to the next).
    primary = cands.find((c) => c.maxUsd <= capUsd) ?? cands[0];
  } else primary = cands[0];
  if (primary.maxUsd > capUsd) {
    throw new AiNotConfiguredError(`The selected model (${primary.model.id}) could cost up to $${primary.maxUsd.toFixed(4)} for this request, above the per-request limit. Lower the output tokens, choose a cheaper model or raise the limit in AI → Budgets.`);
  }
  // Cheapest routing keeps the next-cheapest approved models as fallbacks, also when a quote pinned the first choice.
  // Task-aware routing does the same in its own order. Fallbacks are always eligible for the task (filtered above).
  const fallbackIds = input.evaluation ? [] : cfg.fallbacks.length ? cfg.fallbacks : cfg.mode === "cheapest" || cfg.mode === "task" ? cands.filter((c) => c.model.id !== primary!.model.id).slice(0, 2).map((c) => c.model.id) : [];
  const fallbacks = fallbackIds
    .filter((id) => id !== primary!.model.id)
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c) && c!.maxUsd <= capUsd)
    .slice(0, 3);
  const chain = [primary, ...fallbacks];
  return {
    mode,
    models: chain.map((c) => toPriced(c.model)),
    autoAllowed: null,
    maxUsd: Math.max(...chain.map((c) => c.maxUsd)),
    maxPricePerM: {
      prompt: Math.max(...chain.map((c) => c.model.promptPrice ?? 0)) * 1_000_000,
      completion: Math.max(...chain.map((c) => Math.max(c.model.completionPrice ?? 0, c.model.reasoningPrice ?? 0))) * 1_000_000,
    },
    typicalUsd: primary.typicalUsd,
    supported: Object.fromEntries(chain.map((c) => [c.model.id, c.model.supportedParameters ?? []])),
  };
}

export interface ImagePlan {
  model: PricedModel;
  maxUsd: number;
}

export async function imageCandidates(feature: AiFeature): Promise<{ model: AiModel; maxUsd: number }[]> {
  const models = await prisma.aiModel.findMany({ where: { approved: true, disabled: false, missingSince: null, isImageModel: true } });
  return models
    .filter((m) => imageEligibility(m, feature).ok)
    .map((m) => ({ model: m, maxUsd: imageMaxUsd(toPriced(m), IMAGE_MEGAPIXELS)! }))
    .sort((a, b) => a.maxUsd - b.maxUsd || a.model.id.localeCompare(b.model.id));
}

export async function planImage(input: { feature: AiFeature; cfg: FeatureEngineConfig; override?: string | null; capUsd: number }): Promise<ImagePlan> {
  const cands = await imageCandidates(input.feature);
  if (cands.length === 0) throw noModel(input.feature, "no approved image model with an estimable price.");
  const id = input.override ?? (input.cfg.mode === "manual" ? input.cfg.model : null);
  const pick = id ? cands.find((c) => c.model.id === id) : cands[0];
  if (!pick) throw noModel(input.feature, `the selected image model "${id}" is not approved, not an image model, or its price cannot be estimated.`);
  if (pick.maxUsd > input.capUsd) throw new AiNotConfiguredError(`The image model ${pick.model.id} costs up to $${pick.maxUsd.toFixed(4)} per image, above the per-request image limit (AI → Budgets).`);
  return { model: toPriced(pick.model), maxUsd: pick.maxUsd };
}
