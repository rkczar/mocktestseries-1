import "server-only";
import crypto from "node:crypto";
import { AiImportJobStatus, AiImportQuestionStatus, AiImportPageStatus, type AiImportJob, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { JOB_STAGES, normalizeImporterSettings, type ImporterSettings, type JobStage } from "@/lib/ai-import/config";
import { runAnalysis } from "@/lib/ai-import/analyze";
import { runAiPages, runLocalPasses, type StepContext } from "@/lib/ai-import/process";
import { runKeyFiles } from "@/lib/ai-import/keys";
import { runPostProcessing } from "@/lib/ai-import/post";
import { runImport, type ImportPlan } from "@/lib/ai-import/adapter";
import { logEvent } from "@/lib/ai-import/jobs";
import { ImporterAiUnavailable, ImporterBudgetError, resetRateLimitStreak } from "@/lib/ai-import/ai";
import { summarizeFailures } from "@/lib/ai-import/failure";
import { reconcileJob } from "@/lib/ai-import/summary";
import { removeVaultDir } from "@/lib/ai-import/vault";
import { autoCleanup } from "@/lib/ai-import/storage";
import { computeModelPlan, modelsFromPlan, planOf } from "@/lib/ai-import/select";

/**
 * The importer's durable background worker (scripts/ai-import-worker.ts,
 * cron + flock, outside the PM2 web workers). One job at a time; each job is
 * leased (leaseUntil) and every stage is checkpointed in the database, so a
 * killed worker resumes where it stopped. Pause / cancel are honoured between
 * pages. While a Live CBT is running, no new job step starts.
 */

const LEASE_MS = 5 * 60_000;
const WORKER_ID = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

async function liveCbtRunning(): Promise<boolean> {
  const now = new Date();
  const n = await prisma.liveTest.count({ where: { OR: [{ status: "LIVE" }, { status: "SCHEDULED", startAt: { lte: new Date(now.getTime() + 15 * 60_000) }, endAt: { gte: now } }] } });
  return n > 0;
}

async function lease(jobId: string): Promise<boolean> {
  const r = await prisma.aiImportJob.updateMany({
    where: { id: jobId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }, { leaseOwner: WORKER_ID }] },
    data: { leaseOwner: WORKER_ID, leaseUntil: new Date(Date.now() + LEASE_MS), heartbeatAt: new Date() },
  });
  return r.count === 1;
}

/**
 * A worker-side status change that only applies while this worker still leases the job in one of the
 * expected states — so a cancellation (or any admin change) made meanwhile is never overwritten.
 */
async function transition(jobId: string, from: AiImportJobStatus[], data: Prisma.AiImportJobUpdateManyMutationInput): Promise<boolean> {
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: { in: from }, leaseOwner: WORKER_ID }, data });
  return r.count === 1;
}

async function stage(jobId: string, s: JobStage) {
  await logEvent(jobId, "STAGE", JOB_STAGES[s], { stage: s });
}

async function release(jobId: string) {
  await prisma.aiImportJob.updateMany({ where: { id: jobId, leaseOwner: WORKER_ID }, data: { leaseOwner: null, leaseUntil: null } });
}

function makeContext(job: AiImportJob, settings: ImporterSettings, names: { exam: string; subject: string | null }): StepContext {
  return {
    job,
    settings,
    examName: names.exam,
    subjectName: names.subject,
    stillRunning: async () => {
      const j = await prisma.aiImportJob.findUnique({ where: { id: job.id }, select: { status: true, leaseOwner: true } });
      if (!j || j.leaseOwner !== WORKER_ID) return false;
      await prisma.aiImportJob.update({ where: { id: job.id }, data: { heartbeatAt: new Date(), leaseUntil: new Date(Date.now() + LEASE_MS) } });
      return j.status === AiImportJobStatus.PROCESSING || j.status === AiImportJobStatus.IMPORTING;
    },
  };
}

