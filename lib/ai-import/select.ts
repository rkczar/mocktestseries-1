import "server-only";
import type { AiModel } from "@prisma/client";
import { getUsdInr, peekUsdInr } from "@/lib/ai-engine/fx";
import { formatInr, usdToInr } from "@/lib/ai-engine/config";
import { IMAGE_TOKENS, PRICE_MARGIN, estimateInputTokens, inputImagePriceUsd, modelProblem } from "@/lib/ai-import/ai";
import { CLASSIFY_SYSTEM, EXTRACT_SYSTEM, KEY_SYSTEM } from "@/lib/ai-import/prompts";
import { SELECTION_TASKS, SELECTION_TASK_LABELS, type ImporterSettings, type SelectionTask } from "@/lib/ai-import/config";
import { candidateModels, freshRouteSnapshot, getRouteSnapshot, isStale, type Route, type RouteSnapshot } from "@/lib/ai-import/routes";
import type { CandidateRow, ModelHealth, ModelPlan, PlanPrice, TaskChoice } from "@/lib/ai-import/selection-types";
import { importerModelHealth, rateLimitAvoidance } from "@/lib/ai-import/health";

/**
 * Automatic model selection for the AI Question Importer.
 *
 * For each task (page reading, independent verification, answer-key reading,
 * topic classification) every model on the importer's OWN list (Import
 * Settings → Importer models; the global AI → Models approval is not used) is
 * evaluated against the task's largest request as the worker sends it:
 *
 *   on the importer list / not disabled / still listed / not expired / fixed price
 *   → image input when the task reads page images
 *   → provider routes read from OpenRouter, serving normally (status 0)
 *   → Zero-Data-Retention routes only, when ZDR is required
 *   → a route that honours an output limit (max_tokens), with room for the request
 *   → conservative MAXIMUM cost of one request = the highest price over the
 *     model's catalog price and every eligible route (incl. long-prompt
 *     overrides) × PRICE_MARGIN, and it must fit the per-request limit
 *
 * The cheapest eligible model by that maximum wins (then by typical cost, then
 * by id); independent verification must use a different model than page
 * reading. Automatic mode also skips a model whose provider rate-limited its
 * most recent importer requests (lib/ai-import/health.ts) — measured history,
 * never a guess from the model's name. Nothing is guessed: a model without readable routes or prices is
 * ineligible with the reason shown. Manual mode evaluates the administrator's
 * chosen models with the same checks.
 */

/** The largest request of each task, as the worker sends it (output limits from process.ts / keys.ts / post.ts). */
export const PROFILES: Record<SelectionTask, { system: string; textChars: number; images: number; maxOut: number }> = {
  extract: { system: EXTRACT_SYSTEM, textChars: 12_600, images: 1, maxOut: 8_000 },
  // Second reads send the same page request as extraction (the text-only independent answer is far smaller).
  verify: { system: EXTRACT_SYSTEM, textChars: 12_600, images: 1, maxOut: 8_000 },
  key: { system: KEY_SYSTEM, textChars: 100, images: 1, maxOut: 4_000 },
  classify: { system: CLASSIFY_SYSTEM, textChars: 30_000, images: 0, maxOut: 2_500 },
};

const VISION: Record<SelectionTask, boolean> = { extract: true, verify: true, key: true, classify: false };

export function profileInputTokens(task: SelectionTask): number {
  const p = PROFILES[task];
  return estimateInputTokens(p.system, [{ type: "text", text: "x".repeat(p.textChars) }, ...Array.from({ length: p.images }, () => ({ type: "image_url" as const, image_url: { url: "" } }))]);
}

/** Worst-case USD of one request at these prices. */
export function requestUsd(price: PlanPrice, inputTokens: number, maxOut: number, images: number): number {
  return inputTokens * price.prompt + maxOut * price.completion + price.request + images * IMAGE_TOKENS * price.image;
}

interface Evaluation {
  row: CandidateRow;
  price: PlanPrice | null;
  maxUsd: number | null;
}

