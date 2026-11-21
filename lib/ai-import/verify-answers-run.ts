import "server-only";
import { AiImportJobStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/ai-engine/config";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { OPINION_FAIL_STOP, OPINION_TOKENS, OPINION_TOKENS_REASONING, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, jobRunSettings } from "@/lib/ai-import/settings";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { kickWorker } from "@/lib/ai-import/kick";
import { effective, IMPORTABLE } from "@/lib/ai-import/post";
import { labelFromPrinted, SOLVE_SYSTEM, solveSchema, solveUserText } from "@/lib/ai-import/prompts";
import { computeModelPlan } from "@/lib/ai-import/select";
import type { TaskChoice } from "@/lib/ai-import/selection-types";
import { contentPartOf } from "@/lib/ai-import/verify-core";
import { verifyAnswers } from "@/lib/ai-import/verify-answers";
import { vaCategory, type AiOpinion, type VaCategory } from "@/lib/ai-import/verify-answers-core";
import { estimateInputTokens, importerAiCall, ImporterAiFailure, ImporterAiUnavailable, parseModelJson, PRICE_MARGIN, REQUEST_ATTEMPTS, storedAiResults } from "@/lib/ai-import/ai";
import { requestUsd } from "@/lib/ai-import/select";
import { usdToInr } from "@/lib/ai-engine/config";

/**
 * Verify Answers — paper-wide answer-key check (A: is the official key read and mapped to the right question?) plus an
 * optional independent AI answer per question (B: does a model, solving it alone, reach the same option?). B is
 * evidence only: it is stored in job.config.verifyAnswers, never in finalAnswer / aiAnswer, never approves, never
 * publishes. Runs in the worker (lib/ai-import/worker.ts) after the administrator confirms the maximum cost.
 */

const FINISHED: AiImportJobStatus[] = [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.COMPLETED, AiImportJobStatus.COMPLETED_WITH_ISSUES];
const HISTORY_MAX = 20;

export interface VaResult extends AiOpinion { h: string; model: string; source: "ai" | "cached"; costInr: number; at: string }
export interface VaState {
  status: "QUEUED" | "RUNNING" | "DONE" | "STOPPED";
  model: string | null;
  choice: TaskChoice | null;
  requestedById: string;
  requestedAt: string;
  finishedAt?: string;
  stopReason?: string;
  toAsk: number;
  maxInr: number;
  estimateInr: number;
  spentBeforeInr: number;
  actualInr?: number;
  failed: string[];
  /** The first failed request's reason (shown with the report; never the prompt or a key). */
  firstError?: string | null;
  results: Record<string, VaResult>;
}
export interface VaHistoryEntry { at: string; model: string | null; status: VaState["status"]; counts: Record<VaCategory, number>; checked: number; actualInr: number; byId: string }

type Config = { verifyAnswers?: VaState; verifyAnswersHistory?: VaHistoryEntry[] } & Record<string, unknown>;
const cfgOf = (c: unknown): Config => ((c as Config) ?? {});

async function eligibleQuestions(jobId: string) {
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId, status: { not: "REJECTED" } }, orderBy: [{ orderIndex: "asc" }, { id: "asc" }], select: { id: true, data: true, editedData: true } });
  return rows.map((q) => ({ id: q.id, e: effective(q) })).filter(({ e }) => IMPORTABLE.has(e.type) && e.options.length >= 2);
}

/** A new, separately confirmed operation: the CURRENT paid-AI and direct-OpenAI switches; privacy stays the stricter. */
export function vaSettings(config: unknown, current: ImporterSettings): ImporterSettings {
  return { ...jobRunSettings(config, current), aiEnabled: current.aiEnabled, openaiDirect: current.openaiDirect };
}

/** Text-only model choice (an answer opinion needs no image): the classify route, priced by the importer's own catalogue. */
async function choiceFor(settings: ImporterSettings, model: string | null, jobId: string): Promise<{ choice: TaskChoice | null; candidates: { id: string; eligible: boolean; reason: string; maxInr: number | null }[] }> {
  const plan = await computeModelPlan({ ...settings, selection: { ...settings.selection, mode: model ? "manual" : "auto" }, models: { ...settings.models, classify: model } }, { refresh: true, jobId });
  const t = plan.tasks.classify;
  return { choice: t.model ? t : null, candidates: (t.candidates ?? []).map((c) => ({ id: c.id, eligible: c.eligible, reason: c.reason ?? "", maxInr: c.maxInr })) };
}

