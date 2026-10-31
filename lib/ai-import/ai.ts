import "server-only";
import crypto from "node:crypto";
import type { AiModel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveOpenRouterKey, getEngineConfig, patchOpenRouterState } from "@/lib/ai-engine/settings";
import { getUsdInr, type FxRate } from "@/lib/ai-engine/fx";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { formatInr, usdToInr } from "@/lib/ai-engine/config";
import { OpenRouterError, TRANSIENT_OPENROUTER_ERRORS, chatCompletion, describeCategory, sanitize, type ChatContentPart } from "@/lib/ai-engine/openrouter";
import { IMPORTER_SETTING_KEY, SELECTION_TASK_LABELS, importerFeature, normalizeImporterSettings, type ImporterSettings, type ImporterTask, type SelectionTask } from "@/lib/ai-import/config";
import { FAILURE_ADVICE, failureMessage, kindOfCategory, type FailureKind } from "@/lib/ai-import/failure";
import { computeModelPlan, evaluateModel, planOf, requestUsd } from "@/lib/ai-import/select";
import { OUTPUT_SCHEMAS, type OutputSchemaName } from "@/lib/ai-import/output-schemas";
import { freshRouteSnapshot } from "@/lib/ai-import/routes";
import { importerModelHealth } from "@/lib/ai-import/health";
import type { ModelPlan, TaskChoice } from "@/lib/ai-import/selection-types";

/**
 * Every paid AI request of the AI Question Importer goes through here:
 *
 *   the job's confirmed model plan (lib/ai-import/select.ts; an unavailable
 *     model is replaced by the next suitable configured model) → worst-case cost
 *   → RESERVE (records the worst case for cost tracking; one advisory lock)
 *   → OpenRouter (privacy policy, max_price and route re-check enforced per
 *     request) → SETTLE to the provider-reported cost (unknown cost = worst case kept)
 *   → logged in AiImportAiCall (per job) and AiGatewayCall (platform usage).
 *
 * No application spending cap stops a request (owner decision 2026-10-26: no
 * per-request, job, monthly, all-time or key-reserve threshold). The administrator
 * confirms each operation's estimate and maximum once; that maximum prices every
 * send the operation can make (retries and fallbacks included). What still stops
 * requests: Paid AI switched off, the AI emergency stop, provider refusals and
 * errors (credits exhausted at OpenRouter pauses the job with the reason).
 * At most REQUEST_ATTEMPTS sends per request: one retry after a dropped connection always, after any
 * transient error only when budget.retryTransient is on. Every confirmed maximum prices both.
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
 * How many times one importer request can be sent (ai.ts importerAiCall: the first send plus at most ONE retry —
 * always after a dropped connection). Every estimate / confirmed maximum prices this many sends per request, so a
 * retry never pushes an operation past the maximum the administrator confirmed.
 */
export const REQUEST_ATTEMPTS = 2;
/**
 * The request parameters every importer request sends (importerAiCall → chatCompletion: max_tokens bounds the
 * cost). Requests use require_parameters, so a provider route must support all of them; the selection engine
 * (select.ts evaluateModel) only accepts routes that publish every one. `temperature` (0) is optional: it is sent
 * only when EVERY eligible route of the model accepts it (so it never removes a route), and left out otherwise —
 * some models (e.g. anthropic/claude-haiku-5.5) publish no route that accepts it (2026-10-31).
 */
export const IMPORTER_REQUEST_PARAMS = ["max_tokens"] as const;

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
  /** The answer's shape (lib/ai-import/output-schemas.ts): sent as a JSON Schema / JSON mode where the route supports it. */
  jsonSchema?: OutputSchemaName;
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