async function processJob(job: AiImportJob): Promise<void> {
  // Settings frozen at confirmation; the AI switch, models and budget follow the CURRENT settings
  // (an admin who turns AI off or lowers limits mid-job is obeyed).
  const current = await getImporterSettings();
  const frozen = job.config ? normalizeImporterSettings(job.config) : current;
  // Privacy: the stricter of the confirmed and the current settings. Budgets: the current (lowered limits apply).
  // The importer's model list: the current one, so a model withdrawn from it mid-job is never used again.
  const privacy: ImporterSettings["privacy"] = { zdr: frozen.privacy.zdr || current.privacy.zdr, dataCollection: frozen.privacy.dataCollection === "deny" || current.privacy.dataCollection === "deny" ? "deny" : "allow" };
  const base: ImporterSettings = { ...frozen, aiEnabled: current.aiEnabled && frozen.aiEnabled, privacy, budget: current.budget, selection: frozen.selection, importerModels: current.importerModels };
  // Models come only from the plan frozen at confirmation (a job confirmed before automatic selection gets one now).
  let plan = planOf(job.config);
  if (!plan && base.aiEnabled) {
    plan = await computeModelPlan(base, { refresh: true });
    await prisma.aiImportJob.update({ where: { id: job.id }, data: { config: { ...((job.config as Record<string, unknown>) ?? {}), modelPlan: plan } as unknown as Prisma.InputJsonValue } });
    await logEvent(job.id, "MODEL_PLAN", `Models chosen (${plan.mode}): ${Object.values(plan.tasks).map((t) => `${t.task}: ${t.model ?? "none"}`).join(", ")}`);
  }
  const settings: ImporterSettings = { ...base, models: plan ? modelsFromPlan(plan) : { ...base.models, extract: null, extractFallbacks: [], verify: null, classify: null, key: null } };
  const [exam, subject] = await Promise.all([
    prisma.exam.findUnique({ where: { id: job.examId }, select: { name: true } }),
    job.subjectId ? prisma.subject.findUnique({ where: { id: job.subjectId }, select: { name: true } }) : null,
  ]);
  if (job.status === AiImportJobStatus.QUEUED) {
    if (!(await transition(job.id, [AiImportJobStatus.QUEUED], { status: AiImportJobStatus.PROCESSING, startedAt: job.startedAt ?? new Date() }))) return;
    await logEvent(job.id, "PROCESSING", "Processing started");
  }
  const ctx = makeContext({ ...job, status: AiImportJobStatus.PROCESSING }, settings, { exam: exam?.name ?? "Exam", subject: subject?.name ?? null });
  // The rate-limit circuit breaker counts per run: a resumed or retried job starts again at zero.
  resetRateLimitStreak(job.id);
  try {
    await stage(job.id, "PAGES");
    await runLocalPasses(ctx);
    if (!(await ctx.stillRunning())) return;
    await stage(job.id, "EXTRACT");
    const { skippedNoAi } = await runAiPages(ctx);
    if (skippedNoAi) await logEvent(job.id, "AI_SKIPPED", `${skippedNoAi} page(s) need AI vision, which is switched off — their questions are flagged or missing.`);
    if (!(await ctx.stillRunning())) return;
    await stage(job.id, "KEY");
    await runKeyFiles(ctx);
    if (!(await ctx.stillRunning())) return;
    await stage(job.id, "VALIDATE");
    await runPostProcessing(ctx);
    if (!(await ctx.stillRunning())) return;
    const [failed, skippedPages, questions, failedKeys] = await Promise.all([
      prisma.aiImportPage.findMany({ where: { jobId: job.id, status: AiImportPageStatus.FAILED }, select: { errorMessage: true } }),
      prisma.aiImportPage.count({ where: { jobId: job.id, status: AiImportPageStatus.SKIPPED, kind: "SCANNED" } }),
      prisma.aiImportQuestion.count({ where: { jobId: job.id } }),
      prisma.aiImportFile.count({ where: { jobId: job.id, role: "ANSWER_KEY", status: "ANALYZED", errorMessage: { not: null } } }),
    ]);
    const failedPages = failed.length;
    const causes = summarizeFailures(failed.map((p) => p.errorMessage));
    // A job that produced nothing says why, and what to do next (never a silent "ready to import").
    const why = failedPages
      ? `${failedPages} page(s) failed (${causes.text})${questions === 0 ? ", so no question was extracted" : ""}${failedKeys ? `; ${failedKeys} answer-key file(s) could not be read` : ""} — use Retry failed pages to read only those again (finished pages are not read or charged again).`
      : failedKeys
        ? `${failedKeys} answer-key file(s) could not be read — use Retry failed pages to read the key again.`
        : questions === 0 && skippedPages
        ? `No questions could be read: ${skippedPages} scanned page(s) have no text layer and need AI vision, which is switched off. Upload a digital PDF or Word file of the paper, or ask the owner to approve paid AI for the importer.`
        : questions === 0
          ? "No numbered questions were recognized in this file. Check that it is a question paper (numbered questions with options A–D)."
          : null;
    if (!(await transition(job.id, [AiImportJobStatus.PROCESSING], { status: AiImportJobStatus.NEEDS_REVIEW, finishedAt: new Date(), errorMessage: why }))) return;
    const summary = await reconcileJob(job.id);
    await logEvent(job.id, "PROCESSED", `Processing finished${failedPages ? ` (${failedPages} page(s) failed)` : ""}. ${summary.extracted} question(s) extracted, ${summary.eligibleImport} ready to import.`);
    await removeVaultDir("work", job.id).catch(() => undefined);
    // One-page flow: eligible questions go to the Bulk Import right away (as Draft unless publishing was chosen).
    const auto = (job.config as { autoImport?: { mode: "DRAFT" | "PUBLISH_ALL"; requestedById: string; done?: boolean } | null } | null)?.autoImport;
    if (auto && !auto.done) {
      const fresh = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id }, select: { config: true } });
      const cfg = { ...((fresh.config as Record<string, unknown>) ?? {}), autoImport: { ...auto, done: true } };
      if (summary.eligibleImport > 0) {
        const plan: ImportPlan = { mode: auto.mode, questionIds: null, requestedById: auto.requestedById, requestedAt: new Date().toISOString() };
        if (await transition(job.id, [AiImportJobStatus.NEEDS_REVIEW], { status: AiImportJobStatus.IMPORTING, config: { ...cfg, importPlan: plan } as unknown as Prisma.InputJsonValue })) {
          await logEvent(job.id, "IMPORT_REQUESTED", `Automatic import of ${summary.eligibleImport} eligible question(s) as Draft through the Bulk Import${auto.mode === "PUBLISH_ALL" ? ", then publishing those that pass every check" : ""}`, { mode: auto.mode, automatic: true });
        }
      } else {
        await transition(job.id, [AiImportJobStatus.NEEDS_REVIEW], { config: cfg as Prisma.InputJsonValue });
        await logEvent(job.id, "IMPORT_SKIPPED", "Automatic import: no question passed every check, so nothing was sent to the Bulk Import. Review the questions that need attention.");
      }
    }
  } catch (e) {
    if (e instanceof ImporterBudgetError) {
      if (await transition(job.id, [AiImportJobStatus.PROCESSING], { status: AiImportJobStatus.PAUSED_BUDGET, pauseReason: e.message })) await logEvent(job.id, "PAUSED_BUDGET", e.message, { scope: e.scope });
      return;
    }
    if (e instanceof ImporterAiUnavailable) {
      if (await transition(job.id, [AiImportJobStatus.PROCESSING], { status: AiImportJobStatus.PAUSED, pauseReason: e.message })) await logEvent(job.id, "PAUSED", e.message);
      return;
    }
    throw e;
  }
}

