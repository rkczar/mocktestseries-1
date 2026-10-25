import "server-only";
import crypto from "node:crypto";
import type { AiModel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveOpenRouterKey, getEngineConfig, patchOpenRouterState } from "@/lib/ai-engine/settings";
import { getUsdInr, type FxRate } from "@/lib/ai-engine/fx";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { formatInr, usdToInr } from "@/lib/ai-engine/config";
import { OpenRouterError, TRANSIENT_OPENROUTER_ERRORS, chatCompletion, describeCategory, getKeyInfo, sanitize, type ChatContentPart } from "@/lib/ai-engine/openrouter";
import { IMPORTER_SETTING_KEY, PILOT_LIMITS, SELECTION_TASK_LABELS, importerFeature, normalizeImporterSettings, type ImporterSettings, type ImporterTask, type SelectionTask } from "@/lib/ai-import/config";
import { FAILURE_ADVICE, failureMessage, kindOfCategory, type FailureKind } from "@/lib/ai-import/failure";
import { computeModelPlan, evaluateModel, planOf, requestUsd } from "@/lib/ai-import/select";
import { freshRouteSnapshot } from "@/lib/ai-import/routes";
import { importerModelHealth } from "@/lib/ai-import/health";
import type { ModelPlan, TaskChoice } from "@/lib/ai-import/selection-types";

/**
 * Every paid AI request of the AI Question Importer goes through here:
 *
 *   the job's confirmed model plan (lib/ai-import/select.ts; an unavailable
 *     model is replaced only by an equal or cheaper one unless Import Settings
 *     allow a pricier fallback) → worst-case cost → per-request ceiling
 *   → RESERVE against the job cap AND the importer's monthly budget
 *     (one advisory lock, so parallel pages can never overshoot)
 *   → OpenRouter (privacy policy enforced per request) → SETTLE to the
 *     provider-reported cost (unknown cost = worst case kept)
 *   → logged in AiImportAiCall (per job) and AiGatewayCall (platform usage).
 *
 * The importer budget is separate from the platform / student AI budgets
 * (lib/ai-engine/budget.ts excludes "qimport_*"). The OpenRouter key's own
 * limit is shared with student Ask AI, so before every request the key's
 * remaining credit is read and the request is refused unless the configured
 * reserve (budget.keyReserveUsd) would remain after its worst case.
 * One attempt per request unless budget.retryTransient is on.
 *
 * Immediately before each request is sent, the reservation (one transaction)
 * re-reads the AUTHORITATIVE importer settings and the job's status from the
 * database: with Paid AI switched off, or the job paused / cancelled
 * meanwhile, nothing is sent. A request already sent finishes and is recorded.
 * After RATE_LIMIT_STOP consecutive rate-limited answers in one job run, no
 * further request is sent for that job (ImporterRateLimited → paused).
 */

export class ImporterBudgetError extends Error {
  constructor(
    message: string,
    readonly scope: "job" | "month" | "total" | "request" | "key" | "overrun"
  ) {
    super(message);
    this.name = "ImporterBudgetError";
  }
}
export class ImporterAiUnavailable extends Error {}
/** The provider answered with an error, or the model's answer was unusable; `kind` says which (lib/ai-import/failure.ts). */
export class ImporterAiFailure extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind = "provider",
    /** The model that produced the failure (set by importerAiCall), and what that attempt was charged. */
    readonly model: string | null = null,
    readonly chargedInr: number | null = null
  ) {
    super(message);
  }
}
/** The job was paused, cancelled or deleted meanwhile: no request was sent (its own status says why). */
export class ImporterJobStopped extends ImporterAiUnavailable {}
/** Paid AI was switched off after the job started: no request was sent (the job pauses). */
export class ImporterAiSwitchedOff extends ImporterAiUnavailable {}
/** The provider rate-limited RATE_LIMIT_STOP requests in a row: nothing more is sent for the job (it pauses). */
export class ImporterRateLimited extends ImporterAiUnavailable {}

/** Consecutive rate-limited answers after which a job run sends nothing more (circuit breaker). */
export const RATE_LIMIT_STOP = 2;
/**
 * Consecutive rate-limited answers per job in this worker process. One worker leases a job at a time,
 * so the count is per run; processJob resets it when a run starts (a resumed job starts at 0).
 */
const rateLimitStreak = new Map<string, { n: number; model: string; detail: string }>();
export function resetRateLimitStreak(jobId: string): void {
  rateLimitStreak.delete(jobId);
}
function rateLimitStop(jobId: string): ImporterRateLimited {
  const s = rateLimitStreak.get(jobId)!;
  return new ImporterRateLimited(
    `${failureMessage("rate_limited", `the last ${s.n} requests to ${s.model} were refused by the provider (HTTP 429${s.detail ? `: ${s.detail}` : ""})`)} Processing paused and no further AI request was sent. Pages not yet read stay pending. ${FAILURE_ADVICE.rate_limited}`
  );
}

/** Importer budget advisory lock (every reservation holds it; a job reset takes it too). */
export const BUDGET_LOCK_KEY = 7_301_442_031;
const LOCK_KEY = BUDGET_LOCK_KEY;
/** A reservation older than this belongs to a killed worker (an importer request never runs this long). */
export const STALE_MS = 10 * 60_000;
/**
 * Conservative token allowance per image part. Page images are sent at most 1600 px on the long side
 * (figures.ts visionImage). Published per-image formulas stay below this for such an image:
 * Anthropic ≈ w·h/750 (≤ 3,414 even for a 1600×1600 square), Qwen-VL ≈ w·h/784, OpenAI high
 * detail ≤ 1,105, Gemini 258 per 768-px tile. A provider that bills more is caught after the call
 * (actual cost above the reservation pauses the job).
 */
export const IMAGE_TOKENS = 3_500;
/** OpenRouter max_price headroom over the catalog price; the worst-case reservation uses the same factor. */
export const PRICE_MARGIN = 1.05;
/**
 * The request parameters every importer request sends (importerAiCall → chatCompletion: max_tokens bounds the
 * cost, temperature 0). Requests use require_parameters, so a provider route must support all of them; the
 * selection engine (select.ts evaluateModel) only accepts routes that publish every one.
 */
export const IMPORTER_REQUEST_PARAMS = ["max_tokens", "temperature"] as const;