/** Same output room as post-processing's opinions: a reasoning model needs more, never above the model's own limit. */
async function opinionTokens(choice: TaskChoice): Promise<number> {
  const row = await prisma.aiModel.findUnique({ where: { id: choice.model! }, select: { maxCompletionTokens: true, supportedParameters: true } });
  return Math.min(row?.supportedParameters.includes("reasoning") ? OPINION_TOKENS_REASONING : OPINION_TOKENS, row?.maxCompletionTokens || Infinity);
}

export interface VaPreview { questions: number; toAsk: number; reused: number; model: string | null; candidates: { id: string; eligible: boolean; reason: string; maxInr: number | null }[]; estimateInr: number; maxInr: number; aiEnabled: boolean; problem: string | null }

/** Price of Verify Answers for this model: only questions without a reusable opinion (same content, same model) are sent. */
export async function verifyAnswersPreview(jobId: string, model: string | null): Promise<VaPreview & { choice: TaskChoice | null; spentInr: number; examId: string; status: AiImportJobStatus }> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  const settings = vaSettings(job.config, await getImporterSettings());
  const qs = await eligibleQuestions(jobId);
  const { choice, candidates } = settings.aiEnabled ? await choiceFor(settings, model, jobId) : { choice: null, candidates: [] };
  const prior = cfgOf(job.config).verifyAnswers?.results ?? {};
  const stored = choice?.model ? (await storedAiResults(job.examId)).opinions : new Map();
  const todo = choice?.model ? qs.filter(({ id, e }) => { const h = contentPartOf(e); return !(prior[id]?.h === h && prior[id]?.model === choice.model) && !stored.has(`${h}|${choice.model}`); }) : [];
  const fx = (await getUsdInr()).rate;
  let est = 0;
  let max = 0;
  if (choice?.price && fx) {
    const out = await opinionTokens(choice);
    for (const { e } of todo) {
      const t = estimateInputTokens(SOLVE_SYSTEM, [{ type: "text", text: solveUserText(e) }]);
      est += usdToInr(requestUsd({ ...choice.price, image: 0 }, t, Math.min(out, 200), 0), fx) ?? 0;
      max += (usdToInr(requestUsd({ ...choice.price, image: 0 }, t, out, 0) * PRICE_MARGIN, fx) ?? 0) * REQUEST_ATTEMPTS;
    }
  }
  const problem = !settings.aiEnabled ? "Paid AI is switched off in Import Settings: only the free key check runs." : !choice?.model ? "No eligible text model for the independent answer." : null;
  return { questions: qs.length, toAsk: todo.length, reused: qs.length - todo.length, model: choice?.model ?? null, candidates, estimateInr: Math.round(est * 100) / 100, maxInr: Math.ceil(max * 100) / 100, aiEnabled: settings.aiEnabled, problem, choice, spentInr: job.spentInr, examId: job.examId, status: job.status };
}

/** The preview without server-only fields (choice route, job ids). */
export function vaPublic(p: Awaited<ReturnType<typeof verifyAnswersPreview>>): VaPreview {
  return { questions: p.questions, toAsk: p.toAsk, reused: p.reused, model: p.model, candidates: p.candidates, estimateInr: p.estimateInr, maxInr: p.maxInr, aiEnabled: p.aiEnabled, problem: p.problem };
}

