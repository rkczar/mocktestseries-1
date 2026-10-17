import "server-only";
import crypto from "node:crypto";
import type { AiModel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveOpenRouterKey, getEngineConfig, patchOpenRouterState } from "@/lib/ai-engine/settings";
import { getUsdInr, type FxRate } from "@/lib/ai-engine/fx";
import { istDayMonth } from "@/lib/ai-engine/budget";
import { formatInr, usdToInr } from "@/lib/ai-engine/config";
import { OpenRouterError, TRANSIENT_OPENROUTER_ERRORS, chatCompletion, describeCategory, sanitize, type ChatContentPart } from "@/lib/ai-engine/openrouter";
import { importerFeature, type ImporterSettings, type ImporterTask } from "@/lib/ai-import/config";

/**
 * Every paid AI request of the AI Question Importer goes through here:
 *
 *   approved model(s) → worst-case cost → per-request ceiling
 *   → RESERVE against the job cap AND the importer's monthly budget
 *     (one advisory lock, so parallel pages can never overshoot)
 *   → OpenRouter (privacy policy enforced per request) → SETTLE to the
 *     provider-reported cost (unknown cost = worst case kept)
 *   → logged in AiImportAiCall (per job) and AiGatewayCall (platform usage).
 *
 * The importer budget is separate from the platform / student AI budgets
 * (lib/ai-engine/budget.ts excludes "qimport_*"). The OpenRouter key's own
 * limit is shared and remains the provider-side backstop.
 */

export class ImporterBudgetError extends Error {
  constructor(
    message: string,
    readonly scope: "job" | "month" | "request"
  ) {
    super(message);
    this.name = "ImporterBudgetError";
  }
}
export class ImporterAiUnavailable extends Error {}
export class ImporterAiFailure extends Error {}

const LOCK_KEY = 7_301_442_031; // importer budget advisory lock
/** A reservation older than this belongs to a killed worker (an importer request never runs this long). */
export const STALE_MS = 10 * 60_000;
/** Conservative token allowance per image part (providers bill 250–1,800 tokens for a page image). */
export const IMAGE_TOKENS = 2_000;

export interface AiCallInput {
  jobId: string;
  task: ImporterTask;
  /** Ordered: preferred model first, then fallbacks (OpenRouter `models`). */
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

/** Why a configured model cannot be used for a task (null = usable). */
export function modelProblem(m: AiModel | undefined, needsVision: boolean): string | null {
  if (!m) return "not in the model catalog (sync Admin → AI → Models)";
  if (!m.approved) return "not approved in Admin → AI → Models";
  if (m.disabled) return "disabled";
  if (m.missingSince) return "no longer listed by OpenRouter";
  if (m.expirationDate && m.expirationDate <= new Date().toISOString().slice(0, 10)) return `expired ${m.expirationDate}`;
  if (m.promptPrice === null || m.completionPrice === null || m.promptPrice < 0 || m.completionPrice < 0) return "no fixed published price";
  if (!m.outputModalities.includes("text")) return "does not return text";
  if (needsVision && !m.inputModalities.includes("image")) return "cannot read images";
  return null;
}

export async function loadModels(ids: string[]): Promise<Map<string, AiModel>> {
  const rows = await prisma.aiModel.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((r) => [r.id, r]));
}

/** Worst-case USD of one call on the most expensive of the listed models. */
export function worstCaseUsd(models: AiModel[], inputTokens: number, maxOut: number): number {
  let worst = 0;
  for (const m of models) {
    const out = Math.max(m.completionPrice ?? 0, m.reasoningPrice ?? 0);
    worst = Math.max(worst, inputTokens * (m.promptPrice ?? 0) + maxOut * out + (m.requestPrice ?? 0));
  }
  return worst;
}

export function estimateInputTokens(system: string, content: ChatContentPart[]): number {
  let tokens = Math.ceil(system.length / 3);
  for (const p of content) tokens += p.type === "text" ? Math.ceil(p.text.length / 3) : IMAGE_TOKENS;
  return tokens + 50;
}