async function importJob(job: AiImportJob): Promise<void> {
  const plan = (job.config as { importPlan?: ImportPlan } | null)?.importPlan;
  if (!plan) {
    await transition(job.id, [AiImportJobStatus.IMPORTING], { status: AiImportJobStatus.NEEDS_REVIEW, errorMessage: "Import request missing — choose an import option again." });
    return;
  }
  const settings = await getImporterSettings();
  const ctx = makeContext({ ...job, status: AiImportJobStatus.IMPORTING }, { ...settings, aiEnabled: false }, { exam: "", subject: null });
  // Edits made since processing are re-checked first (no AI calls in this pass).
  await runPostProcessing(ctx);
  // Image processing for a large batch can take a while: hold the lease for it.
  await prisma.aiImportJob.update({ where: { id: job.id }, data: { leaseUntil: new Date(Date.now() + 60 * 60_000), heartbeatAt: new Date() } });
  const r = await runImport(job, plan, settings);
  const summary = await reconcileJob(job.id);
  const done = summary.unaccounted === 0 && summary.pendingDecision === 0;
  const issues = summary.needsCorrection + summary.notImportable + summary.importFailed + summary.duplicates > 0 || r.notPublished > 0;
  const latest = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id }, select: { config: true } });
  const config = { ...((latest.config as Record<string, unknown>) ?? {}), importPlan: null, lastImport: { ...plan, result: r, finishedAt: new Date().toISOString() } };
  await transition(job.id, [AiImportJobStatus.IMPORTING], { status: done ? (issues ? AiImportJobStatus.COMPLETED_WITH_ISSUES : AiImportJobStatus.COMPLETED) : AiImportJobStatus.NEEDS_REVIEW, finishedAt: new Date(), config: config as Prisma.InputJsonValue });
}