/** Fallbacks may never cost more than the preferred model (per prompt, completion, request and input-image price). */
export function notPricier(m: AiModel, preferred: AiModel): boolean {
  const out = (x: AiModel) => Math.max(x.completionPrice ?? 0, x.reasoningPrice ?? 0);
  return (m.promptPrice ?? 0) <= (preferred.promptPrice ?? 0) && out(m) <= out(preferred) && (m.requestPrice ?? 0) <= (preferred.requestPrice ?? 0) && (inputImagePriceUsd(m) ?? Infinity) <= (inputImagePriceUsd(preferred) ?? Infinity);
}

export interface AiCallInput {
  jobId: string;
  /** Internal: a model chosen at run time for this one request (output fallback); the plan is unchanged. */
  override?: TaskChoice;
  /**
   * Full-paper Verify 2: the override is the administrator's confirmed model and must not be swapped for another
   * one inside this call, nor written into the job's plan — an unusable model fails the request instead (the
   * caller applies its own bounded, recorded fallback). Every cost guard still applies.
   */
  noReplace?: boolean;
  task: ImporterTask;
  /** Informational: the call sites pass the plan's model; the request always uses job.config.modelPlan. */
  models: string[];
  system: string;
  content: ChatContentPart[];
  maxOutputTokens: number;
  settings: ImporterSettings;
  pageId?: string | null;
  questionId?: string | null;
  actorId?: string | null;
  needsVision: boolean;
}

export interface AiCallResult {
  text: string;
  model: string;
  costInr: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  fallbackUsed: boolean;
}

/**
 * OpenRouter `pricing.image` for input images (USD). Whether a model bills it per image or per image
 * token is not stated consistently (Gemini lists the same value as its per-token prompt price), so the
 * worst case assumes the larger reading: per image token, for IMAGE_TOKENS tokens, on top of the prompt
 * tokens. 0 when the model publishes no such price; null when a price is published but unusable.
 */
export function inputImagePriceUsd(m: Pick<AiModel, "pricingRaw">): number | null {
  const raw = (m.pricingRaw ?? {}) as Record<string, unknown>;
  if (raw.image === undefined || raw.image === null || raw.image === "") return 0;
  const v = typeof raw.image === "number" ? raw.image : typeof raw.image === "string" ? Number(raw.image) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Why a model cannot be used by the importer for a task (null = usable). Eligibility is the importer's
 * OWN list (Import Settings → Importer models), never the global AI → Models approval, so approving a
 * model for the importer cannot change any other AI feature's routing (and vice versa).
 */
export function modelProblem(m: AiModel | undefined, needsVision: boolean, importerModels: readonly string[]): string | null {
  if (!m) return "not in the model catalog (sync Admin → AI → Models)";
  if (!importerModels.includes(m.id)) return "not approved for the AI Question Importer (Import Settings → Importer models)";
  if (m.disabled) return "disabled";
  if (m.missingSince) return "no longer listed by OpenRouter";
  if (m.expirationDate && m.expirationDate <= new Date().toISOString().slice(0, 10)) return `expired ${m.expirationDate}`;
  if (m.promptPrice === null || m.completionPrice === null || m.promptPrice < 0 || m.completionPrice < 0) return "no fixed published price";
  if (!m.outputModalities.includes("text")) return "does not return text";
  if (needsVision && !m.inputModalities.includes("image")) return "cannot read images";
  if (needsVision && inputImagePriceUsd(m) === null) return "its per-image input price cannot be read, so a maximum cost cannot be set";
  return null;
}

export async function loadModels(ids: string[]): Promise<Map<string, AiModel>> {
  const rows = await prisma.aiModel.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((r) => [r.id, r]));
}

/** Worst-case USD of one call on the most expensive of the listed models (images: per-image price on top of their tokens). */
export function worstCaseUsd(models: AiModel[], inputTokens: number, maxOut: number, images = 0): number {
  let worst = 0;
  for (const m of models) {
    const out = Math.max(m.completionPrice ?? 0, m.reasoningPrice ?? 0);
    worst = Math.max(worst, inputTokens * (m.promptPrice ?? 0) + maxOut * out + (m.requestPrice ?? 0) + images * IMAGE_TOKENS * (inputImagePriceUsd(m) ?? 0));
  }
  return worst;
}

export function estimateInputTokens(system: string, content: ChatContentPart[]): number {
  let tokens = Math.ceil(system.length / 3);
  for (const p of content) tokens += p.type === "text" ? Math.ceil(p.text.length / 3) : IMAGE_TOKENS;
  return tokens + 50;
}

const SPEND = `COALESCE(SUM(COALESCE("settledInr", "reservedInr")), 0)::float8`;

