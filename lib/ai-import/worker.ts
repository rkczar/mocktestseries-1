import "server-only";
import crypto from "node:crypto";
import { AiImportJobStatus, AiImportQuestionStatus, AiImportPageStatus, type AiImportJob, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getImporterSettings, jobRunSettings } from "@/lib/ai-import/settings";
import { JOB_STAGES, type ImporterSettings, type JobStage } from "@/lib/ai-import/config";
import { runAnalysis } from "@/lib/ai-import/analyze";
import { runAiPages, runLocalPasses, runVerifyPages, type StepContext } from "@/lib/ai-import/process";
import { runKeyFiles } from "@/lib/ai-import/keys";
import { runPostProcessing } from "@/lib/ai-import/post";
import { runImport, type ImportPlan } from "@/lib/ai-import/adapter";
import { logEvent } from "@/lib/ai-import/jobs";
import { ImporterAiUnavailable, ImporterBudgetError, resetOutputFailures, resetRateLimitStreak } from "@/lib/ai-import/ai";
import { summarizeFailures } from "@/lib/ai-import/failure";
import { jobQuality, reconcileJob, settleJobStatus } from "@/lib/ai-import/summary";
import { runVerify2, verify2Outcome, type Verify2State } from "@/lib/ai-import/paper-verify";
import { formatInr } from "@/lib/ai-engine/config";
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
    verifyMode: (job.config as { verifyMode?: string } | null)?.verifyMode === "all" ? "all" : "risk",
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

/**
 * A confirmed Verify 2 (full-paper independent read, lib/ai-import/paper-verify.ts). It never re-extracts and
 * never changes the job's model plan; a cost / provider stop returns the job to review with what was verified so
 * far (Verify 2 shows the remaining cost again before anything more is sent).
 */
async function verify2Job(job: AiImportJob, state: Verify2State): Promise<void> {
  const current = await getImporterSettings();
  const settings: ImporterSettings = { ...jobRunSettings(job.config, current), aiEnabled: current.aiEnabled };
  const exam = await prisma.exam.findUnique({ where: { id: job.examId }, select: { name: true } });
  if (job.status === AiImportJobStatus.QUEUED) {
    if (!(await transition(job.id, [AiImportJobStatus.QUEUED], { status: AiImportJobStatus.PROCESSING, startedAt: job.startedAt ?? new Date() }))) return;
    await logEvent(job.id, "VERIFY2_STARTED", `Verify 2 started with ${state.model} (maximum ${formatInr(state.maxInr)}).`);
  }
  const fresh = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id } });
  const ctx = makeContext({ ...fresh, status: AiImportJobStatus.PROCESSING }, settings, { exam: exam?.name ?? "Exam", subject: null });
  resetRateLimitStreak(job.id);
  resetOutputFailures(job.id);
  await stage(job.id, "VERIFY2");
  const patchState = async (patch: Partial<Verify2State>) => {
    const j = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id }, select: { config: true } });
    const cfg = (j.config as Record<string, unknown>) ?? {};
    return { ...cfg, verify2: { ...(cfg.verify2 as Verify2State), ...patch } } as unknown as Prisma.InputJsonValue;
  };
  const deterministic = { ...ctx, settings: { ...settings, aiEnabled: false } };
  try {
    const counts = await runVerify2(ctx);
    if (!(await ctx.stillRunning())) return;
    await runPostProcessing(deterministic);
    const after = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id }, select: { spentInr: true } });
    const actual = Math.max(0, after.spentInr - state.spentBeforeInr);
    const outcome = verify2Outcome(counts);
    if (!(await transition(job.id, [AiImportJobStatus.PROCESSING], { status: AiImportJobStatus.NEEDS_REVIEW, finishedAt: new Date(), errorMessage: null, config: await patchState({ status: "DONE", outcome, finishedAt: new Date().toISOString(), counts, stopReason: null, actualInr: Math.round(actual * 100) / 100 }) }))) return;
    await reconcileJob(job.id);
    await settleJobStatus(job.id);
    const results = counts.VERIFIED + counts.DISAGREE + counts.NOT_FOUND;
    const noResult = (counts.FAILED ?? 0) + (counts.UNAVAILABLE ?? 0);
    const head = outcome === "NO_RESULT" ? `Verify 2 produced NO independent result (${state.model}): all ${noResult} question(s) attempted failed or were unavailable, so none counts as verified` : outcome === "PARTIAL" ? `Verify 2 finished with gaps (${state.model}): ${results} of ${counts.attempted} question(s) have an independent result` : `Verify 2 finished (${state.model}): ${results} of ${counts.attempted} question(s) have an independent result`;
    await logEvent(job.id, outcome === "NO_RESULT" ? "VERIFY2_NO_RESULT" : "VERIFY2_DONE", `${head} — ${counts.VERIFIED} agree, ${counts.DISAGREE} disagree (manual correction), ${counts.NOT_FOUND} not found by the second read, ${counts.FAILED ?? 0} failed, ${counts.UNAVAILABLE ?? 0} unavailable${counts.failedUnits ? ` (${counts.failedUnits} of ${counts.units} source part(s) without an answer — use Verify 2 again to retry only those parts)` : ""}${counts.extra ? `, ${counts.extra} question(s) found only by the second read` : ""}. Actual cost ${formatInr(actual)} (estimated ${formatInr(state.estimateInr)}, maximum ${formatInr(state.maxInr)}).`, { ...counts, outcome, model: state.model, actualInr: actual, estimateInr: state.estimateInr, maxInr: state.maxInr });
  } catch (e) {
    const stop = e instanceof ImporterBudgetError || e instanceof ImporterAiUnavailable;
    const message = e instanceof Error ? e.message.slice(0, 500) : "unexpected error";
    if (!stop) console.error(`[ai-import] verify 2 of job ${job.id} failed: ${message}`);
    await runPostProcessing(deterministic).catch(() => undefined);
    if (await transition(job.id, [AiImportJobStatus.PROCESSING], { status: AiImportJobStatus.NEEDS_REVIEW, finishedAt: new Date(), config: await patchState({ status: "STOPPED", stopReason: message, finishedAt: new Date().toISOString() }) })) {
      await logEvent(job.id, "VERIFY2_STOPPED", `Verify 2 stopped: ${message} Questions verified so far keep their result; use Verify 2 again to see the cost of the rest before anything more is sent.`, { model: state.model });
      await settleJobStatus(job.id);
    }
  }
}