/** Evaluates one model for one task (pure: everything it needs is passed in). */
export function evaluateModel(m: AiModel | undefined, id: string, task: SelectionTask, ctx: { snapshot: RouteSnapshot | null; settings: ImporterSettings; fxRate: number | null }): Evaluation {
  const vision = VISION[task];
  const fail = (reason: string, routes: string[] = []): Evaluation => ({ row: { id, eligible: false, reason, maxInr: null, typicalInr: null, routes }, price: null, maxUsd: null });
  const problem = modelProblem(m, vision, ctx.settings.importerModels);
  if (problem || !m) return fail(problem ?? "not in the model catalog");
  if (m.isImageModel) return fail("an image-generation model");
  if (ctx.fxRate === null) return fail("no USD→INR rate, so its cost cannot be set");
  const info = ctx.snapshot?.models[id];
  if (!ctx.snapshot || !info) return fail("its provider routes have not been read (refresh the routes)");
  if (!info.ok) return fail(`its provider routes could not be read (${info.error ?? "error"})`);
  if (!info.routes.length) return fail("OpenRouter lists no provider route for it");
  const p = PROFILES[task];
  const inputTokens = profileInputTokens(task);
  let routes: Route[] = info.routes.filter((r) => r.status === 0);
  if (!routes.length) return fail("no provider route is currently serving normally");
  if (ctx.settings.privacy.zdr) {
    if (!ctx.snapshot.zdr.ok) return fail(`the Zero-Data-Retention route list could not be read (${ctx.snapshot.zdr.error ?? "error"})`);
    routes = routes.filter((r) => r.zdr);
    if (!routes.length) return fail("no Zero-Data-Retention route (ZDR is required in Import Settings)");
  }
  routes = routes.filter((r) => r.price.prompt !== null && r.price.completion !== null && r.price.image !== null && r.price.request !== null && r.price.reasoning !== null && r.price.overrides.every((o) => o.prompt !== null && o.completion !== null));
  if (!routes.length) return fail("no eligible route publishes a readable price");
  routes = routes.filter((r) => r.params === null || r.params.includes("max_tokens"));
  if (!routes.length) return fail("no eligible route accepts an output limit (max_tokens), so a maximum cost cannot be set");
  routes = routes.filter((r) => (r.contextLength === null || r.contextLength >= inputTokens + p.maxOut) && (r.maxCompletionTokens === null || r.maxCompletionTokens >= p.maxOut));
  if (!routes.length) return fail("no eligible route has room for this task's request");

  // Highest price over the catalog price and every eligible route (OpenRouter may serve any of them).
  const catalogImage = inputImagePriceUsd(m) ?? 0;
  const price: PlanPrice = {
    prompt: m.promptPrice ?? 0,
    completion: Math.max(m.completionPrice ?? 0, m.reasoningPrice ?? 0),
    image: vision ? catalogImage : 0,
    request: m.requestPrice ?? 0,
  };
  for (const r of routes) {
    const over = r.price.overrides.filter((o) => o.minPromptTokens <= inputTokens);
    price.prompt = Math.max(price.prompt, r.price.prompt!, ...over.map((o) => o.prompt!));
    price.completion = Math.max(price.completion, r.price.completion!, r.price.reasoning!, ...over.map((o) => o.completion!));
    if (vision) price.image = Math.max(price.image, r.price.image!);
    price.request = Math.max(price.request, r.price.request!);
  }
  const maxUsd = requestUsd(price, inputTokens, p.maxOut, p.images) * PRICE_MARGIN;
  const typicalUsd = requestUsd(price, inputTokens, Math.round(p.maxOut * 0.4), p.images);
  const maxInr = usdToInr(maxUsd, ctx.fxRate)!;
  const row: CandidateRow = { id, eligible: true, reason: null, maxInr, typicalInr: usdToInr(typicalUsd, ctx.fxRate), routes: routes.map((r) => r.tag || r.provider) };
  if (maxInr > ctx.settings.budget.maxRequestInr) {
    return { row: { ...row, eligible: false, reason: `one request could cost up to ${formatInr(maxInr)}, above the per-request limit of ${formatInr(ctx.settings.budget.maxRequestInr)}` }, price, maxUsd };
  }
  return { row, price, maxUsd };
}

const order = (a: CandidateRow, b: CandidateRow) => Number(b.eligible) - Number(a.eligible) || (a.maxInr ?? Infinity) - (b.maxInr ?? Infinity) || (a.typicalInr ?? Infinity) - (b.typicalInr ?? Infinity) || a.id.localeCompare(b.id);