/** Queues Verify Answers. Starts only with a confirmed maximum ≥ the fresh price; refuses while anything else runs. */
export async function requestVerifyAnswers(input: { jobId: string; actorId: string; model: string | null; confirmedMaxInr: number | null; keyOnly?: boolean }): Promise<{ started: boolean; reason?: string; preview: VaPreview }> {
  const p0 = await verifyAnswersPreview(input.jobId, input.model);
  // Key check only: no model, nothing sent, ₹0.
  const p = input.keyOnly ? { ...p0, choice: null, toAsk: 0, maxInr: 0, estimateInr: 0, model: null } : p0;
  const { choice, spentInr, status } = p;
  const preview = vaPublic(p);
  if (!FINISHED.includes(status)) throw new ImportJobError("The import is busy (processing or another verification). Try again when it has finished.", 409);
  if (p.toAsk && choice) {
    if (input.confirmedMaxInr === null || !Number.isFinite(input.confirmedMaxInr)) return { started: false, reason: "Confirm the maximum cost first.", preview };
    if (input.confirmedMaxInr + 0.005 < p.maxInr) return { started: false, reason: `The price changed: the maximum is now ${formatInr(p.maxInr)}. Confirm the new maximum.`, preview };
  }
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: input.jobId }, select: { config: true, budgetInr: true } });
  const cfg = cfgOf(job.config);
  const state: VaState = { status: "QUEUED", model: choice?.model ?? null, choice, requestedById: input.actorId, requestedAt: new Date().toISOString(), toAsk: choice ? p.toAsk : 0, maxInr: choice ? p.maxInr : 0, estimateInr: choice ? p.estimateInr : 0, spentBeforeInr: spentInr, failed: [], results: cfg.verifyAnswers?.results ?? {} };
  const budget = Math.max(job.budgetInr, Math.ceil((spentInr + state.maxInr) * 100) / 100);
  // Only a finished job moves to QUEUED, so two clicks (or two admins) cannot start it twice.
  const r = await prisma.aiImportJob.updateMany({ where: { id: input.jobId, status }, data: { status: AiImportJobStatus.QUEUED, finishedAt: null, budgetInr: budget, config: { ...cfg, verifyAnswers: state } as unknown as Prisma.InputJsonValue } });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  await logEvent(input.jobId, "VERIFY_ANSWERS_REQUESTED", `Verify Answers confirmed: ${p.questions} question(s), ${state.toAsk} independent AI answer(s) to request${state.model ? ` with ${state.model}` : ""} (maximum ${formatInr(state.maxInr)}).`, { model: state.model, maxInr: state.maxInr }, input.actorId);
  await prisma.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORT_VERIFY_ANSWERS_REQUESTED", entityType: "AiImportJob", entityId: input.jobId, metadata: { model: state.model, maxInr: state.maxInr } } });
  kickWorker();
  return { started: true, preview };
}

/** Stop (pause): the worker sees the job is no longer PROCESSING and returns; results so far are kept for a resume. */
export async function stopVerifyAnswers(jobId: string, actorId: string): Promise<void> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { config: true } });
  const st = cfgOf(job?.config).verifyAnswers;
  if (!st || (st.status !== "QUEUED" && st.status !== "RUNNING")) throw new ImportJobError("Verify Answers is not running.");
  const cfg = cfgOf(job!.config);
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: { in: [AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING] } }, data: { status: AiImportJobStatus.NEEDS_REVIEW, finishedAt: new Date(), config: { ...cfg, verifyAnswers: { ...st, status: "STOPPED", stopReason: "Stopped by an administrator.", finishedAt: new Date().toISOString() } } as unknown as Prisma.InputJsonValue } });
  if (r.count) await logEvent(jobId, "VERIFY_ANSWERS_STOPPED", "Verify Answers stopped by an administrator. Answers received so far are kept; Verify Answers again resumes with the rest.", {}, actorId);
}

/** The worker's part: asks only what is not answered yet; saves after every question (crash-safe resume). */
export async function runVerifyAnswers(ctx: { jobId: string; settings: ImporterSettings; stillRunning: () => Promise<boolean> }, state: VaState): Promise<VaState> {
  const results = { ...state.results };
  const failed: string[] = [];
  let firstError: string | null = null;
  const save = async (patch: Partial<VaState>) => {
    const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: ctx.jobId }, select: { config: true } });
    const cfg = cfgOf(j.config);
    await prisma.aiImportJob.update({ where: { id: ctx.jobId }, data: { config: { ...cfg, verifyAnswers: { ...(cfg.verifyAnswers as VaState), ...patch, results, failed, firstError } } as unknown as Prisma.InputJsonValue } });
  };
  const choice = state.choice;
  if (!choice?.model || !ctx.settings.aiEnabled) return { ...state, results, failed };
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: ctx.jobId }, select: { examId: true } });
  const stored = (await storedAiResults(job.examId)).opinions;
  let unusable = 0;
  const maxOut = await opinionTokens(choice);
  for (const { id, e } of await eligibleQuestions(ctx.jobId)) {
    const h = contentPartOf(e);
    if (results[id]?.h === h && results[id]?.model === choice.model) continue;
    const labels = e.options.map((o) => o.label);
    const hit = stored.get(`${h}|${choice.model}`);
    if (hit) {
      results[id] = { h, model: choice.model, source: "cached", answer: hit.answer.filter((a) => labels.includes(a)), confidence: hit.confidence ?? 0, defective: false, reason: "Earlier opinion of the same model on the same question content (not re-sent).", costInr: 0, at: new Date().toISOString() };
      continue;
    }
    if (!(await ctx.stillRunning())) break;
    try {
      const r = await importerAiCall({ jobId: ctx.jobId, task: "classify", override: choice, noReplace: true, models: [choice.model], system: SOLVE_SYSTEM, content: [{ type: "text", text: solveUserText(e) }], maxOutputTokens: maxOut, settings: ctx.settings, questionId: id, needsVision: false, stage: "verify-answers", reasoningEffort: "low" });
      const parsed = solveSchema.safeParse(parseModelJson(r.text));
      if (!parsed.success) throw new ImporterAiFailure("The answer was not the expected JSON.", "model_output");
      unusable = 0;
      const answer = [...new Set(parsed.data.answer.map((a) => labelFromPrinted(a, labels)).filter((x): x is string => !!x))];
      results[id] = { h, model: r.model, source: "ai", answer, confidence: parsed.data.confidence, defective: parsed.data.defective, reason: parsed.data.reason.slice(0, 300), costInr: r.costInr ?? 0, at: new Date().toISOString() };
    } catch (err) {
      if (err instanceof ImporterAiUnavailable || (err instanceof Error && err.name === "ImporterBudgetError")) {
        await save({});
        throw err;
      }
      failed.push(id);
      firstError ??= err instanceof Error ? err.message.slice(0, 300) : "request failed";
      if (err instanceof ImporterAiFailure && err.kind === "model_output" && ++unusable >= OPINION_FAIL_STOP) {
        await save({});
        throw new ImporterAiUnavailable(`${choice.model} returned ${unusable} unusable answers in a row; Verify Answers stopped. Choose another model and run it again (answers so far are kept).`);
      }
    }
    await save({});
  }
  return { ...state, results, failed, firstError };
}