async function reserve(input: { jobId: string; requestKey: string; feature: string; amountInr: number; settings: ImporterSettings; key: { remainingUsd: number | null; fxRate: number } }): Promise<void> {
  const { istDay, istMonth } = istDayMonth();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY}::bigint)`;
    // A request left RESERVED by a killed worker may have been billed: keep its worst case and charge it to its job.
    const stale = await tx.aiBudgetReservation.findMany({ where: { status: "RESERVED", feature: { startsWith: "qimport_" }, createdAt: { lt: new Date(Date.now() - STALE_MS) } } });
    for (const r of stale) {
      await tx.aiBudgetReservation.update({ where: { id: r.id }, data: { status: "SETTLED", settledInr: r.reservedInr, costKnown: false, settledAt: new Date() } });
      const staleJob = /^qi:([a-z0-9]+):/.exec(r.requestKey)?.[1];
      if (staleJob) await tx.aiImportJob.updateMany({ where: { id: staleJob }, data: { spentInr: { increment: r.reservedInr } } });
    }
    const job = await tx.aiImportJob.findUnique({ where: { id: input.jobId }, select: { status: true, budgetInr: true, spentInr: true } });
    if (!job) throw new ImporterJobStopped("The import job no longer exists.");
    // Cancelled, paused or deleted meanwhile: no new request is ever reserved (or sent) for it.
    if (job.status !== "PROCESSING") throw new ImporterJobStopped(`The import is ${job.status.toLowerCase().replace(/_/g, " ")}, so no AI request was sent.`);
    // The administrator's confirmed maximum for THIS job (budgetInr, set by Confirm / Reconfigure / a confirmed
    // retry) is never exceeded: recorded spend + this job's requests in flight + this request's worst case.
    // Not a fixed cap (owner decision 2026-10-20): going further only needs a renewed confirmation.
    const inFlight = await tx.$queryRaw<{ v: number }[]>`SELECT COALESCE(SUM("reservedInr"), 0)::float8 AS v FROM "AiBudgetReservation" WHERE "status" = 'RESERVED' AND "requestKey" LIKE ${`qi:${input.jobId}:%`}`;
    const committed = job.spentInr + (inFlight[0]?.v ?? 0);
    if (committed + input.amountInr > job.budgetInr + 0.005) {
      throw new ImporterBudgetError(
        job.budgetInr > 0
          ? `This request could cost up to ${formatInr(input.amountInr)}; with ${formatInr(committed)} already spent or in flight that would exceed the confirmed maximum of ${formatInr(job.budgetInr)} for this import. Nothing was sent. Review the cost and confirm a new maximum (Resume / Retry shows it) to continue.`
          : "No paid AI cost was confirmed for this import, so nothing was sent. Resume / Retry shows the cost to confirm first.",
        "job"
      );
    }
    // The authoritative settings, read now (not the copy the worker started with): an administrator who
    // switched Paid AI off or lowered a limit after the job started is obeyed before this request is sent.
    const row = await tx.setting.findUnique({ where: { key: IMPORTER_SETTING_KEY } });
    const current = normalizeImporterSettings(row?.value ?? {});
    if (!current.aiEnabled) throw new ImporterAiSwitchedOff(`${failureMessage("paid_ai_off", "it was switched off in Import Settings after this job started, so no further AI request was sent")} Pages not yet read stay pending. ${FAILURE_ADVICE.paid_ai_off}`);
    // There are no importer job / monthly / all-time spending caps (owner decision 2026-10-20): the administrator
    // confirms each job's cost. What remains is the per-request worst case and the shared key's Ask AI reserve.
    const budget = {
      maxRequestInr: Math.min(input.settings.budget.maxRequestInr, current.budget.maxRequestInr),
      keyReserveUsd: Math.max(input.settings.budget.keyReserveUsd, current.budget.keyReserveUsd),
    };
    const requestCap = Math.min(budget.maxRequestInr, PILOT_LIMITS.maxRequestInr);
    if (input.amountInr > requestCap) throw new ImporterBudgetError(`One request could cost up to ${formatInr(input.amountInr)}, above the per-request limit of ${formatInr(requestCap)}.`, "request");
    // The key's limit is shared with student Ask AI. Requests of other importer jobs still in flight are not
    // yet in the key's usage, so they are subtracted too (they hold this same lock while reserving).
    if (input.key.remainingUsd !== null) {
      const pending = await tx.$queryRawUnsafe<{ v: number }[]>(`SELECT COALESCE(SUM("reservedInr"), 0)::float8 AS v FROM "AiBudgetReservation" WHERE "status" = 'RESERVED' AND left("feature", 8) = 'qimport_'`);
      const pendingUsd = (pending[0]?.v ?? 0) / input.key.fxRate;
      const afterUsd = input.key.remainingUsd - pendingUsd - input.amountInr / input.key.fxRate;
      if (afterUsd < Math.max(budget.keyReserveUsd, PILOT_LIMITS.minKeyReserveUsd)) {
        throw new ImporterBudgetError(
          `The shared OpenRouter key has $${input.key.remainingUsd.toFixed(2)} left${pendingUsd > 0 ? ` ($${pendingUsd.toFixed(4)} of it held by importer requests in flight)` : ""}; this request could use up to $${(input.amountInr / input.key.fxRate).toFixed(4)}, which would leave less than the $${budget.keyReserveUsd.toFixed(2)} kept for student Ask AI (Import Settings).`,
          "key"
        );
      }
    }
    await tx.aiBudgetReservation.create({ data: { requestKey: input.requestKey, feature: input.feature, reservedInr: input.amountInr, istDay, istMonth } });
  });
}

/** Importer AI spend so far (₹, worst case held for unknown costs): all time and this IST month. */
export async function importerSpend(): Promise<{ allUsed: number; monthUsed: number }> {
  const { istMonth } = istDayMonth();
  const [all, month] = await Promise.all([
    prisma.$queryRawUnsafe<{ v: number }[]>(`SELECT ${SPEND} AS v FROM "AiBudgetReservation" WHERE "status" <> 'RELEASED' AND left("feature", 8) = 'qimport_'`),
    prisma.$queryRawUnsafe<{ v: number }[]>(`SELECT ${SPEND} AS v FROM "AiBudgetReservation" WHERE "istMonth" = $1 AND "status" <> 'RELEASED' AND left("feature", 8) = 'qimport_'`, istMonth),
  ]);
  return { allUsed: all[0]?.v ?? 0, monthUsed: month[0]?.v ?? 0 };
}

/**
 * Settles a reservation and adds the charge to the job (atomic increment; idempotent per request key).
 * `overrunInr` > 0 when the provider charged more than the reserved worst case: the charge is still
 * recorded in full (never hidden), and the caller stops the job.
 */
async function settle(jobId: string, requestKey: string, actualInr: number | null, actualUsd: number | null): Promise<{ charged: number; overrunInr: number }> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.aiBudgetReservation.findUnique({ where: { requestKey } });
    if (!r || r.status !== "RESERVED") return { charged: r?.settledInr ?? 0, overrunInr: 0 };
    const charge = actualInr ?? r.reservedInr;
    await tx.aiBudgetReservation.update({ where: { requestKey }, data: { status: "SETTLED", settledInr: charge, costKnown: actualInr !== null, settledAt: new Date() } });
    await tx.aiImportJob.update({ where: { id: jobId }, data: { spentInr: { increment: charge }, ...(actualUsd !== null ? { spentUsd: { increment: actualUsd } } : {}) } });
    return { charged: charge, overrunInr: Math.max(0, charge - r.reservedInr) };
  });
}

async function release(requestKey: string): Promise<void> {
  await prisma.aiBudgetReservation.updateMany({ where: { requestKey, status: "RESERVED" }, data: { status: "RELEASED", settledInr: 0, costKnown: true, settledAt: new Date() } });
}

async function log(e: {
  input: AiCallInput;
  requestId: string;
  attempt: number;
  model: string;
  requested: string;
  ok: boolean;
  latencyMs: number;
  fx: FxRate;
  estUsd: number;
  costUsd: number | null;
  chargedInr: number | null;
  costStatus: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  generationId?: string | null;
  errorCategory?: string | null;
  errorSummary?: string | null;
  fallbackUsed: boolean;
}) {
  const feature = importerFeature(e.input.task);
  await prisma.aiImportAiCall
    .create({
      data: {
        jobId: e.input.jobId,
        task: e.input.task,
        pageId: e.input.pageId ?? null,
        questionId: e.input.questionId ?? null,
        requestId: e.requestId,
        attempt: e.attempt,
        model: e.model.slice(0, 120),
        ok: e.ok,
        fallbackUsed: e.fallbackUsed,
        inputTokens: e.inputTokens ?? null,
        outputTokens: e.outputTokens ?? null,
        estCostInr: usdToInr(e.estUsd, e.fx.rate),
        costUsd: e.costUsd,
        costInr: e.chargedInr,
        costStatus: e.costStatus,
        fxRate: e.fx.rate,
        errorSummary: e.errorSummary ? sanitize(e.errorSummary).slice(0, 300) : null,
      },
    })
    .catch(() => undefined);
  await prisma.aiGatewayCall
    .create({
      data: {
        feature,
        provider: "openrouter",
        model: e.model.slice(0, 80),
        modelRequested: e.requested.slice(0, 80),
        kind: "text",
        routingMode: "manual",
        ok: e.ok,
        errorCategory: e.errorCategory ?? null,
        errorSummary: e.errorSummary ? sanitize(e.errorSummary).slice(0, 300) : null,
        latencyMs: e.latencyMs,
        inputTokens: e.inputTokens ?? null,
        outputTokens: e.outputTokens ?? null,
        estCostUsd: e.estUsd,
        estCostInr: usdToInr(e.estUsd, e.fx.rate),
        actualCostUsd: e.costUsd,
        actualCostInr: usdToInr(e.costUsd, e.fx.rate),
        fxRate: e.fx.rate,
        fxAt: e.fx.at,
        costStatus: e.costStatus,
        generationId: e.generationId ?? null,
        fallbackUsed: e.fallbackUsed,
        attempt: e.attempt,
        requestId: e.requestId,
        actorId: e.input.actorId ?? null,
      },
    })
    .catch(() => undefined);
}

/**
 * The provider route, price and privacy route of the model about to be used, checked with the selection
 * engine's own rules (serving route, ZDR when required, readable prices, output limit, per-request limit).
 * Route data that cannot be read means nothing is sent (fail closed).
 */
async function recheckRoute(jobId: string, choice: TaskChoice, model: AiModel | undefined, settings: ImporterSettings, fxRate: number): Promise<{ problem: string | null; price: TaskChoice["price"]; reasoning: boolean }> {
  let snapshot;
  try {
    snapshot = await freshRouteSnapshot(settings.importerModels.includes(choice.model!) ? settings.importerModels : [...settings.importerModels, choice.model!]);
  } catch (e) {
    throw new ImporterAiUnavailable(`The provider route of ${choice.model} could not be re-checked before the request (${e instanceof Error ? sanitize(e.message).slice(0, 160) : "error"}). Nothing was sent.`);
  }
  const refusals = await importerModelHealth([choice.model!], Date.now(), jobId);
  const ev = evaluateModel(model, choice.model!, choice.task, { snapshot, settings, fxRate, refusals });
  // A usable route over the per-request limit (the only refusal that still carries a price) is left to the
  // reservation below, so it stops as a budget limit (page kept, questions capped) instead of "unavailable".
  return ev.row.eligible || ev.price ? { problem: null, price: ev.price, reasoning: !!ev.reasoning } : { problem: ev.row.reason ?? "not usable", price: null, reasoning: false };
}

const SELECTION_TASK_OF: Record<ImporterTask, SelectionTask> = { analyze: "extract", extract: "extract", verify: "verify", key: "key", classify: "classify" };
/** Provider answers that mean "this model cannot be served under these constraints" (never billed). */
const UNAVAILABLE_ERRORS = ["no_endpoint", "model_unavailable"];

/**
 * The confirmed model of `task` is unavailable: choose again with the job's settings, excluding it.
 * A cheaper or equally priced replacement is used (and recorded); a more expensive one only when
 * Import Settings allow it. Otherwise the job stops with the reason (ImporterAiUnavailable → paused).
 */
async function replaceModel(input: AiCallInput, plan: ModelPlan, choice: TaskChoice, why: string, tried: string[], refusedByProvider = false): Promise<TaskChoice> {
  const sel = choice.task;
  const label = SELECTION_TASK_LABELS[sel].toLowerCase();
  // Page reading and verification stay independent: a replacement is never the job's model for the other one.
  const other = sel === "verify" ? plan.tasks.extract.model : sel === "extract" ? plan.tasks.verify.model : null;
  const exclude: Partial<Record<SelectionTask, string[]>> = { [sel]: other ? [...tried, other] : tried };
  const fresh = await computeModelPlan(input.settings, { refresh: true, jobId: input.jobId }, exclude);
  const alt = fresh.tasks[sel];
  const failed = choice.model!;
  // Honest about what happened: a refused request reached OpenRouter but no model ran and nothing was charged.
  const sent = refusedByProvider ? "OpenRouter refused the request before any model ran; no AI cost was charged." : "Nothing was sent.";
  if (!alt.model) {
    let advice = "";
    if (input.settings.selection.mode === "manual") {
      // Guidance only (nothing is changed or sent): what Reconfigure Models for This Job would propose.
      // No run-time exclusions: the same proposal the Reconfigure preview computes (a refused model is excluded by the job's history).
      const sub = (await computeModelPlan(input.settings, { refresh: false, substitute: true, jobId: input.jobId })).tasks[sel];
      advice = sub.model && sub.model !== failed ? ` Use Reconfigure Models for This Job: it would propose ${sub.model} (up to ${formatInr(sub.maxInr)} per request) and shows the cost before anything is saved.` : " No other model on the importer's list is suitable either: add an image-capable model with a verified route and a known price within the per-request limit (Import Settings → AI Auto-Configure), then use Reconfigure Models for This Job.";
    }
    throw new ImporterAiUnavailable(`The selected ${label} model ${failed} is unavailable (${why}) and no other approved model is suitable: ${alt.reason} ${sent}${advice}`);
  }
  const pricier = (alt.maxInr ?? Infinity) > (choice.maxInr ?? 0) + 1e-9;
  if (pricier && !input.settings.budget.allowPricierFallback) {
    throw new ImporterAiUnavailable(`The selected ${label} model ${failed} is unavailable (${why}). The next suitable model, ${alt.model}, could cost up to ${formatInr(alt.maxInr)} per request instead of ${formatInr(choice.maxInr)}; more expensive fallbacks are OFF in Import Settings, so processing stopped. ${sent} Use Reconfigure Models for This Job to review it with its cost.`);
  }
  return persistReplacement(input.jobId, sel, failed, choice, alt, why, pricier);
}

/**
 * How much more one fallback request may cost than the job's model without "more expensive fallbacks" switched on:
 * at most 50 % or ₹0.10 more per request (whichever is larger) — 2026-10-24: a ₹0.05 fallback was refused for being a
 * fraction of a paisa above a ₹0.05 model, leaving 17 questions unclassified.
 */
export const FALLBACK_SLACK = { ratio: 1.5, inr: 0.1 } as const;

/**
 * Whether a slightly more expensive fallback may be used: within FALLBACK_SLACK of the job's model, within the
 * per-request limit, and within what is left of the job's confirmed maximum (spent + in flight + this request).
 * The reservation before the request checks all of it again (key reserve included); this only decides whether to try.
 */
export async function fallbackAllowance(jobId: string, primaryMaxInr: number | null, altMaxInr: number | null, settings: ImporterSettings): Promise<{ ok: boolean; reason: string }> {
  if (altMaxInr === null || primaryMaxInr === null) return { ok: false, reason: "its price is unknown" };
  const slack = Math.max(primaryMaxInr * FALLBACK_SLACK.ratio, primaryMaxInr + FALLBACK_SLACK.inr);
  if (altMaxInr > slack + 1e-9) return { ok: false, reason: `more than slightly more expensive (allowed up to ${formatInr(slack)} without the setting)` };
  const cap = Math.min(settings.budget.maxRequestInr, PILOT_LIMITS.maxRequestInr);
  if (altMaxInr > cap + 1e-9) return { ok: false, reason: `above the per-request limit of ${formatInr(cap)}` };
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { budgetInr: true, spentInr: true } });
  if (!job) return { ok: false, reason: "the import no longer exists" };
  const inFlight = await prisma.$queryRaw<{ v: number }[]>`SELECT COALESCE(SUM("reservedInr"), 0)::float8 AS v FROM "AiBudgetReservation" WHERE "status" = 'RESERVED' AND "requestKey" LIKE ${`qi:${jobId}:%`}`;
  const left = job.budgetInr - job.spentInr - (inFlight[0]?.v ?? 0);
  if (altMaxInr > left + 0.005) return { ok: false, reason: `only ${formatInr(Math.max(0, left))} is left of this import's confirmed maximum` };
  return { ok: true, reason: "" };
}

