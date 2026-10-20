import "server-only";
import { createHash } from "node:crypto";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportPageStatus, AiImportQuestionStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/ai-engine/config";
import { SELECTION_TASKS, SELECTION_TASK_LABELS, type ImporterSettings } from "@/lib/ai-import/config";
import { getImporterSettings, jobRunSettings } from "@/lib/ai-import/settings";
import { readRoutes } from "@/lib/ai-import/routes";
import { computeModelPlan, modelsFromPlan, planOf } from "@/lib/ai-import/select";
import { estimateJobCost } from "@/lib/ai-import/estimate";
import { kickWorker } from "@/lib/ai-import/kick";
import type { FileFacts, JobAnalysis } from "@/lib/ai-import/analyze";
import type { ModelPlan } from "@/lib/ai-import/selection-types";
import type { ReconfigurePreview, ReconfigureResult } from "@/lib/ai-import/autoconfig-types";

/**
 * "Reconfigure Models for This Job" — an explicit action for a PAUSED import, never automatic. The job's
 * models are chosen again from the CURRENT Import Settings (its own model list, manual or automatic
 * selection, privacy, per-request limit) on provider routes read from OpenRouter now (free metadata,
 * no AI request). The preview prices only the work still to do: finished pages are kept and never read
 * or charged again, only failed and pending pages (and answer keys whose reading failed) are read. It is
 * refused when a worker holds the job, when no page-reading model is suitable, or when the cost of the remaining
 * work cannot be priced. The administrator confirms the shown cost (there are no importer job / monthly /
 * all-time caps). Spending, cost records, pages, questions and events are kept; the change is an event and
 * an audit entry. With Paid AI off the new models are saved and the job stays paused.
 *
 * Eligibility is the selection engine's own (select.ts evaluateModel / choose), judged with the settings the
 * worker will run the job with (settings.ts jobRunSettings: the stricter privacy, the current budgets and model
 * list) — the same checks the worker repeats before every request. When a manual choice cannot be used, the
 * cheapest model automatic selection would accept is proposed instead and the substitution is explained.
 */

export class ReconfigureError extends Error {}

const RECONFIGURABLE: AiImportJobStatus[] = [AiImportJobStatus.PAUSED, AiImportJobStatus.PAUSED_BUDGET];
const leased = (j: { leaseUntil: Date | null }) => !!j.leaseUntil && j.leaseUntil > new Date();
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

/** Whether a job may be offered the action (the server re-checks everything on preview and apply). */
export function canReconfigure(j: { status: string; leaseUntil: Date | null; confirmedAt: Date | null }): boolean {
  return RECONFIGURABLE.includes(j.status as AiImportJobStatus) && !!j.confirmedAt && !leased(j);
}