async function reserve(input: { jobId: string; requestKey: string; feature: string; amountInr: number }): Promise<void> {
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
    // The authoritative settings, read now (not the copy the worker started with): an administrator who
    // switched Paid AI off or lowered a limit after the job started is obeyed before this request is sent.
    const row = await tx.setting.findUnique({ where: { key: IMPORTER_SETTING_KEY } });
    const current = normalizeImporterSettings(row?.value ?? {});
    if (!current.aiEnabled) throw new ImporterAiSwitchedOff(`${failureMessage("paid_ai_off", "it was switched off in Import Settings after this job started, so no further AI request was sent")} Pages not yet read stay pending. ${FAILURE_ADVICE.paid_ai_off}`);
    // No application spending cap (owner decision 2026-10-26): no per-request, job, monthly, all-time or key-reserve
    // threshold stops a request. The reservation only records the request's worst case for cost tracking.
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
 * engine's own rules (serving route, ZDR when required, readable prices, output limit).
 * Route data that cannot be read means nothing is sent (fail closed).
 */
async function recheckRoute(jobId: string, choice: TaskChoice, model: AiModel | undefined, settings: ImporterSettings, fxRate: number): Promise<{ problem: string | null; price: TaskChoice["price"]; reasoning: boolean; structured: boolean; jsonMode: boolean; temperature: boolean }> {
  let snapshot;
  try {
    snapshot = await freshRouteSnapshot(settings.importerModels.includes(choice.model!) ? settings.importerModels : [...settings.importerModels, choice.model!]);
  } catch (e) {
    throw new ImporterAiUnavailable(`The provider route of ${choice.model} could not be re-checked before the request (${e instanceof Error ? sanitize(e.message).slice(0, 160) : "error"}). Nothing was sent.`);
  }
  const refusals = await importerModelHealth([choice.model!], Date.now(), jobId);
  const ev = evaluateModel(model, choice.model!, choice.task, { snapshot, settings, fxRate, refusals });
  return ev.row.eligible || ev.price ? { problem: null, price: ev.price, reasoning: !!ev.reasoning, structured: !!ev.structured, jsonMode: !!ev.jsonMode, temperature: !!ev.temperature } : { problem: ev.row.reason ?? "not usable", price: null, reasoning: false, structured: false, jsonMode: false, temperature: false };
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
      advice = sub.model && sub.model !== failed ? ` Use Reconfigure Models for This Job: it would propose ${sub.model} (up to ${formatInr(sub.maxInr)} per request) and shows the cost before anything is saved.` : " No other model on the importer's list is suitable either: add an image-capable model with a verified route and a known price (Import Settings → AI Auto-Configure), then use Reconfigure Models for This Job.";
    }
    throw new ImporterAiUnavailable(`The selected ${label} model ${failed} is unavailable (${why}) and no other approved model is suitable: ${alt.reason} ${sent}${advice}`);
  }
  // A configured fallback is used whatever its price (no application spending cap); the confirmed maximum already
  // prices a fallback request (select.ts fallbackMaxInr) and the replacement is recorded with its price.
  const pricier = (alt.maxInr ?? Infinity) > (choice.maxInr ?? 0) + 1e-9;
  return persistReplacement(input.jobId, sel, failed, choice, alt, why, pricier);
}

/**
 * How much more one fallback request may cost than the job's model without "more expensive fallbacks" switched on:
 * at most 50 % or ₹0.10 more per request (whichever is larger) — 2026-10-24: a ₹0.05 fallback was refused for being a
 * fraction of a paisa above a ₹0.05 model, leaving 17 questions unclassified.
 */
export const FALLBACK_SLACK = { ratio: 1.5, inr: 0.1 } as const;

/**
 * Whether a fallback model may be used for one failed request: only when its price is known (its worst case is then
 * reserved and recorded). No price allowance, per-request, job or key-reserve threshold applies (owner decision
 * 2026-10-26); the confirmed maximum of every operation already includes one fallback per request.
 */
