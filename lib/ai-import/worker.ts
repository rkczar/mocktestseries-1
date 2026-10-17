import "server-only";
import crypto from "node:crypto";
import { AiImportJobStatus, AiImportQuestionStatus, AiImportPageStatus, type AiImportJob, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { normalizeImporterSettings, type ImporterSettings } from "@/lib/ai-import/config";
import { runAnalysis } from "@/lib/ai-import/analyze";
import { runAiPages, runLocalPasses, type StepContext } from "@/lib/ai-import/process";
import { runKeyFiles } from "@/lib/ai-import/keys";
import { runPostProcessing } from "@/lib/ai-import/post";
import { runImport, type ImportPlan } from "@/lib/ai-import/adapter";
import { logEvent } from "@/lib/ai-import/jobs";
import { ImporterAiUnavailable, ImporterBudgetError } from "@/lib/ai-import/ai";
import { reconcileJob } from "@/lib/ai-import/summary";
import { removeVaultDir } from "@/lib/ai-import/vault";
import { autoCleanup } from "@/lib/ai-import/storage";

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
  const settings: ImporterSettings = { ...frozen, aiEnabled: current.aiEnabled && frozen.aiEnabled, models: current.models, privacy: current.privacy, budget: current.budget };
  const [exam, subject] = await Promise.all([
    prisma.exam.findUnique({ where: { id: job.examId }, select: { name: true } }),
    job.subjectId ? prisma.subject.findUnique({ where: { id: job.subjectId }, select: { name: true } }) : null,
  ]);
  if (job.status === AiImportJobStatus.QUEUED) {
    await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.PROCESSING, startedAt: job.startedAt ?? new Date() } });
    await logEvent(job.id, "PROCESSING", "Processing started");
  }
  const ctx = makeContext({ ...job, status: AiImportJobStatus.PROCESSING }, settings, { exam: exam?.name ?? "Exam", subject: subject?.name ?? null });
  try {
    await runLocalPasses(ctx);
    if (!(await ctx.stillRunning())) return;
    const { skippedNoAi } = await runAiPages(ctx);
    if (skippedNoAi) await logEvent(job.id, "AI_SKIPPED", `${skippedNoAi} page(s) need AI vision, which is switched off — their questions are flagged or missing.`);
    if (!(await ctx.stillRunning())) return;
    await runKeyFiles(ctx);
    if (!(await ctx.stillRunning())) return;
    await runPostProcessing(ctx);
    if (!(await ctx.stillRunning())) return;
    const failedPages = await prisma.aiImportPage.count({ where: { jobId: job.id, status: AiImportPageStatus.FAILED } });
    await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.NEEDS_REVIEW, finishedAt: new Date(), errorMessage: failedPages ? `${failedPages} page(s) failed — use Resume to retry them once.` : null } });
    await reconcileJob(job.id);
    await logEvent(job.id, "PROCESSED", `Processing finished${failedPages ? ` (${failedPages} page(s) failed)` : ""}. Review the summary and choose how to import.`);
    await removeVaultDir("work", job.id).catch(() => undefined);
  } catch (e) {
    if (e instanceof ImporterBudgetError) {
      await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.PAUSED_BUDGET, pauseReason: e.message } });
      await logEvent(job.id, "PAUSED_BUDGET", e.message, { scope: e.scope });
      return;
    }
    if (e instanceof ImporterAiUnavailable) {
      await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.PAUSED, pauseReason: e.message } });
      await logEvent(job.id, "PAUSED", e.message);
      return;
    }
    throw e;
  }
}

async function importJob(job: AiImportJob): Promise<void> {
  const plan = (job.config as { importPlan?: ImportPlan } | null)?.importPlan;
  if (!plan) {
    await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: AiImportJobStatus.NEEDS_REVIEW, errorMessage: "Import request missing — choose an import option again." } });
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
  const config = { ...((job.config as Record<string, unknown>) ?? {}), importPlan: null, lastImport: { ...plan, result: r, finishedAt: new Date().toISOString() } };
  await prisma.aiImportJob.update({
    where: { id: job.id },
    data: { status: done ? (issues ? AiImportJobStatus.COMPLETED_WITH_ISSUES : AiImportJobStatus.COMPLETED) : AiImportJobStatus.NEEDS_REVIEW, finishedAt: new Date(), config: config as Prisma.InputJsonValue },
  });
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
      await prisma.aiImportJob.update({ where: { id: job.id }, data: { status: back, errorMessage: message } });
      await logEvent(job.id, "ERROR", `Stopped: ${message}`);
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