const SPEND = `COALESCE(SUM(COALESCE("settledInr", "reservedInr")), 0)::float8`;

async function reserve(input: { jobId: string; requestKey: string; feature: string; amountInr: number; settings: ImporterSettings }): Promise<void> {
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
    if (jobUsed + input.amountInr > job.budgetInr) {
      throw new ImporterBudgetError(`The job budget is reached (${formatInr(jobUsed)} of ${formatInr(job.budgetInr)} used; the next request may cost up to ${formatInr(input.amountInr)}). Raise the job budget to continue.`, "job");
    }
    const month = await tx.$queryRawUnsafe<{ v: number }[]>(`SELECT ${SPEND} AS v FROM "AiBudgetReservation" WHERE "istMonth" = $1 AND "status" <> 'RELEASED' AND left("feature", 8) = 'qimport_'`, istMonth);
    const monthUsed = month[0]?.v ?? 0;
    if (monthUsed + input.amountInr > input.settings.budget.monthlyInr) {
      throw new ImporterBudgetError(`The importer's monthly AI budget is reached (${formatInr(monthUsed)} of ${formatInr(input.settings.budget.monthlyInr)}). A Master Admin can raise it in Import Settings.`, "month");
    }
    await tx.aiBudgetReservation.create({ data: { requestKey: input.requestKey, feature: input.feature, reservedInr: input.amountInr, istDay, istMonth } });
  });
}

/** Settles a reservation and adds the charge to the job (atomic increment; idempotent per request key). */
async function settle(jobId: string, requestKey: string, actualInr: number | null, actualUsd: number | null): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.aiBudgetReservation.findUnique({ where: { requestKey } });
    if (!r || r.status !== "RESERVED") return r?.settledInr ?? 0;
    const charge = actualInr ?? r.reservedInr;
    await tx.aiBudgetReservation.update({ where: { requestKey }, data: { status: "SETTLED", settledInr: charge, costKnown: actualInr !== null, settledAt: new Date() } });
    await tx.aiImportJob.update({ where: { id: jobId }, data: { spentInr: { increment: charge }, ...(actualUsd !== null ? { spentUsd: { increment: actualUsd } } : {}) } });
    return charge;
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
 * One priced, budgeted, privacy-constrained OpenRouter request. Throws
 * ImporterBudgetError (job pauses, nothing sent), ImporterAiUnavailable
 * (configuration), or ImporterAiFailure (provider failed after its retry).
 */
