import "server-only";
import { createHash } from "node:crypto";
import type { AiModel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/ai-engine/config";
import { IMPORTER_SETTING_KEY, MAX_IMPORTER_MODELS, PILOT_LIMITS, SELECTION_TASKS, SELECTION_TASK_LABELS, normalizeImporterSettings, type ImporterSettings, type SelectionTask } from "@/lib/ai-import/config";
import { loadCtx, publishedZero, recommend, type Ctx } from "@/lib/ai-import/assistant";
import type { AssistantPurpose } from "@/lib/ai-import/assistant-types";
import { readRoutes, storeRouteSnapshot, type RouteSnapshot } from "@/lib/ai-import/routes";
import { autoSkip, choose, evaluateModel } from "@/lib/ai-import/select";
import { importerSettingsProblems } from "@/lib/ai-import/models";
import { saveImporterSettings } from "@/lib/ai-import/settings";
import { estimateJobCost } from "@/lib/ai-import/estimate";
import type { FileFacts } from "@/lib/ai-import/analyze";
import type { ModelPlan, TaskChoice } from "@/lib/ai-import/selection-types";
import { AUTO_TASKS, AUTO_TASK_ENGINE, AUTO_TASK_LABELS, type AutoChange, type AutoConfigApplied, type AutoConfigPreview, type AutoJobCost, type AutoTask, type AutoTaskRow } from "@/lib/ai-import/autoconfig-types";

/**
 * Import Settings → "AI Auto-Configure Everything". Prepares the importer's
 * models and related settings in one step, deterministically: the Model
 * Assistant's catalog ranking (published image input and prices, privacy,
 * recent rate-limit history) gives the candidates per task, their provider
 * routes are read from OpenRouter now (free public metadata, kept in memory —
 * a preview saves nothing), and the selection engine's own checks
 * (lib/ai-import/select.ts evaluateModel/choose: serving route, ZDR, readable
 * prices, output limit, conservative maximum within the per-request limit)
 * decide. No AI request is ever sent, whether Paid AI is on or off, and
 * capability is never inferred from a model's name. Quality is "Not tested".
 *
 * Apply saves only after the administrator confirmed the preview: it re-reads
 * routes and prices, recomputes the proposal and refuses unless the saved
 * settings and the proposal are exactly what the preview showed. Budgets,
 * Paid AI and privacy are never changed (never raised), a pricier fallback is
 * never enabled, and only the importer's own settings (ai.importer and its
 * route snapshot) are written — never student Ask AI, Instagram, AI → Models
 * approvals, payments or Premium.
 */

export class AutoConfigError extends Error {}

/** Candidates per task taken from the Model Assistant ranking (their routes are read for the preview). */
const POOL = 5;
const PURPOSE_OF: Record<SelectionTask, AssistantPurpose> = { extract: "ocr", key: "answer_key", verify: "verification", classify: "classification" };
/** Pick order: verification must differ from page reading, so page reading is chosen first. */
const PICK_ORDER: SelectionTask[] = ["extract", "key", "verify", "classify"];
/** Reference job for the cost preview: a scanned paper with a scanned answer-key page. */
const REF_PAGES = 10;
const REF_KEY_PAGES = 1;
/** Scanned pages are read reliably at this resolution; page images are capped at 1600 px, so the cost per page does not change. */
const OCR_MIN_DPI = 150;

const at = (iso: string | null | undefined) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never");
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/** Identifies a saved settings document (normalized content + when it was saved). */
export function baselineKeyOf(raw: unknown): string {
  const r = (raw ?? {}) as { updatedAt?: unknown };
  return hash({ s: normalizeImporterSettings(raw), u: typeof r.updatedAt === "string" ? r.updatedAt : null });
}

async function savedRaw(db: Pick<Prisma.TransactionClient, "setting"> = prisma): Promise<unknown> {
  return (await db.setting.findUnique({ where: { key: IMPORTER_SETTING_KEY } }))?.value ?? {};
}

/**
 * Throws unless `proposed` keeps every safety-relevant setting of `saved`: Paid AI, every budget and the
 * retry rule unchanged, privacy unchanged, no pricier fallback, no model removed, no higher request rate.
 */
export function assertSafeProposal(saved: ImporterSettings, proposed: ImporterSettings): void {
  const b = (s: ImporterSettings) => [s.budget.monthlyInr, s.budget.defaultJobCapInr, s.budget.maxJobInr, s.budget.totalInr, s.budget.maxRequestInr, s.budget.keyReserveUsd, s.budget.retryTransient];
  const problems: string[] = [];
  if (proposed.aiEnabled !== saved.aiEnabled) problems.push("Paid AI would change");
  if (JSON.stringify(b(proposed)) !== JSON.stringify(b(saved))) problems.push("a budget would change");
  if (JSON.stringify(proposed.privacy) !== JSON.stringify(saved.privacy)) problems.push("privacy would change");
  if (proposed.budget.allowPricierFallback) problems.push("a more expensive fallback would be enabled");
  if (saved.importerModels.some((id) => !proposed.importerModels.includes(id))) problems.push("a model would be removed from the importer's list");
  if (proposed.limits.concurrency > saved.limits.concurrency) problems.push("more parallel requests would be allowed");
  if (proposed.models.extractFallbacks.length) problems.push("a fallback model would be added");
  if (problems.length) throw new AutoConfigError(`Not saved: the proposal is not safe (${problems.join("; ")}). Nothing was changed.`);
}

interface Built {
  preview: AutoConfigPreview;
  /** The provider routes read for this preview (only the proposed list's models; stored on Apply). */
  snapshot: RouteSnapshot | null;
}

function referenceFacts(): { paper: FileFacts[]; key: FileFacts[] } {
  const file = (pages: number, documentType: FileFacts["documentType"]): FileFacts => ({
    kind: "PDF",
    pages,
    textPages: 0,
    scannedPages: pages,
    blankPages: 0,
    embeddedImages: 0,
    localQuestionCount: 0,
    questionTypes: {},
    answerKeyDetected: documentType === "ANSWER_KEY",
    formulasLikely: false,
    tablesLikely: false,
    documentType,
    notes: [],
    pagesDetail: Array.from({ length: pages }, (_, i) => ({ page: i + 1, textChars: 0, images: 0, kind: "SCANNED" as const, risk: [], localQuestions: 0 })),
  });
  return { paper: [file(REF_PAGES, "QUESTION_PAPER")], key: [file(REF_KEY_PAGES, "ANSWER_KEY")] };
}

function routeRow(choice: TaskChoice | undefined, snapshot: RouteSnapshot | null, zdr: boolean): AutoTaskRow["route"] {
  if (!choice?.model) return { state: "unavailable", text: "No model — nothing to verify.", at: snapshot?.fetchedAt ?? null };
  return { state: "verified", text: `Verified ${at(snapshot?.fetchedAt)} (read from OpenRouter now): ${choice.routes.join(", ")}${zdr ? " — Zero-Data-Retention routes only" : ""}.`, at: snapshot?.fetchedAt ?? null };
}

async function build(saved: ImporterSettings): Promise<Built> {
  const ctx: Ctx = await loadCtx(saved);
  const now = ctx.now;
  const fxRate = ctx.catalog.fx.rate;
  const blocking: string[] = [];
  let routesError: string | null = null;

  // 1. The Zero-Data-Retention list first (when it is required, a candidate without it cannot be judged).
  let zdrList: RouteSnapshot | null = null;
  try {
    zdrList = await readRoutes([]);
  } catch (e) {
    routesError = `Provider routes could not be read from OpenRouter (${e instanceof Error ? e.message.slice(0, 160) : "error"}).`;
  }
  if (zdrList && !zdrList.zdr.ok && saved.privacy.zdr) routesError = `The Zero-Data-Retention route list could not be read (${zdrList.zdr.error ?? "error"}), so privacy cannot be verified.`;
  const withZdr = (c: Ctx): Ctx => (zdrList?.zdr.ok ? { ...c, catalog: { ...c.catalog, routes: { ...c.catalog.routes, zdrModels: zdrList.zdr.models ?? [] } } } : c);

  // 2. Candidates per task from the Model Assistant ranking; read their routes (and the saved list's) now.
  const first = recommend(withZdr(ctx), POOL);
  const poolOf = (r: typeof first, t: SelectionTask) => r.purposes.find((p) => p.purpose === PURPOSE_OF[t])?.candidates.map((c) => c.id) ?? [];
  const top = SELECTION_TASKS.flatMap((t) => poolOf(first, t).slice(0, 2));
  const ids = [...new Set([...top, ...saved.importerModels, ...SELECTION_TASKS.flatMap((t) => poolOf(first, t))])].slice(0, MAX_IMPORTER_MODELS);
  let fresh: RouteSnapshot | null = null;
  if (!routesError) {
    try {
      fresh = await readRoutes(ids);
      if (saved.privacy.zdr && !fresh.zdr.ok) routesError = `The Zero-Data-Retention route list could not be read (${fresh.zdr.error ?? "error"}), so privacy cannot be verified.`;
    } catch (e) {
      routesError = `Provider routes could not be read from OpenRouter (${e instanceof Error ? e.message.slice(0, 160) : "error"}).`;
    }
  }
  if (routesError) blocking.push(`${routesError} Nothing can be configured on unverified routes — try again later.`);
  if (fxRate === null) blocking.push(`No USD→INR rate (${ctx.catalog.fx.unavailableReason ?? "unavailable"}), so no model can be priced.`);

  // 3. The ranking again with the routes just read (route states are now current).
  const fctx = withZdr({ ...ctx, snapshot: fresh });
  const rec = recommend(fctx, POOL);
  const rows = new Map((await prisma.aiModel.findMany({ where: { id: { in: [...new Set([...ids, ...saved.importerModels])] } } })).map((m) => [m.id, m]));
  const usable = fresh && !routesError && fxRate !== null ? fresh : null;

  // 4. Per task: the candidates the selection engine accepts on the routes just read — the Model Assistant's
  // ranking plus the models already on the importer's list — cheapest conservative maximum first.
  const pick: Record<SelectionTask, string | null> = { extract: null, key: null, verify: null, classify: null };
  const why: Record<SelectionTask, string[]> = { extract: [], key: [], verify: [], classify: [] };
  const eligibleOf: Record<SelectionTask, string[]> = { extract: [], key: [], verify: [], classify: [] };
  for (const t of PICK_ORDER) {
    const maxOf = new Map<string, number>();
    for (const id of [...new Set([...poolOf(rec, t), ...saved.importerModels])]) {
      if (t === "verify" && id === pick.extract) continue;
      // The selection engine's own checks, then automatic selection's own skips (recent rate limits; never
      // chosen for a ₹0 price) — exactly what `choose` applies for a new job.
      const ev = evaluateModel(rows.get(id) as AiModel | undefined, id, t, { snapshot: usable, settings: { ...saved, importerModels: [...new Set([...saved.importerModels, id])] }, fxRate });
      const avoid = autoSkip(ev.row, ctx.health, now);
      if (!ev.row.eligible || avoid) {
        why[t].push(`${id}: ${avoid ?? ev.row.reason}`);
        continue;
      }
      eligibleOf[t].push(id);
      maxOf.set(id, ev.row.maxInr ?? Infinity);
    }
    // Verification: another vendor than the page reader first (a more independent second read), then by cost.
    const vendor = (id: string | null) => (id ? rows.get(id)?.vendor ?? null : null);
    eligibleOf[t].sort((a, b) => (t === "verify" && pick.extract ? Number(vendor(a) === vendor(pick.extract)) - Number(vendor(b) === vendor(pick.extract)) : 0) || maxOf.get(a)! - maxOf.get(b)! || a.localeCompare(b));
    pick[t] = eligibleOf[t][0] ?? null;
  }
  if (!pick.extract && !blocking.length) blocking.push(`No model is suitable for page reading (scanned pages and formulas need a model that reads images, has a verified route accepting the importer's request parameters, a known non-zero price within the per-request limit and meets the privacy settings). Checked: ${why.extract.slice(0, 4).join("; ") || "no candidate"}. Nothing can be applied — add such a model to the catalog's importer candidates, or review the per-request limit yourself; limits are never raised automatically.`);

  // 5. The proposed settings. Budgets, Paid AI and privacy are copied unchanged.
  const picks = [...new Set(PICK_ORDER.map((t) => pick[t]).filter((x): x is string => !!x))];
  const list = [...saved.importerModels, ...picks.filter((id) => !saved.importerModels.includes(id))];
  if (list.length > MAX_IMPORTER_MODELS) blocking.push(`The importer's model list would have ${list.length} models (at most ${MAX_IMPORTER_MODELS}). Remove unused models first.`);
  const recentLimited = picks.some((id) => (ctx.health[id]?.rateLimited ?? 0) > 0);
  const proposed = normalizeImporterSettings({
    ...saved,
    importerModels: list.slice(0, MAX_IMPORTER_MODELS),
    selection: { mode: "manual" },
    models: { extract: pick.extract, extractFallbacks: [], verify: pick.verify, classify: pick.classify, key: pick.key },
    budget: { ...saved.budget, allowPricierFallback: false },
    limits: { ...saved.limits, concurrency: recentLimited ? 1 : saved.limits.concurrency, renderDpi: Math.max(saved.limits.renderDpi, OCR_MIN_DPI) },
    verification: { ...saved.verification, independentAnswer: saved.verification.independentAnswer && !!pick.verify },
  });
  assertSafeProposal(saved, proposed);

  // 6. Re-validation with the selection engine itself: what a job confirmed with these settings would use.
  const listRows = proposed.importerModels.map((id) => rows.get(id)).filter((m): m is AiModel => !!m && !m.disabled && !m.missingSince && !m.isImageModel && m.outputModalities.includes("text"));
  const tasks = choose(listRows, { snapshot: usable, settings: proposed, fxRate, health: ctx.health, now });
  for (const t of SELECTION_TASKS) {
    const want = t === "key" ? pick.key ?? pick.extract : pick[t];
    if (want && tasks[t].model !== want && !blocking.length) blocking.push(`${SELECTION_TASK_LABELS[t]}: the re-check did not confirm ${want} (${tasks[t].reason}). Nothing can be applied.`);
  }
  const plan: ModelPlan = { computedAt: new Date(now).toISOString(), mode: "manual", routesFetchedAt: fresh?.fetchedAt ?? null, routesStale: false, fxRate, fxDate: ctx.catalog.fx.rateDate, privacy: { ...proposed.privacy }, tasks, problems: [] };
  if (!blocking.length) {
    const problems = await importerSettingsProblems(proposed, proposed);
    for (const p of problems) blocking.push(p);
  }

  // 7. Rows for the preview.
  const option = (id: string | null) => (id ? ctx.catalog.options.find((o) => o.id === id) : undefined);
  const priceOf = (c: TaskChoice | undefined): AutoTaskRow["price"] => {
    if (!c?.model) return { state: "unknown", maxInr: null, text: "No model — no price." };
    const o = option(c.model);
    if (c.maxInr === null) return { state: "unknown", maxInr: null, text: "Unknown — not priced (never treated as ₹0.00)." };
    if (o && publishedZero(o) && c.maxInr === 0) return { state: "zero", maxInr: 0, text: "₹0.00 per request — a published free price (known zero); free routes have tight shared rate limits." };
    return { state: "published", maxInr: c.maxInr, text: `Up to ${formatInr(c.maxInr, 4)} per request (conservative maximum over its verified routes, incl. the price margin; limit ${formatInr(proposed.budget.maxRequestInr)}).` };
  };
  const privacyOf = (c: TaskChoice | undefined): AutoTaskRow["privacy"] =>
    !c?.model
      ? { eligible: null, text: "No model." }
      : proposed.privacy.zdr
        ? { eligible: true, text: `Eligible: served only by Zero-Data-Retention routes (${c.routes.join(", ")}); provider data collection: ${proposed.privacy.dataCollection}.` }
        : { eligible: true, text: `Zero-Data-Retention is not required in Import Settings (unchanged); provider data collection: ${proposed.privacy.dataCollection}.` };
  const rateOf = (id: string | null): AutoTaskRow["rateLimit"] => {
    const h = id ? ctx.health[id] : undefined;
    if (!id) return { warning: null, text: "—" };
    if (!h?.requests) return { warning: null, text: "No importer request in the last 24 h." };
    const text = `${h.requests} importer request(s) in 24 h: ${h.ok} answered, ${h.rateLimited} rate-limited${h.lastRateLimitedAt ? ` (latest ${at(h.lastRateLimitedAt)})` : ""}.`;
    return { warning: h.rateLimited ? `Rate-limited ${h.rateLimited} time(s) in the last 24 h — parallel requests are reduced to 1.` : null, text };
  };
  const noneText = (t: SelectionTask) => {
    const p = rec.purposes.find((x) => x.purpose === PURPOSE_OF[t]);
    const tried = why[t].slice(0, 3).join("; ");
    return `No suitable model. ${tried ? `Checked: ${tried}.` : p?.none ?? "No catalog model meets every requirement."}${p?.excluded.length ? ` Not considered: ${p.excluded.map((e) => `${e.count} ${e.reason}`).join("; ")}.` : ""}`;
  };
  const pickReason = (t: SelectionTask) => {
    const id = pick[t]!;
    const c = tasks[t];
    const n = eligibleOf[t].length;
    return `${id}: up to ${formatInr(c.maxInr, 4)} per request — best of ${n} suitable model${n === 1 ? "" : "s"} checked on routes read now${eligibleOf[t][1] ? ` (next: ${eligibleOf[t][1]})` : ""}. Ranked by conservative maximum cost; published-₹0 models are never chosen automatically, and models rate-limited recently are skipped. Quality: Not tested.`;
  };
  const SPECIFIC: Record<AutoTask, string> = {
    scanned: "Reads page images (published input modality) and returns text.",
    digital: "Digital PDFs are parsed locally from their text layer first (no AI request, no cost). Only pages the local parser cannot read reliably are sent to this page-reading model.",
    mathematics: "Formulas on a page are read from the page image by the page-reading model. The catalog publishes no mathematics ability, so formula accuracy is Not tested.",
    chemistry: "Equations and structures are read from the page image by the page-reading model. The catalog publishes no chemistry ability, so accuracy is Not tested.",
    diagrams: "Figure positions are read from the page image by the page-reading model; figures are cropped from the page. Figure accuracy is Not tested.",
    answer_key: "Reads scanned answer-key images; text keys are read locally without AI.",
    verification: `A different model than page reading${pick.verify && pick.extract && option(pick.verify)?.vendor !== option(pick.extract)?.vendor ? " and a different vendor" : ""}, so the second read is independent.`,
    classification: "Text only (no image input needed).",
  };
  const taskRows: AutoTaskRow[] = AUTO_TASKS.map((task) => {
    const t = AUTO_TASK_ENGINE[task];
    const c = tasks[t];
    const model = pick[t] ?? (t === "key" ? pick.extract : null);
    const vision = t !== "classify";
    return {
      task,
      label: AUTO_TASK_LABELS[task],
      engineTask: t,
      model,
      reason: model ? `${t === "key" && !pick.key ? `${model} (the page-reading model; no separate key model qualified). ` : pickReason(t)} ${SPECIFIC[task]}` : `${noneText(t)} ${t === "verify" ? "Second reads and independent answers do not run; questions keep their review flags." : t === "classify" ? "Topics are left for review." : ""}`,
      imageInput: vision ? (model ? !!option(model)?.vision : null) : null,
      route: routeRow(model ? c : undefined, fresh, proposed.privacy.zdr),
      price: priceOf(model ? c : undefined),
      privacy: privacyOf(model ? c : undefined),
      rateLimit: rateOf(model),
      quality: "not_tested",
      alternatives: eligibleOf[t].filter((x) => x !== model).slice(0, 2),
    };
  });

  // 8. Job cost for a reference job, with the proposed models and the unchanged limits.
  const facts = referenceFacts();
  const est = await estimateJobCost({ paperFacts: facts.paper, keyFacts: facts.key, settings: { ...proposed, aiEnabled: true }, plan });
  const jobCap = Math.min(proposed.budget.maxJobInr, PILOT_LIMITS.maxJobInr);
  const attempts = proposed.budget.retryTransient ? 2 : 1;
  const perPage = tasks.extract.model && tasks.extract.maxInr !== null ? attempts * (tasks.extract.maxInr + (tasks.verify.model ? tasks.verify.maxInr ?? NaN : 0) + (tasks.classify.model ? (tasks.classify.maxInr ?? NaN) / 4 : 0)) : NaN;
  const keyMax = tasks.key.model ? (tasks.key.maxInr ?? NaN) * attempts : 0;
  const maxPages = Number.isFinite(perPage) && perPage > 0 && Number.isFinite(keyMax) ? Math.max(0, Math.floor((jobCap - keyMax) / perPage)) : null;
  const jobCost: AutoJobCost = {
    reference: `${REF_PAGES} scanned pages (about ${REF_PAGES * 5} questions) and ${REF_KEY_PAGES} scanned answer-key page`,
    estimateInr: est.totalInr,
    maxInr: est.maxInr,
    jobCapInr: jobCap,
    fitsJobCap: est.maxInr === null ? null : est.maxInr <= jobCap,
    maxScannedPagesPerJob: maxPages,
    notes: [
      ...est.notes.filter((n) => !/Paid AI processing is OFF/.test(n)),
      ...(perPage === 0 ? ["The page-reading model has a published price of ₹0: a job is limited by provider rate limits, not by cost."] : []),
      ...(est.maxInr !== null && est.maxInr > jobCap ? [`The conservative maximum is above the ₹${jobCap} per-job limit: such a job would be refused at confirmation — import fewer pages per job.`] : []),
      "Estimates only; the server reserves each request's maximum before it is sent and every budget limit applies.",
    ],
  };

  // 9. Current versus proposed.
  const yes = (b: boolean) => (b ? "On" : "Off");
  const m = (v: string | null) => v ?? "none";
  const change = (key: string, label: string, current: string, proposedV: string, whyV: string): AutoChange => ({ key, label, current, proposed: proposedV, changed: current !== proposedV, why: whyV });
  const added = proposed.importerModels.filter((id) => !saved.importerModels.includes(id));
  const changes: AutoChange[] = [
    change("selection", "Model selection", saved.selection.mode === "auto" ? "Automatic" : "Manual override", "Manual (pinned to the models below)", "Jobs then use exactly the models shown here. Automatic selection picks the cheapest listed model at confirmation, which can be a published-₹0 model with shared rate limits. Switch back to Automatic at any time."),
    change("importerModels", "Importer's model list", saved.importerModels.length ? saved.importerModels.join(", ") : "empty", added.length ? `${saved.importerModels.length ? "kept + " : ""}${added.join(", ")}` : "unchanged", "Only models the importer needs are added; nothing is removed. This list is the importer's own — AI → Models approvals are not changed."),
    change("models.extract", "Page reading (scanned, digital fallback, maths, chemistry, diagrams)", m(saved.models.extract), m(proposed.models.extract), "See the task table."),
    change("models.key", "Answer-key reading", m(saved.models.key), m(proposed.models.key), "See the task table."),
    change("models.verify", "Independent verification", m(saved.models.verify), m(proposed.models.verify), "See the task table."),
    change("models.classify", "Topic and subject classification", m(saved.models.classify), m(proposed.models.classify), "See the task table."),
    change("models.extractFallbacks", "Fallback page-reading models", saved.models.extractFallbacks.join(", ") || "none", "none", "No fallback is added automatically."),
    change("budget.allowPricierFallback", "More expensive fallback", yes(saved.budget.allowPricierFallback), "Off", "Never enabled automatically: when a model becomes unavailable, processing stops and says why instead of switching to a pricier model."),
    change("limits.concurrency", "Parallel AI requests per job", String(saved.limits.concurrency), String(proposed.limits.concurrency), proposed.limits.concurrency < saved.limits.concurrency ? "A chosen model was rate-limited recently: one request at a time." : "Unchanged (never increased automatically)."),
    change("limits.renderDpi", "Page render resolution (OCR)", `${saved.limits.renderDpi} DPI`, `${proposed.limits.renderDpi} DPI`, proposed.limits.renderDpi > saved.limits.renderDpi ? `Scanned pages are read more reliably at ${OCR_MIN_DPI} DPI; page images stay capped at 1600 px, so the cost per page does not change.` : "Unchanged."),
    change("verification.independentAnswer", "Independent answer opinion", yes(saved.verification.independentAnswer), yes(proposed.verification.independentAnswer), proposed.verification.independentAnswer !== saved.verification.independentAnswer ? "No verification model qualified, so it cannot run." : "Unchanged (it adds a request per question, so it is never switched on automatically)."),
    change("verification.secondReadBelow", "Second read below confidence", String(saved.verification.secondReadBelow), String(proposed.verification.secondReadBelow), "Unchanged."),
    change("budget.retryTransient", "Retry after a transient provider error", yes(saved.budget.retryTransient), yes(proposed.budget.retryTransient), "Unchanged. Failed pages are recovered with Retry failed pages (an explicit action); the rate-limit circuit breaker stays on."),
    change("aiEnabled", "Paid AI", yes(saved.aiEnabled), yes(proposed.aiEnabled), "Never changed here: Paid AI is switched separately by an administrator."),
    change("budget", "Budgets", `₹${saved.budget.maxRequestInr}/request, ₹${saved.budget.maxJobInr}/job, ₹${saved.budget.totalInr} all-time, ₹${saved.budget.monthlyInr}/month, $${saved.budget.keyReserveUsd} Ask AI reserve`, "unchanged", "Never raised (or reset) automatically; spending so far still counts."),
    change("privacy", "Privacy", `ZDR ${saved.privacy.zdr ? "required" : "not required"}, data collection ${saved.privacy.dataCollection}`, "unchanged", "Never changed automatically; every chosen model meets it."),
  ];

  const keep = (s: RouteSnapshot | null): RouteSnapshot | null => (s ? { ...s, models: Object.fromEntries(Object.entries(s.models).filter(([id]) => proposed.importerModels.includes(id))) } : null);
  const preview: AutoConfigPreview = {
    computedAt: new Date(now).toISOString(),
    method: "catalog",
    aiRequestsSent: 0,
    paidAiOn: saved.aiEnabled,
    paidAiText: saved.aiEnabled
      ? "Paid AI is ON (saved by an administrator). This configuration does not change it, and no AI request was sent to prepare it."
      : "Paid AI is OFF. This configuration does not switch it on; it can be saved now, and no AI request is sent until an administrator switches Paid AI on separately.",
    routesFetchedAt: fresh?.fetchedAt ?? null,
    routesError,
    fx: { rate: fxRate, date: ctx.catalog.fx.rateDate },
    tasks: taskRows,
    changes,
    jobCost,
    proposed,
    baselineKey: "",
    proposalKey: hash(proposed),
    blocking,
    untouched: ["Paid AI switch", "every budget limit and the spending so far", "privacy settings", "student Ask AI", "Instagram AI", "AI → Models approvals", "payments and Premium", "existing import jobs (each keeps its confirmed models)"],
  };
  return { preview, snapshot: keep(fresh) };
}

/** "AI Auto-Configure Everything": the preview for the SAVED settings (nothing is saved; no AI request). */
export async function previewAutoConfig(): Promise<AutoConfigPreview> {
  const raw = await savedRaw();
  const { preview } = await build(normalizeImporterSettings(raw));
  return { ...preview, baselineKey: baselineKeyOf(raw) };
}

/**
 * "Apply Configuration" after the administrator confirmed the preview. Re-reads routes and prices and
 * recomputes the proposal; saves only when the saved settings and the proposal are still exactly what
 * the preview showed. Settings, route snapshot and audit entry are written in one transaction.
 */
export async function applyAutoConfig(input: { baselineKey: string; proposalKey: string; actorId: string }): Promise<AutoConfigApplied> {
  const raw = await savedRaw();
  if (baselineKeyOf(raw) !== input.baselineKey) throw new AutoConfigError("Import Settings were changed since the preview was made. Nothing was saved — run AI Auto-Configure again.");
  const saved = normalizeImporterSettings(raw);
  const { preview, snapshot } = await build(saved);
  if (preview.blocking.length) throw new AutoConfigError(`Not saved — the re-check before saving failed: ${preview.blocking.join(" ")} The previous settings are unchanged.`);
  if (preview.proposalKey !== input.proposalKey) throw new AutoConfigError("Not saved — the re-check before saving found a different configuration (provider routes, prices, privacy routes or rate limits changed since the preview). The previous settings are unchanged; run AI Auto-Configure again to see the new proposal.");
  assertSafeProposal(saved, preview.proposed);
  const tasks = preview.tasks.map((t) => ({ task: t.task, label: t.label, model: t.model }));
  const auditId = await prisma.$transaction(async (tx) => {
    // Under a row lock: the settings must still be the previewed ones when they are replaced.
    await tx.$queryRaw`SELECT "key" FROM "Setting" WHERE "key" = ${IMPORTER_SETTING_KEY} FOR UPDATE`;
    if (baselineKeyOf(await savedRaw(tx)) !== input.baselineKey) throw new AutoConfigError("Import Settings were changed at the same moment. Nothing was saved — run AI Auto-Configure again.");
    await saveImporterSettings(preview.proposed, input.actorId, tx);
    if (snapshot) await storeRouteSnapshot(snapshot, tx);
    const audit = await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        action: "AI_IMPORTER_AUTOCONFIG_APPLIED",
        entityType: "Setting",
        entityId: IMPORTER_SETTING_KEY,
        metadata: JSON.parse(JSON.stringify({ method: "catalog", aiRequestsSent: 0, routesFetchedAt: preview.routesFetchedAt, before: saved, after: preview.proposed, changes: preview.changes.filter((c) => c.changed).map((c) => ({ key: c.key, from: c.current, to: c.proposed })), tasks })) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return audit.id;
  });
  return { savedAt: new Date().toISOString(), changes: preview.changes, tasks, auditId };
}