export async function fallbackAllowance(primaryMaxInr: number | null, altMaxInr: number | null): Promise<{ ok: boolean; reason: string }> {
  if (altMaxInr === null || primaryMaxInr === null) return { ok: false, reason: "its price is unknown" };
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
 * plan chose for this task (job.config.modelPlan). Throws ImporterAiUnavailable (configuration, no usable
 * model, emergency stop, credits exhausted at OpenRouter — the job pauses, nothing more is sent) or
 * ImporterAiFailure (provider failed after its retry). No application spending cap stops it.
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
  let structuredRoutes = false;
  let jsonModeRoutes = false;
  let temperatureRoutes = false;
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
      structuredRoutes = route.structured;
      jsonModeRoutes = route.jsonMode;
      temperatureRoutes = route.temperature;
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
  const requestId = crypto.randomUUID();
  const feature = importerFeature(input.task);

  let lastError: OpenRouterError | null = null;
  // One attempt; at most ONE retry, only after a transient error (any, when enabled; a dropped connection —
  // "terminated" — always) — never a loop, never after a timeout.
  const attempts = REQUEST_ATTEMPTS;
  let replacements = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const requested = choice.model!;
    const requestKey = `qi:${input.jobId}:${requestId}:${attempt}${replacements ? `r${replacements}` : ""}`;
    await reserve({ jobId: input.jobId, requestKey, feature, amountInr: cost.worstInr });
    const started = Date.now();
    try {
      const r = await chatCompletion({
        apiKey,
        models: [requested, ...choice.fallbacks],
        prompt: "",
        system: input.system,
        content: input.content,
        maxTokens: input.maxOutputTokens,
        // temperature 0 only when every eligible route accepts it (require_parameters would otherwise drop routes).
        ...(temperatureRoutes ? { temperature: 0 } : {}),
        // A reasoning model can spend the whole output limit thinking and return no answer (seen 2026-10-20:
        // 8,000 tokens, empty text). Low effort keeps room for the answer; sent whenever a route of the model accepts
        // the parameter (requests use require_parameters, so only such routes are used) — also when fallbacks are
        // configured (2026-10-25: Verify 2 had a fallback, so the bound was left out and 12 reads were cut off).
        // importer-reliability-2: the thinking is bounded by a token budget (a share of the output limit) rather than an
        // effort word some models ignore (2026-10-26: gemma-4-26b spent all 8,000 tokens thinking in 23 of 27 requests).
        ...(reasoningRoutes ? { reasoning: { max_tokens: reasoningBudget(input.maxOutputTokens), exclude: true } } : {}),
        // Structured output where a route supports it: a JSON Schema of the expected answer, else JSON mode. The answer
        // is parsed and validated exactly as before (require_parameters keeps only routes that honour it).
        ...(input.jsonSchema && structuredRoutes ? { responseFormat: { type: "json_schema" as const, json_schema: { name: `importer_${input.jsonSchema}`, strict: false, schema: OUTPUT_SCHEMAS[input.jsonSchema] } } } : input.jsonSchema && jsonModeRoutes ? { responseFormat: { type: "json_object" as const } } : {}),
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
      // A charge above the reserved worst case is recorded in full (settle) and logged; it never pauses the job.
      if (overrunInr > 0) console.warn(`[ai-import] job ${input.jobId}: a ${input.task} request cost ${formatInr(charged)}, above its reserved maximum of ${formatInr(cost.worstInr)}`);
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
      // Credits exhausted / key spending limit reached at OpenRouter: every model is served through the same key, so no
      // fallback can help. The job pauses with the provider's reason; pages not yet read stay pending for Resume.
      if (e.category === "insufficient_credits") throw new ImporterAiUnavailable(`OpenRouter refused the request: ${describeCategory(e.category)} No other model can be used with this key, so processing paused. Pages not read yet stay pending — add credit at OpenRouter, then click Resume.`);
      if (!TRANSIENT_OPENROUTER_ERRORS.includes(e.category)) break;
      if (!input.settings.budget.retryTransient && !DROPPED_CONNECTION.test(e.message)) break;
    }
  }
  const kind = kindOfCategory(lastError!.category, lastError!.message);
  throw new ImporterAiFailure(failureMessage(kind, `OpenRouter failed: ${describeCategory(lastError!.category)}${lastError!.message !== describeCategory(lastError!.category) ? ` (${sanitize(lastError!.message).slice(0, 160)})` : ""}`), kind, choice.model);
}

/** Thinking tokens allowed for a JSON answer: a quarter of the output limit, at most 2,000 (the rest stays for the answer). */
export function reasoningBudget(maxOutputTokens: number): number {
  return Math.max(256, Math.min(2000, Math.floor(maxOutputTokens / 4)));
}

/**
 * Models that used their whole output limit without an answer (or were cut off) at least OUTPUT_FAILURE_PERSIST times
 * in this job: they are not sent this job's remaining requests while another suitable model exists (2026-10-26:
 * gemma-4-26b failed 23 of 27 requests that way, each one paid and then repeated on the fallback).
 */
export async function exhaustedModels(jobId: string): Promise<Set<string>> {
  const rows = await prisma.aiImportAiCall.groupBy({ by: ["model"], where: { jobId, ok: false, errorSummary: { contains: "output limit" } }, _count: { _all: true } });
  return new Set(rows.filter((r) => r._count._all >= OUTPUT_FAILURE_PERSIST).map((r) => r.model));
}

/**
 * Reliability of candidate models for a paid JSON read (Verify 2, reference OCR): a "thinking" model (its catalog entry
 * accepts `reasoning`) can spend the output limit thinking; a model that ran out of output limit repeatedly in the last
 * 14 days on any import is not trusted first. Candidates keep their price order otherwise.
 */
export async function preferReliable<T extends { id: string; eligible: boolean }>(candidates: T[]): Promise<T[]> {
  const ids = candidates.map((c) => c.id);
  const catalog = await loadModels(ids);
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const rows = await prisma.aiImportAiCall.groupBy({ by: ["model"], where: { model: { in: ids }, ok: false, errorSummary: { contains: "output limit" }, createdAt: { gte: since } }, _count: { _all: true } });
  const exhausted = new Map(rows.map((r) => [r.model, r._count._all]));
  const penalty = (c: T) => (catalog.get(c.id)?.supportedParameters.includes("reasoning") ? 1 : 0) + ((exhausted.get(c.id) ?? 0) >= OUTPUT_FAILURE_PERSIST ? 2 : 0);
  return candidates.map((c, i) => ({ c, i })).sort((a, b) => Number(b.c.eligible) - Number(a.c.eligible) || penalty(a.c) - penalty(b.c) || a.i - b.i).map((x) => x.c);
}

/** A model family ("google/gemma-3-4b-it" → "google/gemma"): a fallback of another family fails differently. */
export function modelFamily(id: string | null | undefined): string {
  const [vendor, name = ""] = (id ?? "").split("/");
  return `${vendor}/${name.split(/[-:._\d]/)[0] || name}`;
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
 * routes, privacy; not the failed model, and for page reading / verification not the other one), whatever its
 * price — the confirmed maximum already includes one fallback per request. Null + reason when none.
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
  const family = modelFamily;
  const cross = fresh.tasks[sel].candidates.find((c) => c.eligible && c.id !== failed && c.id !== other && family(c.id) !== family(failed));
  if (cross && family(alt.model) === family(failed) && (cross.maxInr ?? Infinity) <= (alt.maxInr ?? Infinity) * FALLBACK_SLACK.ratio + 1e-9) {
    const priced = await computeModelPlan({ ...input.settings, selection: { ...input.settings.selection, mode: "auto" } }, { refresh: false, jobId: input.jobId }, { [sel]: fresh.tasks[sel].candidates.filter((c) => c.id !== cross.id).map((c) => c.id) });
    if (priced.tasks[sel].model === cross.id) alt = priced.tasks[sel];
  }
  const pricier = (alt.maxInr ?? Infinity) > (choice.maxInr ?? 0) + 1e-9;
  const allowance = await fallbackAllowance(choice.maxInr, alt.maxInr);
  if (!allowance.ok) return { alt: null, reason: `the next suitable model, ${alt.model}: ${allowance.reason}`, pricier };
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