/** Makes `alt` the job's model for `sel` from now on (recorded as MODEL_REPLACED). */
async function persistReplacement(jobId: string, sel: SelectionTask, failed: string, choice: TaskChoice, alt: TaskChoice, why: string, pricier: boolean, unusable = false): Promise<TaskChoice> {
  const replaced: TaskChoice = { ...alt, replaced: { from: failed, at: new Date().toISOString(), why: why.slice(0, 200) } };
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ config: unknown }[]>`SELECT "config" FROM "AiImportJob" WHERE "id" = ${jobId} FOR UPDATE`;
    const config = (locked[0]?.config ?? {}) as Record<string, unknown>;
    const current = planOf(config);
    if (!current) return;
    await tx.aiImportJob.update({ where: { id: jobId }, data: { config: { ...config, modelPlan: { ...current, tasks: { ...current.tasks, [sel]: replaced } } } as unknown as Prisma.InputJsonValue } });
    await tx.aiImportEvent.create({
      data: {
        jobId,
        type: "MODEL_REPLACED",
        message: `${SELECTION_TASK_LABELS[sel]}: ${failed} ${unusable ? "gave unusable answers" : "is unavailable"} (${why.slice(0, 160)}); now using ${alt.model} (up to ${formatInr(alt.maxInr)} per request, was ${formatInr(choice.maxInr)})${pricier ? " — MORE EXPENSIVE, allowed by Import Settings" : ""}.`.slice(0, 1000),
        data: { task: sel, from: failed, to: alt.model, fromMaxInr: choice.maxInr, toMaxInr: alt.maxInr, pricier, reason: why.slice(0, 300) },
      },
    });
  });
  return replaced;
}