export interface VaRow { id: string; label: string; saved: string[]; official: string[]; keyRaw: string | null; keyPage: number | null; category: VaCategory; confidence: number; mapping: string; ai: VaResult | null; aiStale: boolean }

/** The question-wise and paper report: computed from the current key mapping and the stored AI opinions (read-only). */
export async function verifyAnswersReport(jobId: string): Promise<{ state: VaState | null; history: VaHistoryEntry[]; rows: VaRow[]; counts: Record<VaCategory, number>; confidence: number }> {
  const [job, check, qs] = await Promise.all([prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { config: true } }), verifyAnswers(jobId), eligibleQuestions(jobId)]);
  const cfg = cfgOf(job?.config);
  const st = cfg.verifyAnswers ?? null;
  const hashOf = new Map(qs.map(({ id, e }) => [id, contentPartOf(e)]));
  const labelCount = new Map<string, number>();
  for (const r of check.rows) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1);
  const rows: VaRow[] = check.rows.map((r) => {
    const res = st?.results[r.id] ?? null;
    const aiStale = !!res && res.h !== hashOf.get(r.id);
    const ai = res && !aiStale ? res : null;
    // Two questions with the same number in the same section: the key cannot be mapped safely to either.
    const dup = (labelCount.get(r.label) ?? 0) > 1;
    const c = dup ? { category: "DUPLICATE" as const, confidence: 0 } : vaCategory({ verdict: r.verdict, code: r.code ?? undefined, official: r.official, saved: r.saved }, ai);
    return { id: r.id, label: r.label, saved: r.saved, official: r.official, keyRaw: r.keyRaw, keyPage: r.keyPage, category: c.category, confidence: c.confidence, mapping: dup ? `Question number ${r.label} occurs more than once in this import.` : r.reason, ai: res, aiStale };
  });
  const counts = { CONFIRMED: 0, MISSING: 0, INCORRECT_MAPPING: 0, DUPLICATE: 0, WITHDRAWN: 0, AI_DISAGREES: 0, MANUAL_REVIEW: 0 } as Record<VaCategory, number>;
  for (const r of rows) counts[r.category]++;
  const confidence = rows.length ? Math.round((rows.reduce((s, r) => s + r.confidence, 0) / rows.length) * 100) / 100 : 0;
  return { state: st, history: cfg.verifyAnswersHistory ?? [], rows, counts, confidence };
}

/** Appends a finished run to the job's verification history (last HISTORY_MAX kept). */
export async function recordVerifyAnswersHistory(jobId: string, st: VaState, actualInr: number): Promise<VaHistoryEntry> {
  const rep = await verifyAnswersReport(jobId);
  const entry: VaHistoryEntry = { at: new Date().toISOString(), model: st.model, status: st.status, counts: rep.counts, checked: rep.rows.length, actualInr: Math.round(actualInr * 10000) / 10000, byId: st.requestedById };
  const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId }, select: { config: true } });
  const cfg = cfgOf(j.config);
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { config: { ...cfg, verifyAnswersHistory: [entry, ...(cfg.verifyAnswersHistory ?? [])].slice(0, HISTORY_MAX) } as unknown as Prisma.InputJsonValue } });
  return entry;
}
