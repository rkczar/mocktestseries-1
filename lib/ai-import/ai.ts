import "server-only";
import crypto from "node:crypto";
import type { AiModel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveOpenRouterKey, getEngineConfig, patchOpenRouterState } from "@/lib/ai-engine/settings";
import { getUsdInr, type FxRate } from "@/lib/ai-engine/fx";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { formatInr, usdToInr } from "@/lib/ai-engine/config";
import { OpenRouterError, TRANSIENT_OPENROUTER_ERRORS, chatCompletion, describeCategory, getKeyInfo, sanitize, type ChatContentPart } from "@/lib/ai-engine/openrouter";
import { PILOT_LIMITS, SELECTION_TASK_LABELS, importerFeature, type ImporterSettings, type ImporterTask, type SelectionTask } from "@/lib/ai-import/config";
import { computeModelPlan, planOf, requestUsd } from "@/lib/ai-import/select";
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
export class ImporterAiFailure extends Error {}

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

/** Fallbacks may never cost more than the preferred model (per prompt, completion, request and input-image price). */
export function notPricier(m: AiModel, preferred: AiModel): boolean {
  const out = (x: AiModel) => Math.max(x.completionPrice ?? 0, x.reasoningPrice ?? 0);
  return (m.promptPrice ?? 0) <= (preferred.promptPrice ?? 0) && out(m) <= out(preferred) && (m.requestPrice ?? 0) <= (preferred.requestPrice ?? 0) && (inputImagePriceUsd(m) ?? Infinity) <= (inputImagePriceUsd(preferred) ?? Infinity);
}

