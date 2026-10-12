import "server-only";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import type { AiFeature } from "@/lib/ai-gateway-config";
import { ENGINE_FEATURE_MAP, usdToInr, type EngineFeatureDef } from "@/lib/ai-engine/config";
import { getEngineConfig, resolveOpenRouterKey } from "@/lib/ai-engine/settings";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { budgetUsage } from "@/lib/ai-engine/budget";
import { imageCandidates, textCandidates } from "@/lib/ai-engine/router";

/**
 * One-time cost quotes for admin-triggered paid AI actions (the "AI Cost
 * Preview" dialog). The quote is computed on the server from the current
 * catalog prices, routing, budgets and USD→INR rate; the action then consumes
 * it atomically (OPEN → USED, same admin, same feature/action/context, not
 * expired). A double click or a replayed request finds the quote USED and
 * starts nothing. At execution the engine re-plans and re-checks price and
 * budget again — the quote's figures are an estimate, never a guarantee.
 */

export const QUOTE_TTL_MS = 10 * 60_000;

export class QuoteError extends AiNotConfiguredError {}

export interface QuoteAlternative {
  model: string;
  typicalInr: number | null;
  maxInr: number | null;
  current: boolean;
}

export interface QuoteView {
  id: string;
  feature: AiFeature;
  featureLabel: string;
  action: string;
  provider: "openrouter" | "legacy";
  routingMode: string;
  model: string;
  estInputTokens: number;
  estOutputTokens: number;
  maxOutputTokens: number;
  calls: number;
  /** INR — typical text cost for the whole action (all calls). */
  textInr: number | null;
  /** INR — worst case for the whole action (every output token used). */
  textMaxInr: number | null;
  imageInr: number | null;
  totalInr: number | null;
  totalMaxInr: number | null;
  /** Per-request limit the engine enforces. */
  capInr: number;
  fxRate: number | null;
  fxSource: string | null;
  fxAt: string | null;
  fxStale: boolean;
  budgetDayLeftInr: number;
  budgetMonthLeftInr: number;
  alternatives: QuoteAlternative[];
  /** Plain-language caveats shown in the dialog. */
  notes: string[];
  /** false when the action must not run (no model / over a limit) — the dialog then only offers Cancel / Change Model. */
  runnable: boolean;
  blockReason: string | null;
  expiresAt: string;
}