/** Chooses one model per task (pure). `exclude` = models that failed at run time for that task. */
export function choose(models: AiModel[], ctx: { snapshot: RouteSnapshot | null; settings: ImporterSettings; fxRate: number | null; health?: Record<string, ModelHealth>; now?: number }, exclude: Partial<Record<SelectionTask, string[]>> = {}): Record<SelectionTask, TaskChoice> {
  const byId = new Map(models.map((m) => [m.id, m]));
  const s = ctx.settings;
  const privacy = { zdrRequired: s.privacy.zdr, dataCollection: s.privacy.dataCollection, zdrVerified: false };
  const out = {} as Record<SelectionTask, TaskChoice>;
  for (const task of SELECTION_TASKS) {
    const label = SELECTION_TASK_LABELS[task].toLowerCase();
    const evals = new Map<string, Evaluation>();
    const ids = s.selection.mode === "manual" ? [...new Set([manualModel(s, task), ...(task === "extract" ? s.models.extractFallbacks : [])].filter((x): x is string => !!x))] : models.map((m) => m.id);
    for (const id of ids) evals.set(id, evaluateModel(byId.get(id), id, task, ctx));
    for (const id of exclude[task] ?? []) {
      const e = evals.get(id);
      if (e) evals.set(id, { ...e, row: { ...e.row, eligible: false, reason: "unavailable when the job ran" } });
    }
    // Recently rate-limited by its provider: automatic selection skips it (the manual override may still choose it).
    if (s.selection.mode === "auto") {
      for (const [id, e] of evals) {
        const avoid = e.row.eligible ? rateLimitAvoidance(ctx.health?.[id], ctx.now) : null;
        if (avoid) evals.set(id, { ...e, row: { ...e.row, eligible: false, reason: avoid } });
      }
    }
    // Independent verification never reuses the page-reading model.
    const reader = out.extract?.model;
    if (task === "verify" && reader && evals.has(reader)) {
      const e = evals.get(reader)!;
      evals.set(reader, { ...e, row: { ...e.row, eligible: false, reason: e.row.reason ?? "already reads the pages (verification needs a different model)" } });
    }
    const rows = [...evals.values()].map((e) => e.row).sort(order);
    const eligible = rows.filter((r) => r.eligible);
    let pick: CandidateRow | null = null;
    let reason: string;
    if (s.selection.mode === "manual") {
      const want = manualModel(s, task);
      const row = want ? rows.find((r) => r.id === want) : undefined;
      if (!want) reason = `No model is set for ${label} (manual selection).`;
      else if (!row?.eligible) reason = `Manual choice ${want} cannot be used: ${row?.reason ?? "not evaluated"}.`;
      else {
        pick = row;
        const avoid = rateLimitAvoidance(ctx.health?.[want], ctx.now);
        reason = `Manual override by an administrator: ${want}, up to ${formatInr(row.maxInr)} per request.${avoid ? ` Warning: ${avoid.replace(/, so automatic selection skips it.*$/, "")}.` : ""}`;
      }
    } else if (!eligible.length) {
      reason = rows.length ? `No approved model is suitable and affordable for ${label}. ${rows.slice(0, 4).map((r) => `${r.id}: ${r.reason}`).join("; ")}.` : s.importerModels.length ? `None of the importer's approved models can be used (disabled, no longer listed, or not a text model).` : `No model is approved for the AI Question Importer yet (Import Settings → Importer models).`;
    } else {
      pick = eligible[0];
      const next = eligible[1];
      reason = `Cheapest suitable of ${eligible.length} eligible model${eligible.length === 1 ? "" : "s"}: up to ${formatInr(pick.maxInr)} per request${next ? ` (next: ${next.id}, up to ${formatInr(next.maxInr)})` : ""}${VISION[task] ? "; reads page images" : ""}${s.privacy.zdr ? `; ZDR routes ${pick.routes.join(", ")}` : ""}.`;
    }
    const e = pick ? evals.get(pick.id)! : null;
    // Manual fallbacks: only eligible ones that cost no more than the chosen model.
    const fallbacks = pick && task === "extract" && s.selection.mode === "manual" ? s.models.extractFallbacks.filter((f) => f !== pick!.id && evals.get(f)?.row.eligible && (evals.get(f)!.row.maxInr ?? Infinity) <= (pick!.maxInr ?? 0)) : [];
    const price = e?.price ? { ...e.price } : null;
    let maxUsd = e?.maxUsd ?? null;
    for (const f of fallbacks) {
      const fe = evals.get(f)!;
      if (price && fe.price) for (const k of ["prompt", "completion", "image", "request"] as const) price[k] = Math.max(price[k], fe.price[k]);
      maxUsd = Math.max(maxUsd ?? 0, fe.maxUsd ?? 0);
    }
    out[task] = {
      task,
      model: pick?.id ?? null,
      fallbacks,
      mode: s.selection.mode,
      reason,
      vision: VISION[task],
      price,
      maxUsd,
      maxInr: pick ? pick.maxInr : null,
      typicalInr: pick ? pick.typicalInr : null,
      routes: pick?.routes ?? [],
      // ZDR is "verified" only in the sense that OpenRouter's public ZDR list names every route the model may use.
      privacy: { ...privacy, zdrVerified: !!pick && s.privacy.zdr },
      candidates: rows.slice(0, 30),
    };
  }
  return out;
}