/**
 * One priced, budgeted, privacy-constrained OpenRouter request, made with the model the job's frozen
 * plan chose for this task (job.config.modelPlan). Throws ImporterBudgetError (job pauses, nothing
 * sent), ImporterAiUnavailable (configuration / no affordable model), or ImporterAiFailure (provider
 * failed after its retry).
 */
export async function importerAiCall(input: AiCallInput): Promise<AiCallResult> {
  if (!input.settings.aiEnabled) throw new ImporterAiUnavailable("Paid AI processing is switched off in Import Settings.");
  if ((rateLimitStreak.get(input.jobId)?.n ?? 0) >= RATE_LIMIT_STOP) throw rateLimitStop(input.jobId);
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId }, select: { config: true } });
  const plan = planOf(job?.config);
  if (!plan && !(input.override && input.noReplace)) throw new ImporterAiUnavailable("This job has no confirmed model plan. Nothing was sent.");
  let choice = input.override ?? plan!.tasks[SELECTION_TASK_OF[input.task]];
  if (!choice?.model) throw new ImporterAiUnavailable(`No model can be used for ${input.task}: ${choice?.reason ?? "not planned"}`);
  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) throw new ImporterAiUnavailable("OpenRouter is not configured or is disabled (Admin → AI → Providers).");
  const engine = await getEngineConfig();
  if (engine.budgets.emergencyStop) throw new ImporterAiUnavailable("AI generation is stopped by the AI emergency stop (Admin → AI → Budgets).");
  const fx = await getUsdInr();
  if (fx.rate === null) throw new ImporterAiUnavailable(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate"}. Nothing was sent.`);

  const tried: string[] = [];
  let reasoningRoutes = false;
  // The confirmed model, still approved and usable now? (An admin may have withdrawn it meanwhile.)
  // Then its provider route, price and privacy route, re-checked before this request (stored route data,
  // read again from OpenRouter when older than 6 h; free metadata, never an AI request).
  for (;;) {
    const catalog = await loadModels([choice.model!, ...choice.fallbacks]);
    const p = modelProblem(catalog.get(choice.model!), input.needsVision, input.settings.importerModels);
    if (p) {
      if (input.noReplace) throw new ImporterAiFailure(failureMessage("route_unavailable", `${choice.model} cannot be used now: ${p}. Nothing was sent`), "route_unavailable", choice.model);
      tried.push(choice.model!);
      choice = await replaceModel(input, plan!, choice, p, tried);
      continue;
    }
    const route = await recheckRoute(input.jobId, choice, catalog.get(choice.model!), input.settings, fx.rate);
    if (route.problem === null) {
      reasoningRoutes = route.reasoning;
      // Never below the confirmed price: the higher of the confirmed and the current price is reserved.
      if (route.price && choice.price) choice = { ...choice, price: { prompt: Math.max(choice.price.prompt, route.price.prompt), completion: Math.max(choice.price.completion, route.price.completion), image: Math.max(choice.price.image, route.price.image), request: Math.max(choice.price.request, route.price.request) } };
      break;
    }
    if (input.noReplace) throw new ImporterAiFailure(failureMessage("route_unavailable", `${choice.model}: route re-check: ${route.problem}. Nothing was sent`), "route_unavailable", choice.model);
    tried.push(choice.model!);
    choice = await replaceModel(input, plan!, choice, `route re-check: ${route.problem}`, tried);
  }

  const inputTokens = estimateInputTokens(input.system, input.content);
  const images = input.content.filter((p) => p.type === "image_url").length;
  const priced = (c: TaskChoice) => {
    if (!c.price) throw new ImporterAiUnavailable(`The price of ${c.model} could not be established. Nothing was sent.`);
    const worstUsd = requestUsd(c.price, inputTokens, input.maxOutputTokens, images) * PRICE_MARGIN;
    return { price: c.price, worstUsd, worstInr: usdToInr(worstUsd, fx.rate)!, typicalUsd: requestUsd(c.price, inputTokens, Math.round(input.maxOutputTokens * 0.4), images) };
  };
  let cost = priced(choice);
  // The key's limit is shared with student Ask AI: keep the configured reserve untouched (fail closed).
  // A key without a credit limit gives no way to guarantee that reserve, so it is refused too.
  const keyInfo = await getKeyInfo(apiKey).catch(() => null);
  if (!keyInfo) throw new ImporterAiUnavailable("The OpenRouter key's remaining credit could not be read, so nothing was sent.");
  if (keyInfo.limit_remaining === null) {
    throw new ImporterBudgetError(`The shared OpenRouter key has no credit limit, so the $${input.settings.budget.keyReserveUsd.toFixed(2)} kept for student Ask AI cannot be guaranteed. Nothing was sent — set a limit on the key at OpenRouter.`, "key");
  }
  const requestId = crypto.randomUUID();
  const feature = importerFeature(input.task);

  let lastError: OpenRouterError | null = null;
  // One attempt; at most ONE retry, only after a transient error (any, when enabled; a dropped connection —
  // "terminated" — always) — never a loop, never after a timeout.
  const attempts = 2;
  let replacements = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const requestCap = Math.min(input.settings.budget.maxRequestInr, PILOT_LIMITS.maxRequestInr);
    if (cost.worstInr > requestCap) {
      throw new ImporterBudgetError(`One ${input.task} request could cost up to ${formatInr(cost.worstInr)}, above the per-request limit of ${formatInr(requestCap)}.`, "request");
    }
    const requested = choice.model!;
    const requestKey = `qi:${input.jobId}:${requestId}:${attempt}${replacements ? `r${replacements}` : ""}`;
    await reserve({ jobId: input.jobId, requestKey, feature, amountInr: cost.worstInr, settings: input.settings, key: { remainingUsd: keyInfo.limit_remaining, fxRate: fx.rate } });
    const started = Date.now();
    try {
      const r = await chatCompletion({
        apiKey,
        models: [requested, ...choice.fallbacks],
        prompt: "",
        system: input.system,
        content: input.content,
        maxTokens: input.maxOutputTokens,
        temperature: 0,
        // A reasoning model can spend the whole output limit thinking and return no answer (seen 2026-10-20:
        // 8,000 tokens, empty text). Low effort keeps room for the answer; sent whenever a route of the model accepts
        // the parameter (requests use require_parameters, so only such routes are used) — also when fallbacks are
        // configured (2026-10-25: Verify 2 had a fallback, so the bound was left out and 12 reads were cut off).
        ...(reasoningRoutes ? { reasoning: { effort: "low" as const, exclude: true } } : {}),
        provider: {
          // The highest prompt / completion price the plan was confirmed with: no route above it is used.
          max_price: { prompt: cost.price.prompt * 1e6 * PRICE_MARGIN, completion: cost.price.completion * 1e6 * PRICE_MARGIN },
          data_collection: input.settings.privacy.dataCollection,
          ...(input.settings.privacy.zdr ? { zdr: true } : {}),
          allow_fallbacks: true,
          // Only routes that honour every parameter sent (max_tokens bounds the cost).
          require_parameters: true,
        },
        timeoutMs: 150_000,
      });
      const actualInr = r.costUsd !== null ? usdToInr(r.costUsd, fx.rate) : null;
      const { charged, overrunInr } = await settle(input.jobId, requestKey, actualInr, r.costUsd);
      const fallbackUsed = !!choice.replaced || (r.model !== requested && !r.model.startsWith(`${requested}-`));
      const empty = !r.text.trim();
      // Cut off at the output limit — also when the text is empty because the model's reasoning used the whole
      // limit (provider reports finish_reason "length", or the output tokens reach the limit). Checked before "empty".
      const truncated = r.finishReason === "length" || (empty && r.outputTokens !== null && r.outputTokens >= input.maxOutputTokens * 0.98);
      const outputProblem = truncated
        ? empty
          ? `the model used its whole output limit of ${input.maxOutputTokens} tokens (reasoning) and returned no answer — cut off at the token limit`
          : "the model's answer was cut off at the output limit"
        : empty
          ? describeCategory("empty_response")
          : null;
      await log({ input, requestId, attempt, model: r.model, requested, ok: !outputProblem, latencyMs: Date.now() - started, fx, estUsd: cost.typicalUsd, costUsd: r.costUsd, chargedInr: charged, costStatus: r.costUsd !== null ? "actual" : "unknown", inputTokens: r.inputTokens, outputTokens: r.outputTokens, generationId: r.generationId, fallbackUsed, errorCategory: truncated ? "truncated" : empty ? "empty_response" : null, errorSummary: outputProblem });
      await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
      rateLimitStreak.delete(input.jobId);
      if (overrunInr > 0) {
        throw new ImporterBudgetError(`A ${input.task} request cost ${formatInr(charged)}, more than its reserved maximum of ${formatInr(cost.worstInr)} (the provider billed more than the conservative bound). The charge is recorded in full and the job is paused — review the Cost Center before resuming.`, "overrun");
      }
      if (outputProblem) throw new ImporterAiFailure(failureMessage("model_output", outputProblem), "model_output", r.model, charged);
      return { text: r.text, model: r.model, costInr: charged, inputTokens: r.inputTokens, outputTokens: r.outputTokens, fallbackUsed };
    } catch (error) {
      if (error instanceof ImporterAiFailure || error instanceof ImporterBudgetError || error instanceof ImporterAiUnavailable) throw error;
      const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
      lastError = e;
      const billedUnknown = e.category === "timeout" || e.generationId !== null;
      const charged = billedUnknown ? (await settle(input.jobId, requestKey, null, null)).charged : (await release(requestKey), 0);
      await log({ input, requestId, attempt, model: requested, requested, ok: false, latencyMs: Date.now() - started, fx, estUsd: cost.typicalUsd, costUsd: null, chargedInr: charged, costStatus: billedUnknown ? "unknown" : "none", generationId: e.generationId, errorCategory: e.category, errorSummary: e.message, fallbackUsed: false });
      await patchOpenRouterState({ lastError: { category: e.category, message: sanitize(e.message), at: new Date().toISOString() } });
      if (e.category === "rate_limited") {
        const n = (rateLimitStreak.get(input.jobId)?.n ?? 0) + 1;
        rateLimitStreak.set(input.jobId, { n, model: requested, detail: sanitize(e.message).slice(0, 120) });
        // The breaker trips on this answer: this request's page stays pending, like every page not yet read.
        if (n >= RATE_LIMIT_STOP) throw rateLimitStop(input.jobId);
      } else rateLimitStreak.delete(input.jobId);
      // No route can serve the model under the privacy / price constraints: choose again (never silently pricier).
      if (UNAVAILABLE_ERRORS.includes(e.category) && !billedUnknown && replacements === 0 && !input.noReplace) {
        tried.push(requested);
        // OpenRouter's own words (e.g. "can handle the requested parameters"), not only the generic category text.
        choice = await replaceModel(input, plan!, choice, `OpenRouter: ${sanitize(e.message).slice(0, 160)}`, tried, true);
        cost = priced(choice);
        replacements++;
        attempt--;
        continue;
      }
      if (!TRANSIENT_OPENROUTER_ERRORS.includes(e.category)) break;
      if (!input.settings.budget.retryTransient && !DROPPED_CONNECTION.test(e.message)) break;
    }
  }
  const kind = kindOfCategory(lastError!.category, lastError!.message);
  throw new ImporterAiFailure(failureMessage(kind, `OpenRouter failed: ${describeCategory(lastError!.category)}${lastError!.message !== describeCategory(lastError!.category) ? ` (${sanitize(lastError!.message).slice(0, 160)})` : ""}`), kind, choice.model);
}