/** One worker run: picks jobs that need work, oldest first, within a time budget. */
export async function runWorker(budgetMs = 9 * 60_000): Promise<{ handled: number; skippedForLiveCbt: boolean }> {
  const started = Date.now();
  let handled = 0;
  // Leases of a crashed worker expire; their jobs are picked up again.
  for (;;) {
    if (Date.now() - started > budgetMs) break;
    if (await liveCbtRunning()) return { handled, skippedForLiveCbt: true };
    const job = await prisma.aiImportJob.findFirst({
      where: {
        status: { in: [AiImportJobStatus.ANALYZING, AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING, AiImportJobStatus.IMPORTING] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      orderBy: { updatedAt: "asc" },
    });
    if (!job) break;
    if (!(await lease(job.id))) continue;
    handled++;
    try {
      if (job.status === AiImportJobStatus.ANALYZING) await runAnalysis(job.id);
      else if (job.status === AiImportJobStatus.IMPORTING) await importJob(job);
      else await processJob(job);
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 500) : "unexpected error";
      const back = job.status === AiImportJobStatus.IMPORTING ? AiImportJobStatus.NEEDS_REVIEW : job.status === AiImportJobStatus.ANALYZING ? AiImportJobStatus.DRAFT : AiImportJobStatus.FAILED;
      // Only from the state this run was in: a job cancelled meanwhile stays cancelled.
      const from = job.status === AiImportJobStatus.QUEUED ? [AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING] : [job.status];
      if (await transition(job.id, from, { status: back, errorMessage: `Stopped by an unexpected error: ${message}` })) await logEvent(job.id, "ERROR", `Stopped: ${message}`);
      await removeVaultDir("work", job.id).catch(() => undefined);
      console.error(`[ai-import] job ${job.id} failed: ${message}`);
    } finally {
      await release(job.id);
    }
  }
  // Retention housekeeping (only when enabled in Import Settings; reference-checked).
  await autoCleanup().catch((e) => console.error(`[ai-import] auto cleanup skipped: ${e instanceof Error ? e.message : "error"}`));
  return { handled, skippedForLiveCbt: false };
}

/** Questions of a job that are still in a working state (used by reconciliation). */
export const WORKING_STATES: AiImportQuestionStatus[] = [AiImportQuestionStatus.EXTRACTED];