async function build(jobId: string): Promise<{ preview: ReconfigurePreview; plan: ModelPlan | null; updatedAt: Date }> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, include: { files: { select: { id: true, role: true, status: true, errorMessage: true, pageCount: true } } } });
  if (!job) throw new ReconfigureError("Import job not found.");
  if (!RECONFIGURABLE.includes(job.status)) throw new ReconfigureError("Only a paused import can be reconfigured. Pause it first.");
  if (!job.confirmedAt) throw new ReconfigureError("This import was never confirmed for processing, so it has no models to reconfigure.");
  if (leased(job)) throw new ReconfigureError(`A worker still holds this import (until ${job.leaseUntil!.toISOString().slice(11, 19)} UTC). Nothing was changed — try again when it has stopped.`);
  const current = await getImporterSettings();
  // The worker's run settings for this job, with the models and selection mode of the CURRENT Import Settings.
  const settings = { ...jobRunSettings(job.config, current), selection: current.selection, models: current.models };
  const blocking: string[] = [];
  let snapshot = null;
  try {
    snapshot = await readRoutes(settings.importerModels);
  } catch (e) {
    blocking.push(`Provider routes could not be read from OpenRouter (${e instanceof Error ? e.message.slice(0, 160) : "error"}). Nothing was changed.`);
  }
  const plan = snapshot ? await computeModelPlan(settings, { refresh: false, snapshot, substitute: true, jobId }) : null;
  const confirmed = planOf(job.config);

  const remaining = plan ? await priceRemainingWork(job, plan, settings) : null;
  const pages = remaining?.pages ?? (await prisma.aiImportPage.findMany({ where: { jobId }, select: { status: true } }));
  const unreadPages = remaining?.unreadPages ?? 0;
  const failedKeys = job.files.filter((f) => f.role === AiImportFileRole.ANSWER_KEY && f.status === AiImportFileStatus.ANALYZED && f.errorMessage);
  const est = remaining?.estimate ?? null;
  if (!unreadPages && !failedKeys.length) blocking.push("Nothing is left to read in this import (no failed or pending page), so there is nothing to reconfigure.");
  const GUIDE = "Add an image-capable model with a verified route and a known price within the per-request limit to the importer's list (Import Settings → AI Auto-Configure shows what qualifies), then reconfigure again. Limits are never raised automatically.";
  if (plan && !plan.tasks.extract.model && unreadPages) blocking.push(`No page-reading model is suitable now: ${plan.tasks.extract.reason} Nothing was changed. ${GUIDE}`);
  if (plan && failedKeys.length && !plan.tasks.key.model) blocking.push(`No answer-key model is suitable now: ${plan.tasks.key.reason} Nothing was changed.`);
  if (est && !blocking.length) {
    if (remaining!.maxInr === null) blocking.push(`The cost of the remaining work cannot be established (${est.notes[0] ?? "missing price"}). Nothing was changed.`);
  }
  const tasks = SELECTION_TASKS.map((t) => ({ task: t, label: SELECTION_TASK_LABELS[t], current: confirmed?.tasks[t]?.model ?? null, proposed: plan?.tasks[t].model ?? null, maxInr: plan?.tasks[t].maxInr ?? null, reason: plan?.tasks[t].reason ?? "Not computed.", substituted: plan?.tasks[t].substituted ?? null, quality: "not_tested" as const }));
  const paidAiOn = current.aiEnabled;
  const preview: ReconfigurePreview = {
    jobId,
    title: job.title,
    status: job.status,
    computedAt: new Date().toISOString(),
    aiRequestsSent: 0,
    paidAiOn,
    tasks,
    donePages: pages.filter((p) => p.status === AiImportPageStatus.DONE).length,
    retryPages: unreadPages,
    failedKeyFiles: failedKeys.length,
    estimateInr: est?.totalInr ?? null,
    maxInr: remaining?.maxInr ?? null,
    spentInr: job.spentInr,
    routesFetchedAt: snapshot?.fetchedAt ?? null,
    next: paidAiOn
      ? `After you confirm, the import is queued again with these models: only the ${unreadPages} failed or pending page(s)${failedKeys.length ? ` and ${failedKeys.length} answer-key file(s)` : ""} are read. Finished pages are not read or charged again.`
      : "Paid AI is OFF: the new models are saved on the import and it stays paused. Nothing is sent until Paid AI is switched on and the import is resumed.",
    blocking,
    // The shown cost is part of what is confirmed: a price change after the preview needs a fresh confirmation.
    proposalKey: hash({ tasks: tasks.map((t) => [t.task, t.proposed]), updatedAt: job.updatedAt.toISOString(), todo: unreadPages, keys: failedKeys.length, maxPaise: remaining?.maxInr == null ? null : Math.round(remaining.maxInr * 100) }),
  };
  return { preview, plan, updatedAt: job.updatedAt };
}

export async function reconfigurePreview(jobId: string): Promise<ReconfigurePreview> {
  return (await build(jobId)).preview;
}