/** A connection the provider dropped mid-request (2026-10-23: "OpenRouter returned an error. (terminated)"): retried once. */
export const DROPPED_CONNECTION = /\bterminated\b|ECONNRESET|socket hang up|other side closed/i;

/** Failures after which the same request is sent once more to a different model (the answer, not the request, was unusable). */
const SWITCH_KINDS: FailureKind[] = ["model_output", "image_unsupported"];
/** Unusable answers in a row from the job's model for a task after which the switch is kept for the rest of the job. */
export const OUTPUT_FAILURE_PERSIST = 2;
const outputFailures = new Map<string, { model: string; n: number }>();
export function resetOutputFailures(jobId: string): void {
  for (const k of outputFailures.keys()) if (k.startsWith(`${jobId}:`)) outputFailures.delete(k);
}

/**
 * The model one failed request is sent to instead: chosen by the same selection engine (importer list, vision,
 * routes, privacy, per-request limit; not the failed model, and for page reading / verification not the other
 * one), never more expensive per request unless Import Settings allow pricier fallbacks. Null + reason when none.
 */
export async function outputFallback(input: AiCallInput, plan: ModelPlan, failed: string): Promise<{ alt: TaskChoice | null; reason: string; pricier: boolean }> {
  const sel = SELECTION_TASK_OF[input.task];
  const choice = plan.tasks[sel];
  const other = sel === "verify" ? plan.tasks.extract.model : sel === "extract" ? plan.tasks.verify.model : null;
  const fresh = await computeModelPlan(input.settings, { refresh: false, substitute: true, jobId: input.jobId }, { [sel]: [failed, ...(other ? [other] : [])] });
  let alt = fresh.tasks[sel];
  if (!alt.model || alt.model === failed || alt.model === other) return { alt: null, reason: `no other approved model is suitable (${alt.reason.slice(0, 200)})`, pricier: false };
  // A model of ANOTHER family is preferred (the same family tends to fail the same way, e.g. malformed JSON): the
  // cheapest eligible one within the same price allowance, else the cheapest suitable model as before.
  const family = (id: string) => id.split("/")[0];
  const cross = fresh.tasks[sel].candidates.find((c) => c.eligible && c.id !== failed && c.id !== other && family(c.id) !== family(failed));
  if (cross && family(alt.model) === family(failed) && (cross.maxInr ?? Infinity) <= (alt.maxInr ?? Infinity) * FALLBACK_SLACK.ratio + 1e-9) {
    const priced = await computeModelPlan({ ...input.settings, selection: { ...input.settings.selection, mode: "auto" } }, { refresh: false, jobId: input.jobId }, { [sel]: fresh.tasks[sel].candidates.filter((c) => c.id !== cross.id).map((c) => c.id) });
    if (priced.tasks[sel].model === cross.id) alt = priced.tasks[sel];
  }
  const pricier = (alt.maxInr ?? Infinity) > (choice.maxInr ?? 0) + 1e-9;
  if (pricier && !input.settings.budget.allowPricierFallback) {
    const allowance = await fallbackAllowance(input.jobId, choice.maxInr, alt.maxInr, input.settings);
    if (!allowance.ok) return { alt: null, reason: `the next suitable model, ${alt.model}, could cost up to ${formatInr(alt.maxInr)} per request instead of ${formatInr(choice.maxInr)}; ${allowance.reason}, and more expensive fallbacks are OFF in Import Settings`, pricier };
  }
  return { alt, reason: alt.reason, pricier };
}