async function historicalTokens(feature: AiFeature, def: EngineFeatureDef): Promise<{ input: number; output: number | null }> {
  const agg = await prisma.aiGatewayCall.aggregate({
    where: { feature, ok: true, inputTokens: { not: null }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    _avg: { inputTokens: true, outputTokens: true },
    _count: { _all: true },
  });
  if (agg._count._all < 3) return { input: def.typicalInputTokens, output: null };
  return { input: Math.round(agg._avg.inputTokens ?? def.typicalInputTokens), output: agg._avg.outputTokens === null ? null : Math.round(agg._avg.outputTokens) };
}

export interface QuoteRequest {
  feature: AiFeature;
  action: string;
  /** Must match exactly when the quote is consumed (e.g. { postId }). */
  context: Record<string, string | number | null>;
  actorId: string;
  model?: string | null;
  /** "cheapest" = re-pick the cheapest approved model (the dialog's Choose Cheapest button). */
  pick?: "cheapest" | null;
  /** Number of items (bulk: N variants etc.); default 1. */
  units?: number;
  /** The admin chose a legacy provider for this request — the engine is bypassed. */
  legacyProvider?: boolean;
  /** Model quality evaluation run: blind solve of `units` questions on one approved (not yet medical) model. */
  evaluation?: boolean;
}

/** The quote's figures + the row to store, without writing anything (bulk previews reuse one estimate). */
async function estimateQuote(req: QuoteRequest): Promise<{ view: Omit<QuoteView, "id" | "expiresAt">; row: Omit<Prisma.AiCostQuoteCreateManyInput, "expiresAt" | "context" | "actorId"> }> {
  const baseDef = ENGINE_FEATURE_MAP[req.feature];
  if (!baseDef || baseDef.trigger !== "admin") throw new QuoteError("This AI action has no cost preview.");
  // Evaluation: one short blind-solve call per question (lib/ai-engine/eval.ts).
  const def: EngineFeatureDef = req.evaluation ? { ...baseDef, label: "Medical model evaluation", callsPerAction: 1, defaultMaxOutputTokens: 300, typicalInputTokens: 250 } : baseDef;
  const [engine, fx, usage, configured] = await Promise.all([getEngineConfig(), getUsdInr(), budgetUsage(), resolveOpenRouterKey()]);
  const cfg = { ...engine.features[req.feature] };
  if (req.legacyProvider) cfg.provider = "legacy";
  if (req.evaluation) Object.assign(cfg, { provider: "openrouter", mode: "manual", maxOutputTokens: null, enabled: true });
  const units = Math.max(1, Math.min(100, Math.round(req.units ?? 1)));
  const notes: string[] = [];
  let runnable = true;
  let blockReason: string | null = null;
  if (engine.budgets.emergencyStop) {
    runnable = false;
    blockReason = "AI generation is stopped by the AI emergency stop (AI → Budgets).";
  }
  if (!cfg.enabled) {
    runnable = false;
    blockReason = `${def.label} is turned off in AI → Features.`;
  }

  const capInr = cfg.maxCostInr ?? (def.kind === "image" ? engine.budgets.maxImageRequestInr : engine.budgets.maxTextRequestInr);
  const hist = req.evaluation ? { input: 250, output: 120 } : await historicalTokens(req.feature, def);
  const maxOut = (cfg.maxOutputTokens ?? def.defaultMaxOutputTokens) * def.callsPerAction;
  const estIn = hist.input * def.callsPerAction * units;
  const estOut = Math.min(maxOut, hist.output !== null ? hist.output * def.callsPerAction : Math.round(maxOut * 0.5)) * units;
  const base = {
    feature: req.feature,
    featureLabel: def.label,
    action: req.action,
    estInputTokens: def.kind === "image" ? 0 : estIn,
    estOutputTokens: def.kind === "image" ? 0 : estOut,
    maxOutputTokens: def.kind === "image" ? 0 : maxOut * units,
    calls: def.callsPerAction * units,
    capInr,
    fxRate: fx.rate,
    fxSource: fx.source,
    fxAt: fx.at?.toISOString() ?? null,
    fxStale: fx.stale,
    budgetDayLeftInr: Math.max(0, engine.budgets.dailyInr - usage.dayInr),
    budgetMonthLeftInr: Math.max(0, engine.budgets.monthlyInr - usage.monthInr),
  };

  let provider: "openrouter" | "legacy" = cfg.provider;
  let model = "";
  let textInr: number | null = null;
  let textMaxInr: number | null = null;
  let imageInr: number | null = null;
  let alternatives: QuoteAlternative[] = [];

  if (cfg.provider === "legacy") {
    model = "Existing provider route (Gemini / OpenAI / Claude)";
    notes.push("This feature still uses the existing (legacy) provider route. Its cost is not reported by that provider, so no INR estimate can be shown. Switch it to OpenRouter in AI → Features for cost tracking.");
  } else if (!configured) {
    runnable = false;
    blockReason = "OpenRouter is not configured or is disabled (AI → Providers).";
    model = "—";
  } else if (fx.rate === null) {
    runnable = false;
    blockReason = fx.unavailableReason ?? "No USD→INR rate.";
    model = "—";
  } else if (def.kind === "image") {
    const cands = await imageCandidates(req.feature);
    const want = req.pick === "cheapest" ? null : (req.model ?? (cfg.mode === "manual" ? cfg.model : null));
    const pick = want ? cands.find((c) => c.model.id === want) : cands[0];
    alternatives = cands.slice(0, 8).map((c) => ({ model: c.model.id, typicalInr: usdToInr(c.maxUsd * units, fx.rate), maxInr: usdToInr(c.maxUsd * units, fx.rate), current: c.model.id === pick?.model.id }));
    if (!pick) {
      runnable = false;
      blockReason = want ? `Model "${want}" is not an approved image model with an estimable price.` : "No approved image model with an estimable price (AI → Models).";
      model = want ?? "—";
    } else {
      model = pick.model.id;
      imageInr = usdToInr(pick.maxUsd * units, fx.rate);
      if (pick.model.imageUnit !== "image") notes.push(`This model is priced per ${pick.model.imageUnit}; the image cost is an upper-bound estimate for a ${"1K"} 4:3 image.`);
      if (pick.maxUsd * fx.rate > capInr) {
        runnable = false;
        blockReason = `The image may cost up to ₹${(pick.maxUsd * fx.rate).toFixed(2)}, above the per-request image limit ₹${capInr.toFixed(2)}.`;
      }
    }
  } else {
    const perCallIn = Math.round(estIn / (def.callsPerAction * units));
    const perCallMaxOut = cfg.maxOutputTokens ?? def.defaultMaxOutputTokens;
    const perCallTypOut = Math.max(1, Math.round(estOut / (def.callsPerAction * units)));
    const cands = await textCandidates(req.feature, perCallIn, perCallMaxOut, perCallTypOut, { ignoreMedical: req.evaluation });
    const n = def.callsPerAction * units;
    const want = req.pick === "cheapest" ? null : (req.model ?? (cfg.mode === "manual" ? cfg.model : null));
    const pick = want ? cands.find((c) => c.model.id === want) : cands[0];
    alternatives = cands.slice(0, 8).map((c) => ({ model: c.model.id, typicalInr: usdToInr(c.typicalUsd * n, fx.rate), maxInr: usdToInr(c.maxUsd * n, fx.rate), current: c.model.id === pick?.model.id }));
    if (cfg.mode === "auto" && !want && req.pick !== "cheapest") {
      notes.push("OpenRouter Auto picks the model per request from your approved list; the maximum shown is for the most expensive approved model.");
      const worst = cands.reduce<(typeof cands)[number] | null>((a, c) => (!a || c.maxUsd > a.maxUsd ? c : a), null);
      model = "openrouter/auto";
      textInr = cands[0] ? usdToInr(cands[0].typicalUsd * n, fx.rate) : null;
      textMaxInr = worst ? usdToInr(worst.maxUsd * n, fx.rate) : null;
      if (!worst) {
        runnable = false;
        blockReason = "No approved text model passes the checks for this feature (AI → Models).";
      }
    } else if (!pick) {
      runnable = false;
      blockReason = want ? `Model "${want}" is not approved / not suitable for ${def.label}.` : `No approved text model passes the checks for ${def.label}${def.medical ? " (medical features need a medically approved model)" : ""}.`;
      model = want ?? "—";
    } else {
      model = pick.model.id;
      textInr = usdToInr(pick.typicalUsd * n, fx.rate);
      textMaxInr = usdToInr(pick.maxUsd * n, fx.rate);
      if (pick.maxUsd * fx.rate > capInr) {
        runnable = false;
        blockReason = `One request may cost up to ₹${(pick.maxUsd * fx.rate).toFixed(2)}, above the per-request limit ₹${capInr.toFixed(2)}. Choose a cheaper model or lower the output tokens.`;
      }
    }
    notes.push("Input tokens are estimated from recent requests for this feature; output is shown as typical and as the maximum allowed.");
  }
  if (fx.stale && fx.rate !== null) notes.push("The USD→INR rate is more than 3 days old.");
  notes.push("Estimates are not a guaranteed final price. The actual cost reported by OpenRouter is recorded after the request.");

  const totalInr = provider === "legacy" || (textInr === null && imageInr === null) ? null : (textInr ?? 0) + (imageInr ?? 0);
  const totalMaxInr = provider === "legacy" ? null : textMaxInr === null && imageInr === null ? null : (textMaxInr ?? 0) + (imageInr ?? 0);
  if (runnable && totalMaxInr !== null && totalMaxInr > base.budgetDayLeftInr) {
    runnable = false;
    blockReason = `The maximum cost (₹${totalMaxInr.toFixed(2)}) is more than today's remaining AI budget (₹${base.budgetDayLeftInr.toFixed(2)}).`;
  }
  provider = cfg.provider;

  const row = {
    feature: req.feature,
    action: req.evaluation ? "model_eval" : req.action,
    model: model.slice(0, 120),
    routingMode: cfg.provider === "legacy" ? "legacy" : req.model ? "manual" : req.pick === "cheapest" ? "cheapest" : cfg.mode,
    estInputTokens: base.estInputTokens,
    estOutputTokens: base.estOutputTokens,
    estTextUsd: textInr !== null && fx.rate ? textInr / fx.rate : null,
    estImageUsd: imageInr !== null && fx.rate ? imageInr / fx.rate : null,
    maxCostUsd: totalMaxInr !== null && fx.rate ? totalMaxInr / fx.rate : null,
    maxCostInr: totalMaxInr,
    fxRate: fx.rate,
    status: (runnable ? "OPEN" : "CANCELLED") as "OPEN" | "CANCELLED",
  };
  return {
    view: { ...base, provider, routingMode: row.routingMode, model, textInr, textMaxInr, imageInr, totalInr, totalMaxInr, alternatives, notes, runnable, blockReason },
    row,
  };
}

export async function createQuote(req: QuoteRequest): Promise<QuoteView> {
  const { view, row } = await estimateQuote(req);
  const created = await prisma.aiCostQuote.create({
    data: { ...row, context: req.context as Prisma.InputJsonValue, actorId: req.actorId, expiresAt: new Date(Date.now() + QUOTE_TTL_MS) },
  });
  return { ...view, id: created.id, expiresAt: created.expiresAt.toISOString() };
}

// ---- Bulk (Instagram Bulk Studio: N posts × chosen AI steps, one approval) ---------------------

export const BULK_FEATURES = ["ig_carousel", "ig_diagram", "ig_trap", "ig_caption"] as const;
export type BulkFeature = (typeof BULK_FEATURES)[number];

export interface BulkQuoteView {
  posts: number;
  lines: { feature: BulkFeature; label: string; provider: "openrouter" | "legacy"; model: string; perPostInr: number | null; perPostMaxInr: number | null; totalInr: number | null; totalMaxInr: number | null; runnable: boolean; blockReason: string | null }[];
  totalInr: number | null;
  totalMaxInr: number | null;
  budgetDayLeftInr: number;
  fxRate: number | null;
  fxSource: string | null;
  fxAt: string | null;
  runnable: boolean;
  blockReason: string | null;
  notes: string[];
  expiresAt: string;
  /** postId → feature → one-time quote id (consumed by each step's action). */
  quotes: Record<string, Partial<Record<BulkFeature, string>>>;
}

/**
 * One AI Cost Preview for a whole Bulk Studio run. Each step of each post still
 * gets its own one-time quote (the per-post actions consume them exactly like a
 * single preview), so double clicks and replays stay impossible; the admin sees
 * and approves the combined estimate once.
 */
export async function createBulkQuote(req: { actorId: string; postIds: string[]; features: BulkFeature[]; legacyProvider?: boolean }): Promise<BulkQuoteView> {
  const postIds = [...new Set(req.postIds)].slice(0, 50);
  const features = BULK_FEATURES.filter((f) => req.features.includes(f));
  if (!postIds.length || !features.length) throw new QuoteError("Nothing to generate.");
  const lines: BulkQuoteView["lines"] = [];
  const rows: { feature: BulkFeature; row: Awaited<ReturnType<typeof estimateQuote>>["row"] }[] = [];
  let first: Awaited<ReturnType<typeof estimateQuote>>["view"] | null = null;
  for (const f of features) {
    const { view, row } = await estimateQuote({ feature: f, action: f, context: {}, actorId: req.actorId, legacyProvider: req.legacyProvider });
    first ??= view;
    const n = postIds.length;
    lines.push({
      feature: f,
      label: view.featureLabel,
      provider: view.provider,
      model: view.model,
      perPostInr: view.totalInr,
      perPostMaxInr: view.totalMaxInr,
      totalInr: view.totalInr === null ? null : view.totalInr * n,
      totalMaxInr: view.totalMaxInr === null ? null : view.totalMaxInr * n,
      runnable: view.runnable,
      blockReason: view.blockReason,
    });
    rows.push({ feature: f, row });
  }
  const known = lines.filter((l) => l.totalInr !== null);
  const totalInr = known.length ? known.reduce((a, l) => a + (l.totalInr ?? 0), 0) : null;
  const totalMaxInr = known.length ? known.reduce((a, l) => a + (l.totalMaxInr ?? 0), 0) : null;
  const dayLeft = first!.budgetDayLeftInr;
  let runnable = lines.every((l) => l.runnable);
  let blockReason = lines.find((l) => !l.runnable)?.blockReason ?? null;
  if (runnable && totalMaxInr !== null && totalMaxInr > dayLeft) {
    runnable = false;
    blockReason = `The maximum cost of this run (₹${totalMaxInr.toFixed(2)}) is more than today's remaining AI budget (₹${dayLeft.toFixed(2)}). Select fewer posts or steps.`;
  }
  // Long runs: the quotes stay valid for about a minute per request (10 min minimum, 2 h maximum).
  const ttl = Math.min(2 * 3600_000, Math.max(QUOTE_TTL_MS, postIds.length * features.length * 60_000));
  const expiresAt = new Date(Date.now() + ttl);
  const quotes: BulkQuoteView["quotes"] = {};
  const data: Prisma.AiCostQuoteCreateManyInput[] = [];
  for (const postId of postIds) {
    quotes[postId] = {};
    for (const { feature, row } of rows) {
      const id = crypto.randomUUID().replace(/-/g, "");
      quotes[postId][feature] = id;
      data.push({ ...row, id, status: runnable ? "OPEN" : "CANCELLED", context: { postId } as Prisma.InputJsonValue, actorId: req.actorId, expiresAt });
    }
  }
  await prisma.aiCostQuote.createMany({ data });
  return {
    posts: postIds.length,
    lines,
    totalInr,
    totalMaxInr,
    budgetDayLeftInr: dayLeft,
    fxRate: first!.fxRate,
    fxSource: first!.fxSource,
    fxAt: first!.fxAt,
    runnable,
    blockReason,
    notes: [
      "Each post is generated one after another; every request is re-checked against the budgets when it runs, so the run stops cleanly if a budget is reached.",
      ...(lines.some((l) => l.provider === "legacy") ? ["Steps on the legacy provider route have no cost estimate."] : []),
      "Estimates are not a guaranteed final price. Actual costs are recorded per request.",
    ],
    expiresAt: expiresAt.toISOString(),
    quotes,
  };
}

export async function cancelQuotes(ids: string[], actorId: string): Promise<void> {
  const safe = ids.filter((id) => /^[a-z0-9]{20,40}$/.test(id)).slice(0, 500);
  if (safe.length) await prisma.aiCostQuote.updateMany({ where: { id: { in: safe }, actorId, status: "OPEN" }, data: { status: "CANCELLED" } });
}

export interface ConsumedQuote {
  id: string;
  /** OpenRouter model to use, or null to follow the feature's routing (legacy / auto). */
  model: string | null;
}

/**
 * Atomically marks the quote USED. Fails when it is unknown, expired, already
 * used, cancelled, or belongs to a different admin / feature / action / context.
 */
export async function consumeQuote(input: { quoteId: unknown; actorId: string; feature: AiFeature; action: string; context: Record<string, string | number | null> }): Promise<ConsumedQuote> {
  if (typeof input.quoteId !== "string" || !/^[a-z0-9]{20,40}$/.test(input.quoteId)) {
    throw new QuoteError("Review the AI cost estimate first: click the button again to see the cost preview.");
  }
  const q = await prisma.aiCostQuote.findUnique({ where: { id: input.quoteId } });
  const sameContext = q && JSON.stringify(q.context) === JSON.stringify(input.context);
  if (!q || q.actorId !== input.actorId || q.feature !== input.feature || q.action !== input.action || !sameContext) {
    throw new QuoteError("This cost estimate does not match the action. Nothing was generated — request a new estimate.");
  }
  const claimed = await prisma.aiCostQuote.updateMany({ where: { id: q.id, status: "OPEN", expiresAt: { gt: new Date() } }, data: { status: "USED", usedAt: new Date() } });
  if (claimed.count !== 1) {
    if (q.status === "OPEN") await prisma.aiCostQuote.updateMany({ where: { id: q.id, status: "OPEN" }, data: { status: "EXPIRED" } });
    throw new QuoteError(q.status === "USED" ? "This estimate was already used — the request is already running or done. Nothing new was started." : "This cost estimate has expired. Nothing was generated — request a new estimate.");
  }
  const model = q.routingMode === "legacy" || q.model === "openrouter/auto" || !q.model.includes("/") ? null : q.model;
  return { id: q.id, model };
}

export async function cancelQuote(quoteId: string, actorId: string): Promise<void> {
  await prisma.aiCostQuote.updateMany({ where: { id: quoteId, actorId, status: "OPEN" }, data: { status: "CANCELLED" } });
}