function manualModel(s: ImporterSettings, task: SelectionTask): string | null {
  if (task === "key") return s.models.key ?? s.models.extract;
  return s.models[task];
}

/**
 * The model plan for these settings. `refresh`: route data older than ROUTES_MAX_AGE_MS is read again
 * from OpenRouter first (job confirmation); otherwise the stored snapshot is used and its age is reported
 * (Import Settings page — no network call on page load).
 */
export async function computeModelPlan(settings: ImporterSettings, opts: { refresh: boolean; snapshot?: RouteSnapshot }, exclude: Partial<Record<SelectionTask, string[]>> = {}): Promise<ModelPlan> {
  const problems: string[] = [];
  let snapshot: RouteSnapshot | null = null;
  try {
    // `snapshot`: routes the caller just read (a preview reads them without storing them).
    snapshot = opts.snapshot ?? (opts.refresh ? await freshRouteSnapshot(settings.importerModels) : await getRouteSnapshot());
  } catch (e) {
    problems.push(`Provider routes could not be read from OpenRouter (${e instanceof Error ? e.message.slice(0, 160) : "error"}).`);
    snapshot = null;
  }
  const stale = isStale(snapshot);
  if (!snapshot) problems.push("Provider route data has not been read yet — use Refresh routes.");
  else if (stale) problems.push(`Provider route data is from ${snapshot.fetchedAt.slice(0, 16).replace("T", " ")} UTC (older than 6 h). It is read again when a job is confirmed.`);
  const fx = opts.refresh ? await getUsdInr() : await peekUsdInr();
  if (fx.rate === null) problems.push(`No USD→INR rate: ${fx.unavailableReason ?? "unavailable"}. No model can be priced.`);
  const models = await candidateModels(settings.importerModels);
  // A stale snapshot is never used to choose a model for a job.
  const usable = opts.refresh && stale ? null : snapshot;
  const health = await importerModelHealth(models.map((m) => m.id));
  const tasks = choose(models, { snapshot: usable, settings, fxRate: fx.rate, health }, exclude);
  return {
    computedAt: new Date().toISOString(),
    mode: settings.selection.mode,
    routesFetchedAt: snapshot?.fetchedAt ?? null,
    routesStale: stale,
    fxRate: fx.rate,
    fxDate: fx.rateDate,
    privacy: { zdr: settings.privacy.zdr, dataCollection: settings.privacy.dataCollection },
    tasks,
    problems,
  };
}

/** The models a frozen plan uses, in the shape the worker's call sites read (settings.models). */
export function modelsFromPlan(plan: ModelPlan): ImporterSettings["models"] {
  return { extract: plan.tasks.extract.model, extractFallbacks: plan.tasks.extract.fallbacks, verify: plan.tasks.verify.model, classify: plan.tasks.classify.model, key: plan.tasks.key.model };
}

export function planOf(config: unknown): ModelPlan | null {
  const p = (config as { modelPlan?: ModelPlan } | null)?.modelPlan;
  return p && p.tasks && p.tasks.extract ? p : null;
}