/**
 * importerAiCall + validation of the answer (`parse` throws ImporterAiFailure "model_output" when the answer is
 * unusable). After an unusable answer (empty, cut off, malformed, wrong shape) or a model that cannot read the
 * image, the SAME request is sent ONCE to a different suitable model (outputFallback) — bounded, priced, reserved
 * and recorded like any request (MODEL_SWITCHED event: models, reason, cost of the failed attempt). After
 * OUTPUT_FAILURE_PERSIST unusable answers in a row from the job's model, the replacement is kept for the job
 * (MODEL_REPLACED). Never retried in a loop: if the second model fails too, the failure is reported.
 */
export async function importerAiCallChecked<T>(input: AiCallInput, parse: (text: string) => T): Promise<{ value: T; result: AiCallResult }> {
  const sel = SELECTION_TASK_OF[input.task];
  const streakKey = `${input.jobId}:${sel}`;
  try {
    const result = await importerAiCall(input);
    const value = parse(result.text);
    outputFailures.delete(streakKey);
    return { value, result };
  } catch (e) {
    if (!(e instanceof ImporterAiFailure) || !SWITCH_KINDS.includes(e.kind) || input.override) throw e;
    const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId }, select: { config: true } });
    const plan = planOf(job?.config);
    const failed = e.model ?? plan?.tasks[sel].model ?? null;
    if (!plan || !failed) throw e;
    const fb = await outputFallback(input, plan, failed);
    const label = SELECTION_TASK_LABELS[sel];
    const where = input.pageId ? " (page request)" : input.questionId ? " (question request)" : "";
    if (!fb.alt) {
      await prisma.aiImportEvent.create({ data: { jobId: input.jobId, type: "MODEL_SWITCH_SKIPPED", message: `${label}: ${failed} gave an unusable answer${where} (${e.message.slice(0, 200)}); not sent to another model: ${fb.reason}.`.slice(0, 1000), data: { task: sel, from: failed, reason: e.message.slice(0, 300), pageId: input.pageId ?? null, questionId: input.questionId ?? null, failedChargedInr: e.chargedInr, pricier: fb.pricier } } }).catch(() => undefined);
      throw new ImporterAiFailure(`${e.message} No other model was tried: ${fb.reason}.`.slice(0, 600), e.kind, failed, e.chargedInr);
    }
    await prisma.aiImportEvent.create({ data: { jobId: input.jobId, type: "MODEL_SWITCHED", message: `${label}: ${failed} gave an unusable answer${where} (${e.message.slice(0, 200)}); the same request is sent once to ${fb.alt.model} (up to ${formatInr(fb.alt.maxInr)} per request, was ${formatInr(plan.tasks[sel].maxInr)})${fb.pricier ? " — MORE EXPENSIVE, allowed by Import Settings" : ""}. The failed attempt cost ${e.chargedInr === null ? "an unknown amount (worst case kept)" : formatInr(e.chargedInr)}.`.slice(0, 1000), data: { task: sel, from: failed, to: fb.alt.model, reason: e.message.slice(0, 300), attempt: 2, pageId: input.pageId ?? null, questionId: input.questionId ?? null, failedChargedInr: e.chargedInr, fromMaxInr: plan.tasks[sel].maxInr, toMaxInr: fb.alt.maxInr, pricier: fb.pricier } } }).catch(() => undefined);
    const result = await importerAiCall({ ...input, override: fb.alt });
    const value = parse(result.text);
    const prev = outputFailures.get(streakKey);
    const n = prev && prev.model === failed ? prev.n + 1 : 1;
    outputFailures.set(streakKey, { model: failed, n });
    if (n >= OUTPUT_FAILURE_PERSIST && plan.tasks[sel].model === failed) {
      await persistReplacement(input.jobId, sel, failed, plan.tasks[sel], fb.alt, `${n} unusable answers in a row (latest: ${e.message.slice(0, 120)})`, fb.pricier, true);
      outputFailures.delete(streakKey);
    }
    return { value, result };
  }
}

/** Parses a model's JSON answer (tolerates a ```json fence; nothing else). */
export function parseModelJson(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ImporterAiFailure(failureMessage("model_output", "the model did not return JSON"), "model_output");
  const json = body.slice(start, end + 1);
  try {
    return JSON.parse(json);
  } catch {
    // Two mechanical slips small models make, repaired without touching the content: a comma before a closing
    // bracket, and a LaTeX backslash that is not a JSON escape (e.g. a single backslash before "alpha").
    // Anything else (a cut-off answer, unbalanced brackets) stays an error.
    try {
      return JSON.parse(repairJson(json));
    } catch {
      throw new ImporterAiFailure(failureMessage("model_output", "the model returned malformed JSON"), "model_output");
    }
  }
}

/** Removes trailing commas and doubles backslashes that do not start a valid JSON escape (outside and inside strings). */
export function repairJson(json: string): string {
  // Valid escape pairs are consumed first, so an already-escaped backslash pair is never split.
  return json.replace(/\\(["\\/bfnrtu])|\\/g, (m, esc: string | undefined) => (esc ? m : "\\\\")).replace(/,\s*([}\]])/g, "$1");
}