export async function importerAiCall(input: AiCallInput): Promise<AiCallResult> {
  if (!input.settings.aiEnabled) throw new ImporterAiUnavailable("Paid AI processing is switched off in Import Settings.");
  const ids = input.models.filter(Boolean);
  if (!ids.length) throw new ImporterAiUnavailable(`No model is set for ${input.task} in Import Settings.`);
  const apiKey = await resolveOpenRouterKey();
  if (!apiKey) throw new ImporterAiUnavailable("OpenRouter is not configured or is disabled (Admin → AI → Providers).");
  const engine = await getEngineConfig();
  if (engine.budgets.emergencyStop) throw new ImporterAiUnavailable("AI generation is stopped by the AI emergency stop (Admin → AI → Budgets).");
  const fx = await getUsdInr();
  if (fx.rate === null) throw new ImporterAiUnavailable(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate"}. Nothing was sent.`);

  const catalog = await loadModels(ids);
  const usable: AiModel[] = [];
  const problems: string[] = [];
  for (const id of ids) {
    const p = modelProblem(catalog.get(id), input.needsVision);
    if (p) problems.push(`${id}: ${p}`);
    else usable.push(catalog.get(id)!);
  }
  if (!usable.length) throw new ImporterAiUnavailable(`No usable model for ${input.task}: ${problems.join("; ")}.`);

  const inputTokens = estimateInputTokens(input.system, input.content);
  const worstUsd = worstCaseUsd(usable, inputTokens, input.maxOutputTokens);
  const worstInr = usdToInr(worstUsd, fx.rate)!;
  if (worstInr > input.settings.budget.maxRequestInr) {
    throw new ImporterBudgetError(`One ${input.task} request could cost up to ${formatInr(worstInr)}, above the per-request limit of ${formatInr(input.settings.budget.maxRequestInr)} (Import Settings).`, "request");
  }
  const typicalUsd = worstCaseUsd(usable, inputTokens, Math.round(input.maxOutputTokens * 0.4));
  const maxPrompt = Math.max(...usable.map((m) => m.promptPrice ?? 0)) * 1e6;
  const maxCompletion = Math.max(...usable.map((m) => Math.max(m.completionPrice ?? 0, m.reasoningPrice ?? 0))) * 1e6;
  const requestId = crypto.randomUUID();
  const requested = usable[0].id;
  const feature = importerFeature(input.task);

  let lastError: OpenRouterError | null = null;
  // At most ONE retry, only after a transient error — never a retry loop, never after a timeout.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const requestKey = `qi:${input.jobId}:${requestId}:${attempt}`;
    await reserve({ jobId: input.jobId, requestKey, feature, amountInr: worstInr, settings: input.settings });
    const started = Date.now();
    try {
      const r = await chatCompletion({
        apiKey,
        models: usable.map((m) => m.id),
        prompt: "",
        system: input.system,
        content: input.content,
        maxTokens: input.maxOutputTokens,
        temperature: 0,
        provider: {
          max_price: { prompt: maxPrompt * 1.05, completion: maxCompletion * 1.05 },
          data_collection: input.settings.privacy.dataCollection,
          ...(input.settings.privacy.zdr ? { zdr: true } : {}),
          allow_fallbacks: true,
          require_parameters: false,
        },
        timeoutMs: 150_000,
      });
      const actualInr = r.costUsd !== null ? usdToInr(r.costUsd, fx.rate) : null;
      const charged = await settle(input.jobId, requestKey, actualInr, r.costUsd);
      const fallbackUsed = r.model !== requested && !r.model.startsWith(`${requested}-`);
      const empty = !r.text.trim();
      await log({ input, requestId, attempt, model: r.model, requested, ok: !empty && r.finishReason !== "length", latencyMs: Date.now() - started, fx, estUsd: typicalUsd, costUsd: r.costUsd, chargedInr: charged, costStatus: r.costUsd !== null ? "actual" : "unknown", inputTokens: r.inputTokens, outputTokens: r.outputTokens, generationId: r.generationId, fallbackUsed, errorCategory: empty ? "empty_response" : r.finishReason === "length" ? "truncated" : null, errorSummary: empty ? describeCategory("empty_response") : r.finishReason === "length" ? describeCategory("truncated") : null });
      await patchOpenRouterState({ lastSuccessAt: new Date().toISOString() });
      if (empty) throw new ImporterAiFailure(describeCategory("empty_response"));
      if (r.finishReason === "length") throw new ImporterAiFailure("The model's answer was cut off at the output limit.");
      return { text: r.text, model: r.model, costInr: charged, inputTokens: r.inputTokens, outputTokens: r.outputTokens, fallbackUsed };
    } catch (error) {
      if (error instanceof ImporterAiFailure) throw error;
      const e = error instanceof OpenRouterError ? error : new OpenRouterError("provider_error", error instanceof Error ? error.message : "request failed");
      lastError = e;
      const billedUnknown = e.category === "timeout" || e.generationId !== null;
      const charged = billedUnknown ? await settle(input.jobId, requestKey, null, null) : (await release(requestKey), 0);
      await log({ input, requestId, attempt, model: requested, requested, ok: false, latencyMs: Date.now() - started, fx, estUsd: typicalUsd, costUsd: null, chargedInr: charged, costStatus: billedUnknown ? "unknown" : "none", generationId: e.generationId, errorCategory: e.category, errorSummary: e.message, fallbackUsed: false });
      await patchOpenRouterState({ lastError: { category: e.category, message: sanitize(e.message), at: new Date().toISOString() } });
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