async function processJob(job: AiImportJob): Promise<void> {
  const verify2 = (job.config as { verify2?: Verify2State } | null)?.verify2;
  if (verify2 && (verify2.status === "QUEUED" || verify2.status === "RUNNING")) return verify2Job(job, verify2);
  // Settings frozen at confirmation; the AI switch, models and budget follow the CURRENT settings
  // (an admin who turns AI off or lowers limits mid-job is obeyed).
  // Privacy: the stricter of the confirmed and the current settings. Budgets: the current (lowered limits apply).
  // The importer's model list: the current one, so a model withdrawn from it mid-job is never used again.
  const base: ImporterSettings = jobRunSettings(job.config, await getImporterSettings());
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
  // So is the run of unusable answers that keeps a model switch for the rest of the job.
  resetOutputFailures(job.id);
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
    if (ctx.verifyMode === "all") {
      await stage(job.id, "VERIFY");
      const v = await runVerifyPages(ctx);
      if (v.verified || v.failed) await logEvent(job.id, "VERIFIED", `Independent verification of locally read pages: ${v.verified} page(s) verified${v.failed ? `, ${v.failed} failed (their questions stay unverified)` : ""}.`, v);
      if (!(await ctx.stillRunning())) return;
    }
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
    // Nothing enters the Question Bank before an administrator approves it. An older job confirmed with
    // "import automatically" is not imported either: its request is recorded as replaced by approval.
    const auto = (job.config as { autoImport?: { mode: "DRAFT" | "PUBLISH_ALL"; requestedById: string; done?: boolean } | null } | null)?.autoImport;
    if (auto && !auto.done) {
      const fresh = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id }, select: { config: true } });
      await transition(job.id, [AiImportJobStatus.NEEDS_REVIEW], { config: { ...((fresh.config as Record<string, unknown>) ?? {}), autoImport: { ...auto, done: true, replacedByApproval: true } } as Prisma.InputJsonValue });
      await logEvent(job.id, "AWAITING_APPROVAL", "Automatic import is replaced by approval: review and approve the questions, then add the approved ones to the Question Bank.");
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
  await reconcileJob(job.id);
  // The final quality gate: "Completed" only when every expected question is accounted for and nothing
  // waits for a decision; warnings (acknowledged differences, unsupported or duplicate questions,
  // unverified answers) complete "with warnings"; anything unresolved goes back to review.
  const quality = await jobQuality(job.id);
  const status = quality?.state === "COMPLETED" && r.notPublished === 0 ? AiImportJobStatus.COMPLETED : quality?.state === "COMPLETED" || quality?.state === "COMPLETED_WITH_WARNINGS" ? AiImportJobStatus.COMPLETED_WITH_ISSUES : AiImportJobStatus.NEEDS_REVIEW;
  const latest = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: job.id }, select: { config: true } });
  const config = { ...((latest.config as Record<string, unknown>) ?? {}), importPlan: null, lastImport: { ...plan, result: r, finishedAt: new Date().toISOString() } };
  await transition(job.id, [AiImportJobStatus.IMPORTING], { status, finishedAt: new Date(), config: config as Prisma.InputJsonValue });
  if (quality) await logEvent(job.id, "QUALITY_GATE", `${r.imported} question(s) stored as Draft. Quality: ${quality.state.toLowerCase().replace(/_/g, " ")}${quality.blockers.length ? ` — ${quality.blockers.join(" ")}` : ""}`, { state: quality.state, blockers: quality.blockers, warnings: quality.warnings });
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
