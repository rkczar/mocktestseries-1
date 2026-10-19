import "server-only";
import { createHash } from "node:crypto";
import { AiImportFileRole, AiImportFileStatus, AiImportJobStatus, AiImportPageStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/ai-engine/config";
import { PILOT_LIMITS, SELECTION_TASKS, SELECTION_TASK_LABELS } from "@/lib/ai-import/config";
import { getImporterSettings, jobRunSettings } from "@/lib/ai-import/settings";
import { readRoutes } from "@/lib/ai-import/routes";
import { computeModelPlan, modelsFromPlan, planOf } from "@/lib/ai-import/select";
import { estimateJobCost } from "@/lib/ai-import/estimate";
import { importerSpend } from "@/lib/ai-import/ai";
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
 * refused when a worker holds the job, when no page-reading model is suitable, or when the conservative
 * maximum does not fit what the job, the month and the all-time pilot budget still allow — budgets are
 * never raised. Spending, cost records, pages, questions and events are kept; the change is an event and
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
  const est = plan ? await estimateJobCost({ paperFacts, keyFacts, settings: { ...settings, aiEnabled: true }, plan }) : null;

  const spend = await importerSpend();
  const jobCap = Math.min(job.budgetInr, settings.budget.maxJobInr, PILOT_LIMITS.maxJobInr);
  const jobLeft = Math.max(0, jobCap - job.spentInr);
  const totalLeft = Math.max(0, Math.min(settings.budget.totalInr, PILOT_LIMITS.totalInr) - spend.allUsed);
  const monthLeft = Math.max(0, Math.min(settings.budget.monthlyInr, PILOT_LIMITS.monthlyInr) - spend.monthUsed);
  if (!unreadPages && !failedKeys.length) blocking.push("Nothing is left to read in this import (no failed or pending page), so there is nothing to reconfigure.");
  const GUIDE = "Add an image-capable model with a verified route and a known price within the per-request limit to the importer's list (Import Settings → AI Auto-Configure shows what qualifies), then reconfigure again. Limits are never raised automatically.";
  if (plan && !plan.tasks.extract.model && unreadPages) blocking.push(`No page-reading model is suitable now: ${plan.tasks.extract.reason} Nothing was changed. ${GUIDE}`);
  if (plan && failedKeys.length && !plan.tasks.key.model) blocking.push(`No answer-key model is suitable now: ${plan.tasks.key.reason} Nothing was changed.`);
  if (est && !blocking.length) {
    if (est.maxInr === null) blocking.push(`The cost of the remaining work cannot be established (${est.notes[0] ?? "missing price"}). Nothing was changed.`);
    else {
      const room = Math.min(jobLeft, totalLeft, monthLeft);
      if (est.maxInr > room) {
        const which = room === jobLeft ? `this job's budget (${formatInr(jobLeft)} left of ${formatInr(jobCap)})` : room === totalLeft ? `the all-time importer budget (${formatInr(totalLeft)} left)` : `this month's importer budget (${formatInr(monthLeft)} left)`;
        const perPage = unreadPages ? est.maxInr / unreadPages : null;
        const fit = perPage ? Math.floor(room / perPage) : 0;
        blocking.push(
          `No suitable model fits the existing budget: the conservative maximum for the remaining ${unreadPages} page(s) is ${formatInr(est.maxInr)}, above ${which}. Budgets are never raised automatically. Nothing was changed.${perPage ? ` At about ${formatInr(perPage)} per page (page reading${plan?.tasks.verify.model ? ", second read" : ""} and classification at their maximum), ${fit} page(s) fit. Options (an administrator's decision): import the paper in smaller parts${plan?.tasks.verify.model ? ", or choose a cheaper or no verification model in Import Settings (fewer independent checks)" : ""}.` : ""}`
        );
      }
    }
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
    maxInr: est?.maxInr ?? null,
    jobLeftInr: jobLeft,
    totalLeftInr: totalLeft,
    monthLeftInr: monthLeft,
    spentInr: job.spentInr,
    routesFetchedAt: snapshot?.fetchedAt ?? null,
    next: paidAiOn
      ? `After you confirm, the import is queued again with these models: only the ${unreadPages} failed or pending page(s)${failedKeys.length ? ` and ${failedKeys.length} answer-key file(s)` : ""} are read. Finished pages are not read or charged again.`
      : "Paid AI is OFF: the new models are saved on the import and it stays paused. Nothing is sent until Paid AI is switched on and the import is resumed.",
    blocking,
    proposalKey: hash({ tasks: tasks.map((t) => [t.task, t.proposed]), updatedAt: job.updatedAt.toISOString(), todo: unreadPages, keys: failedKeys.length }),
  };
  return { preview, plan, updatedAt: job.updatedAt };
}

export async function reconfigurePreview(jobId: string): Promise<ReconfigurePreview> {
  return (await build(jobId)).preview;
}

export async function reconfigureJob(input: { jobId: string; proposalKey: string; actorId: string }): Promise<ReconfigureResult> {
  const { preview, plan, updatedAt } = await build(input.jobId);
  if (preview.blocking.length) throw new ReconfigureError(preview.blocking.join(" "));
  if (preview.proposalKey !== input.proposalKey) throw new ReconfigureError("The import or the available models changed since the preview. Nothing was changed — open the preview again.");
  const queue = preview.paidAiOn;
  const from = Object.fromEntries(preview.tasks.map((t) => [t.task, t.current]));
  const to = Object.fromEntries(preview.tasks.map((t) => [t.task, t.proposed]));
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ config: unknown; status: string; updatedAt: Date; leaseUntil: Date | null }[]>`SELECT "config", "status", "updatedAt", "leaseUntil" FROM "AiImportJob" WHERE "id" = ${input.jobId} FOR UPDATE`;
    const j = locked[0];
    if (!j || j.status !== preview.status || j.updatedAt.getTime() !== updatedAt.getTime() || leased(j)) throw new ReconfigureError("The import changed state at the same moment. Nothing was changed — open the preview again.");
    const config = (j.config ?? {}) as Record<string, unknown>;
    const history = Array.isArray(config.reconfigured) ? (config.reconfigured as unknown[]) : [];
    const nextConfig = { ...config, modelPlan: plan, models: modelsFromPlan(plan!), selection: { mode: plan!.mode }, reconfigured: [...history, { at: new Date().toISOString(), byId: input.actorId, from, to, maxInr: preview.maxInr }] };
    await tx.aiImportJob.update({
      where: { id: input.jobId },
      data: queue
        ? { config: nextConfig as unknown as Prisma.InputJsonValue, status: AiImportJobStatus.QUEUED, pauseReason: null, errorMessage: null, leaseOwner: null, leaseUntil: null }
        : { config: nextConfig as unknown as Prisma.InputJsonValue, pauseReason: "Models reconfigured. Paid AI is OFF — switch it on in Import Settings, then resume." },
    });
    // Finished pages are never touched; failed pages get their next attempt with the new models.
    if (queue) await tx.aiImportPage.updateMany({ where: { jobId: input.jobId, status: AiImportPageStatus.FAILED }, data: { status: AiImportPageStatus.PENDING } });
    const summary = preview.tasks.filter((t) => t.current !== t.proposed).map((t) => `${t.label}: ${t.current ?? "none"} → ${t.proposed ?? "none"}${t.substituted ? ` (substitute: ${t.substituted.from} cannot be used — ${t.substituted.why.slice(0, 120)})` : ""}`).join("; ") || "same models, current routes and prices";
    await tx.aiImportEvent.create({ data: { jobId: input.jobId, type: "MODEL_RECONFIGURED", message: `Models reconfigured by an administrator (${summary}). ${preview.retryPages} page(s) to read, conservative maximum ${formatInr(preview.maxInr)}; ${preview.donePages} finished page(s) kept.${queue ? " Queued again." : " Paid AI is OFF: the import stays paused."}`.slice(0, 1000), data: { from, to, maxInr: preview.maxInr, retryPages: preview.retryPages, queued: queue }, actorId: input.actorId } });
    await tx.auditLog.create({ data: { actorId: input.actorId, action: "AI_IMPORTER_JOB_RECONFIGURED", entityType: "AiImportJob", entityId: input.jobId, metadata: { from, to, maxInr: preview.maxInr, retryPages: preview.retryPages, donePages: preview.donePages, spentInr: preview.spentInr, queued: queue, aiRequestsSent: 0 } } });
  });
  if (queue) kickWorker();
  return { queued: queue, message: queue ? `Reconfigured and queued: ${preview.retryPages} page(s) will be read with the new models; ${preview.donePages} finished page(s) are kept.` : "Models saved on the import. Paid AI is OFF, so it stays paused — nothing was sent." };
}