export async function reconfigureJob(input: { jobId: string; proposalKey: string; actorId: string }): Promise<ReconfigureResult> {
  const { preview, plan, updatedAt } = await build(input.jobId);
  if (preview.blocking.length) throw new ReconfigureError(preview.blocking.join(" "));
  if (preview.proposalKey !== input.proposalKey) throw new ReconfigureError("The import, the available models or their cost changed since the preview. Nothing was changed — open the preview again and confirm the new cost.");
  const queue = preview.paidAiOn;
  const from = Object.fromEntries(preview.tasks.map((t) => [t.task, t.current]));
  const to = Object.fromEntries(preview.tasks.map((t) => [t.task, t.proposed]));
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ config: unknown; status: string; updatedAt: Date; leaseUntil: Date | null }[]>`SELECT "config", "status", "updatedAt", "leaseUntil" FROM "AiImportJob" WHERE "id" = ${input.jobId} FOR UPDATE`;
    const j = locked[0];
    if (!j || j.status !== preview.status || j.updatedAt.getTime() !== updatedAt.getTime() || leased(j)) throw new ReconfigureError("The import changed state at the same moment. Nothing was changed — open the preview again.");
    const config = (j.config ?? {}) as Record<string, unknown>;
    const current = await tx.aiImportJob.findUniqueOrThrow({ where: { id: input.jobId }, select: { budgetInr: true, spentInr: true } });
    const confirmedMax = Math.max(current.budgetInr, Math.round((current.spentInr + (preview.maxInr ?? 0)) * 10_000) / 10_000);
    const history = Array.isArray(config.reconfigured) ? (config.reconfigured as unknown[]) : [];
    const nextConfig = { ...config, modelPlan: plan, models: modelsFromPlan(plan!), selection: { mode: plan!.mode }, reconfigured: [...history, { at: new Date().toISOString(), byId: input.actorId, from, to, maxInr: preview.maxInr }] };
    await tx.aiImportJob.update({
      where: { id: input.jobId },
      // The confirmed maximum now covers what was spent plus the maximum shown for the remaining work.
      data: queue
        ? { config: nextConfig as unknown as Prisma.InputJsonValue, budgetInr: confirmedMax, status: AiImportJobStatus.QUEUED, pauseReason: null, errorMessage: null, leaseOwner: null, leaseUntil: null }
        : { config: nextConfig as unknown as Prisma.InputJsonValue, budgetInr: confirmedMax, pauseReason: "Models reconfigured. Paid AI is OFF — switch it on in Import Settings, then resume." },
    });
    // Finished pages are never touched; failed pages get their next attempt with the new models.
    if (queue) await tx.aiImportPage.updateMany({ where: { jobId: input.jobId, status: AiImportPageStatus.FAILED }, data: { status: AiImportPageStatus.PENDING } });
    const summary = preview.tasks.filter((t) => t.current !== t.proposed).map((t) => `${t.label}: ${t.current ?? "none"} → ${t.proposed ?? "none"}${t.substituted ? ` (substitute: ${t.substituted.from} cannot be used — ${t.substituted.why.slice(0, 120)})` : ""}`).join("; ") || "same models, current routes and prices";
    await tx.aiImportEvent.create({ data: { jobId: input.jobId, type: "MODEL_RECONFIGURED", message: `Models reconfigured by an administrator (${summary}). ${preview.retryPages} page(s) to read, conservative maximum ${formatInr(preview.maxInr)}; ${preview.donePages} finished page(s) kept.${queue ? " Queued again." : " Paid AI is OFF: the import stays paused."}`.slice(0, 1000), data: { from, to, maxInr: preview.maxInr, retryPages: preview.retryPages, queued: queue, confirmedMaxInr: confirmedMax }, actorId: input.actorId } });
    await tx.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORTER_JOB_RECONFIGURED", entityType: "AiImportJob", entityId: input.jobId, metadata: { from, to, maxInr: preview.maxInr, retryPages: preview.retryPages, donePages: preview.donePages, spentInr: preview.spentInr, queued: queue, aiRequestsSent: 0 } } });
  });
  if (queue) kickWorker();
  return { queued: queue, message: queue ? `Reconfigured and queued: ${preview.retryPages} page(s) will be read with the new models; ${preview.donePages} finished page(s) are kept.` : "Models saved on the import. Paid AI is OFF, so it stays paused — nothing was sent." };
}

export interface RemainingWork {
  pages: { status: AiImportPageStatus }[];
  /** Failed + pending pages (or every page when processing never reached one). */
  unreadPages: number;
  failedKeyFiles: number;
  /** Open questions without a topic: the next run classifies them again. */
  toClassify: number;
  estimate: Awaited<ReturnType<typeof estimateJobCost>>;
  /** Conservative maximum of everything the next run may send (null: a price is missing). */
  maxInr: number | null;
}

/**
 * The conservative maximum of the work still to do for an import with `plan`: failed and pending pages (each
 * priced as a page the AI reads), answer keys whose reading failed, and the classification (and, when enabled,
 * the independent answer) of open questions that still need it. Used by Reconfigure and by Resume / Retry,
 * which ask for a renewed confirmation when it does not fit the confirmed maximum. No AI request.
 */