export interface AiCallInput {
  jobId: string;
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
    const job = await tx.aiImportJob.findUnique({ where: { id: input.jobId }, select: { budgetInr: true, spentInr: true } });
    if (!job) throw new ImporterAiUnavailable("The import job no longer exists.");
    const inflight = await tx.$queryRawUnsafe<{ v: number }[]>(`SELECT ${SPEND} AS v FROM "AiBudgetReservation" WHERE "requestKey" LIKE $1 AND "status" = 'RESERVED'`, `qi:${input.jobId}:%`);
    const jobUsed = job.spentInr + (inflight[0]?.v ?? 0);
    // The hard per-job ceiling applies even to a job whose own budget was set before the ceiling was lowered.
    const jobCap = Math.min(job.budgetInr, input.settings.budget.maxJobInr, PILOT_LIMITS.maxJobInr);
    if (jobUsed + input.amountInr > jobCap) {
      const capped = jobCap < job.budgetInr;
      throw new ImporterBudgetError(`The job budget is reached (${formatInr(jobUsed)} of ${formatInr(jobCap)} used; the next request may cost up to ${formatInr(input.amountInr)}).${capped ? " The hard limit per job in Import Settings applies." : " Raise the job budget to continue."}`, "job");
    }
    const month = await tx.$queryRawUnsafe<{ v: number }[]>(`SELECT ${SPEND} AS v FROM "AiBudgetReservation" WHERE "istMonth" = $1 AND "status" <> 'RELEASED' AND left("feature", 8) = 'qimport_'`, istMonth);
    const monthUsed = month[0]?.v ?? 0;
    const monthCap = Math.min(input.settings.budget.monthlyInr, PILOT_LIMITS.monthlyInr);
    if (monthUsed + input.amountInr > monthCap) {
      throw new ImporterBudgetError(`The importer's monthly AI budget is reached (${formatInr(monthUsed)} of ${formatInr(monthCap)}; the next request may cost up to ${formatInr(input.amountInr)}).`, "month");
    }
    // All-time cap: every importer request ever made (never resets with the month).
    const all = await tx.$queryRawUnsafe<{ v: number }[]>(`SELECT ${SPEND} AS v FROM "AiBudgetReservation" WHERE "status" <> 'RELEASED' AND left("feature", 8) = 'qimport_'`);
    const allUsed = all[0]?.v ?? 0;
    const totalCap = Math.min(input.settings.budget.totalInr ?? PILOT_LIMITS.totalInr, PILOT_LIMITS.totalInr);
    if (allUsed + input.amountInr > totalCap) {
      throw new ImporterBudgetError(`The importer's all-time AI budget is reached (${formatInr(allUsed)} of ${formatInr(totalCap)}; it does not reset monthly; the next request may cost up to ${formatInr(input.amountInr)}).`, "total");
    }
    // The key's limit is shared with student Ask AI. Requests of other importer jobs still in flight are not
    // yet in the key's usage, so they are subtracted too (they hold this same lock while reserving).
    if (input.key.remainingUsd !== null) {
      const pending = await tx.$queryRawUnsafe<{ v: number }[]>(`SELECT COALESCE(SUM("reservedInr"), 0)::float8 AS v FROM "AiBudgetReservation" WHERE "status" = 'RESERVED' AND left("feature", 8) = 'qimport_'`);
      const pendingUsd = (pending[0]?.v ?? 0) / input.key.fxRate;
      const afterUsd = input.key.remainingUsd - pendingUsd - input.amountInr / input.key.fxRate;
      if (afterUsd < Math.max(input.settings.budget.keyReserveUsd, PILOT_LIMITS.minKeyReserveUsd)) {
        throw new ImporterBudgetError(
          `The shared OpenRouter key has $${input.key.remainingUsd.toFixed(2)} left${pendingUsd > 0 ? ` ($${pendingUsd.toFixed(4)} of it held by importer requests in flight)` : ""}; this request could use up to $${(input.amountInr / input.key.fxRate).toFixed(4)}, which would leave less than the $${input.settings.budget.keyReserveUsd.toFixed(2)} kept for student Ask AI (Import Settings).`,
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

const SELECTION_TASK_OF: Record<ImporterTask, SelectionTask> = { analyze: "extract", extract: "extract", verify: "verify", key: "key", classify: "classify" };
/** Provider answers that mean "this model cannot be served under these constraints" (never billed). */
const UNAVAILABLE_ERRORS = ["no_endpoint", "model_unavailable"];

/**
 * The confirmed model of `task` is unavailable: choose again with the job's settings, excluding it.
 * A cheaper or equally priced replacement is used (and recorded); a more expensive one only when
 * Import Settings allow it. Otherwise the job stops with the reason (ImporterAiUnavailable → paused).
 */
async function replaceModel(input: AiCallInput, plan: ModelPlan, choice: TaskChoice, why: string, tried: string[]): Promise<TaskChoice> {
  const sel = choice.task;
  const label = SELECTION_TASK_LABELS[sel].toLowerCase();
  // Page reading and verification stay independent: a replacement is never the job's model for the other one.
  const other = sel === "verify" ? plan.tasks.extract.model : sel === "extract" ? plan.tasks.verify.model : null;
  const exclude: Partial<Record<SelectionTask, string[]>> = { [sel]: other ? [...tried, other] : tried };
  const fresh = await computeModelPlan(input.settings, { refresh: true }, exclude);
  const alt = fresh.tasks[sel];
  const failed = choice.model!;
  if (!alt.model) throw new ImporterAiUnavailable(`The selected ${label} model ${failed} is unavailable (${why}) and no other approved model is suitable: ${alt.reason} Nothing was sent.`);
  const pricier = (alt.maxInr ?? Infinity) > (choice.maxInr ?? 0) + 1e-9;
  if (pricier && !input.settings.budget.allowPricierFallback) {
    throw new ImporterAiUnavailable(`The selected ${label} model ${failed} is unavailable (${why}). The next suitable model, ${alt.model}, could cost up to ${formatInr(alt.maxInr)} per request instead of ${formatInr(choice.maxInr)}; more expensive fallbacks are OFF in Import Settings, so processing stopped. Nothing was sent.`);
  }
  const replaced: TaskChoice = { ...alt, replaced: { from: failed, at: new Date().toISOString(), why: why.slice(0, 200) } };
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ config: unknown }[]>`SELECT "config" FROM "AiImportJob" WHERE "id" = ${input.jobId} FOR UPDATE`;
    const config = (locked[0]?.config ?? {}) as Record<string, unknown>;
    const current = planOf(config);
    if (!current) return;
    await tx.aiImportJob.update({ where: { id: input.jobId }, data: { config: { ...config, modelPlan: { ...current, tasks: { ...current.tasks, [sel]: replaced } } } as unknown as Prisma.InputJsonValue } });
    await tx.aiImportEvent.create({
      data: {
        jobId: input.jobId,
        type: "MODEL_REPLACED",
        message: `${SELECTION_TASK_LABELS[sel]}: ${failed} is unavailable (${why.slice(0, 160)}); now using ${alt.model} (up to ${formatInr(alt.maxInr)} per request, was ${formatInr(choice.maxInr)})${pricier ? " — MORE EXPENSIVE, allowed by Import Settings" : ""}.`.slice(0, 1000),
        data: { task: sel, from: failed, to: alt.model, fromMaxInr: choice.maxInr, toMaxInr: alt.maxInr, pricier },
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
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId }, select: { config: true } });
  const plan = planOf(job?.config);
  if (!plan) throw new ImporterAiUnavailable("This job has no confirmed model plan. Nothing was sent.");
  let choice = plan.tasks[SELECTION_TASK_OF[input.task]];
  if (!choice?.model) throw new ImporterAiUnavailable(`No model can be used for ${input.task}: ${choice?.reason ?? "not planned"}`);
  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) throw new ImporterAiUnavailable("OpenRouter is not configured or is disabled (Admin → AI → Providers).");
  const engine = await getEngineConfig();
  if (engine.budgets.emergencyStop) throw new ImporterAiUnavailable("AI generation is stopped by the AI emergency stop (Admin → AI → Budgets).");
  const fx = await getUsdInr();
  if (fx.rate === null) throw new ImporterAiUnavailable(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate"}. Nothing was sent.`);

  const tried: string[] = [];
  // The confirmed model, still approved and usable now? (An admin may have withdrawn it meanwhile.)
  for (;;) {
    const catalog = await loadModels([choice.model!, ...choice.fallbacks]);
    const p = modelProblem(catalog.get(choice.model!), input.needsVision, input.settings.importerModels);
    if (!p) break;
    tried.push(choice.model!);
    choice = await replaceModel(input, plan, choice, p, tried);
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
  // One attempt; at most ONE retry, only when enabled and only after a transient error — never a loop, never after a timeout.
  const attempts = input.settings.budget.retryTransient ? 2 : 1;
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
      await log({ input, requestId, attempt, model: r.model, requested, ok: !empty && r.finishReason !== "length", latencyMs: Date.now() - started, fx, estUsd: cost.typicalUsd, costUsd: r.costUsd, chargedInr: charged, costStatus: r.costUsd !== null ? "actual" : "unknown", inputTokens: r.inputTokens, outputTokens: r.outputTokens, generationId: r.generationId, fallbackUsed, errorCategory: empty ? "empty_response" : r.finishReason === "length" ? "truncated" : null, errorSummary: empty ? describeCategory("empty_response") : r.finishReason === "length" ? describeCategory("truncated") : null });
      await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
      if (overrunInr > 0) {
        throw new ImporterBudgetError(`A ${input.task} request cost ${formatInr(charged)}, more than its reserved maximum of ${formatInr(cost.worstInr)} (the provider billed more than the conservative bound). The charge is recorded in full and the job is paused — review the Cost Center before resuming.`, "overrun");
      }
      if (empty) throw new ImporterAiFailure(describeCategory("empty_response"));
      if (r.finishReason === "length") throw new ImporterAiFailure("The model's answer was cut off at the output limit.");
      return { text: r.text, model: r.model, costInr: charged, inputTokens: r.inputTokens, outputTokens: r.outputTokens, fallbackUsed };
    } catch (error) {
      if (error instanceof ImporterAiFailure || error instanceof ImporterBudgetError || error instanceof ImporterAiUnavailable) throw error;
      const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
      lastError = e;
      const billedUnknown = e.category === "timeout" || e.generationId !== null;
      const charged = billedUnknown ? (await settle(input.jobId, requestKey, null, null)).charged : (await release(requestKey), 0);
      await log({ input, requestId, attempt, model: requested, requested, ok: false, latencyMs: Date.now() - started, fx, estUsd: cost.typicalUsd, costUsd: null, chargedInr: charged, costStatus: billedUnknown ? "unknown" : "none", generationId: e.generationId, errorCategory: e.category, errorSummary: e.message, fallbackUsed: false });
      await patchOpenRouterState({ lastError: { category: e.category, message: sanitize(e.message), at: new Date().toISOString() } });
      // No route can serve the model under the privacy / price constraints: choose again (never silently pricier).
      if (UNAVAILABLE_ERRORS.includes(e.category) && !billedUnknown && replacements === 0) {
        tried.push(requested);
        choice = await replaceModel(input, plan, choice, describeCategory(e.category), tried);
        cost = priced(choice);
        replacements++;
        attempt--;
        continue;
      }
      if (!TRANSIENT_OPENROUTER_ERRORS.includes(e.category)) break;
    }
  }
  throw new ImporterAiFailure(`OpenRouter failed: ${describeCategory(lastError!.category)}${lastError!.message !== describeCategory(lastError!.category) ? ` (${sanitize(lastError!.message).slice(0, 160)})` : ""}`);
}

/** Parses a model's JSON answer (tolerates a ```json fence; nothing else). */
export function parseModelJson(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ImporterAiFailure("The model did not return JSON.");
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new ImporterAiFailure("The model returned malformed JSON.");
  }
}