export async function priceRemainingWork(job: { id: string; analysis: Prisma.JsonValue | null; files: { id: string; role: AiImportFileRole; status: AiImportFileStatus; errorMessage: string | null; pageCount: number | null }[] }, plan: ModelPlan, settings: ImporterSettings): Promise<RemainingWork> {
  const jobId = job.id;
  const pages = await prisma.aiImportPage.findMany({ where: { jobId }, select: { fileId: true, pageNumber: true, status: true, kind: true, textChars: true, imageCount: true } });
  const todo = pages.filter((p) => p.status === AiImportPageStatus.FAILED || p.status === AiImportPageStatus.PENDING);
  const failedKeys = job.files.filter((f) => f.role === AiImportFileRole.ANSWER_KEY && f.status === AiImportFileStatus.ANALYZED && f.errorMessage);
  // Only the remaining work is priced: one file entry per paper with its failed / pending pages.
  const byFile = new Map<string, typeof todo>();
  for (const p of todo) byFile.set(p.fileId, [...(byFile.get(p.fileId) ?? []), p]);
  const paperFacts: FileFacts[] = [...byFile.values()].map((ps) => ({
    kind: "PDF",
    pages: ps.length,
    textPages: 0,
    scannedPages: ps.filter((p) => p.kind === "SCANNED").length,
    blankPages: 0,
    embeddedImages: ps.reduce((a, p) => a + (p.imageCount ?? 0), 0),
    localQuestionCount: 0,
    questionTypes: {},
    answerKeyDetected: false,
    formulasLikely: false,
    tablesLikely: false,
    documentType: "QUESTION_PAPER",
    notes: [],
    // Every remaining page is priced as a page the AI reads (the worst case).
    pagesDetail: ps.map((p) => ({ page: p.pageNumber, textChars: p.textChars ?? 0, images: p.imageCount ?? 0, kind: p.kind === "SCANNED" ? ("SCANNED" as const) : ("TEXT" as const), risk: p.kind === "SCANNED" ? [] : ["unreliable"], localQuestions: 0 })),
  }));
  // Paused before processing reached its first page: nothing was read yet, so the whole analyzed job remains.
  const analysis = job.analysis as unknown as JobAnalysis | null;
  const notStarted = pages.length === 0;
  const allFacts = (role: string) => (analysis?.files ?? []).filter((f) => f.role === role && f.facts).map((f) => f.facts!);
  if (notStarted) paperFacts.push(...allFacts(AiImportFileRole.PAPER));
  const unreadPages = notStarted ? allFacts(AiImportFileRole.PAPER).reduce((a, f) => a + f.pages, 0) : todo.length;
  const keyFacts = notStarted ? allFacts(AiImportFileRole.ANSWER_KEY) : failedKeys.map((f) => ({ ...paperFacts[0], kind: "PDF", pages: f.pageCount ?? 1, scannedPages: f.pageCount ?? 1, documentType: "ANSWER_KEY" as const, pagesDetail: [] }) as FileFacts);
  const est = await estimateJobCost({ paperFacts, keyFacts, settings: { ...settings, aiEnabled: true }, plan });
  // Post-processing classifies every open question still without a topic (and asks for an independent answer
  // when enabled): price those too, at the same per-request maximum and fallback allowance as the estimate.
  const open = await prisma.aiImportQuestion.findMany({ where: { jobId, status: { in: [AiImportQuestionStatus.EXTRACTED, AiImportQuestionStatus.READY, AiImportQuestionStatus.NEEDS_CORRECTION, AiImportQuestionStatus.NOT_IMPORTABLE, AiImportQuestionStatus.DUPLICATE] } }, select: { topicId: true, taxonomySource: true, aiAnswer: true } });
  const toClassify = open.filter((q) => !q.topicId && !q.taxonomySource?.startsWith("admin")).length;
  const toSolve = settings.verification.independentAnswer ? open.filter((q) => !q.aiAnswer.length).length : 0;
  const perRequest = (c: { maxInr: number | null } | undefined) => (c?.maxInr == null ? null : (settings.budget.retryTransient ? 2 : 1) * c.maxInr + (settings.budget.allowPricierFallback ? Math.max(c.maxInr, settings.budget.maxRequestInr) : c.maxInr));
  const classifyEach = plan.tasks.classify.model ? perRequest(plan.tasks.classify) : 0;
  const solveEach = toSolve && plan.tasks.verify.model ? perRequest(plan.tasks.verify) : 0;
  const extra = classifyEach === null || solveEach === null ? null : Math.ceil(toClassify / 20) * classifyEach + toSolve * solveEach;
  const maxInr = est.maxInr === null || extra === null ? null : Math.round((est.maxInr + extra) * 10_000) / 10_000;
  return { pages, unreadPages, failedKeyFiles: failedKeys.length, toClassify, estimate: est, maxInr };
}
