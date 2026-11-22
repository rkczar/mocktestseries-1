import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatInr } from "@/lib/ai-engine/config";
import { getImporterSettings, jobRunSettings } from "@/lib/ai-import/settings";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { requestVerify2, runVerify1, verify2Preview } from "@/lib/ai-import/paper-verify";
import { requestVerifyAnswers, verifyAnswersPreview } from "@/lib/ai-import/verify-answers-run";

/**
 * Two-step importer (2026-11-22): after Import & Process the checks run by themselves in the background, in order —
 * Verify 1 (free, structural), Verify 2 (independent read with a different model), Verify Answers (answer-key mapping
 * + an AI opinion that never replaces an official answer). Each keeps its own model, events and results exactly as when
 * clicked separately; only the clicking is gone. The job's config.autoVerify records where the sequence is.
 *
 * Spending: every paid step is priced first and recorded (event + audit log). When Import Settings set
 * workflow.autoVerifyMaxInr and a step's maximum is above it, that step waits for the administrator (HELD).
 */
export type AutoStep = "verify1" | "verify2" | "answers" | "done";
export interface AutoVerifyState {
  enabled: boolean;
  actorId: string;
  step: AutoStep;
  /** Why the sequence is waiting for a click (cost above the safeguard, paid AI off, …); null while it runs. */
  held: string | null;
  updatedAt: string;
}

const FINISHED = ["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"];

/** Whether an automatic check must wait: above the admin's confirmed maximum, else above the job-level limit (spent + max). */
export function autoLimitExceeded(spentInr: number, maxInr: number, jobLimitInr: number | null, confirmedMaxInr: number | null): boolean {
  if (confirmedMaxInr !== null) return maxInr > confirmedMaxInr + 0.005;
  return jobLimitInr !== null && spentInr + maxInr > jobLimitInr + 0.005;
}

export function autoVerifyOf(config: unknown): AutoVerifyState | null {
  const a = (config as { autoVerify?: AutoVerifyState } | null)?.autoVerify;
  return a && typeof a === "object" && a.enabled ? a : null;
}

async function save(jobId: string, patch: Partial<AutoVerifyState>): Promise<void> {
  // Merged under a row lock: the worker writes verify2 / verifyAnswers state into the same config.
  await prisma.$transaction(async (tx) => {
    const row = await tx.$queryRaw<{ config: unknown }[]>`SELECT "config" FROM "AiImportJob" WHERE "id" = ${jobId} FOR UPDATE`;
    const cfg = ((row[0]?.config ?? {}) as Record<string, unknown>) ?? {};
    const cur = (cfg.autoVerify ?? {}) as AutoVerifyState;
    await tx.aiImportJob.update({ where: { id: jobId }, data: { config: { ...cfg, autoVerify: { ...cur, ...patch, updatedAt: new Date().toISOString() } } as unknown as Prisma.InputJsonValue } });
  });
}

export async function holdAutoVerify(jobId: string, step: AutoStep, reason: string): Promise<void> {
  if (!autoVerifyOf((await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { config: true } }))?.config)) return;
  await save(jobId, { step, held: reason });
  await logEvent(jobId, "AUTO_VERIFY_HELD", `Automatic verification is waiting at ${step === "verify2" ? "Verify 2" : step === "answers" ? "Verify Answers" : "Verify 1"}: ${reason}`);
}

/**
 * Continues the job's automatic verification from where it stands. Safe to call at any time (it does nothing unless
 * the job is finished and the sequence is enabled and not held); `confirmedMaxInr` is an administrator's click that
 * lifts a hold for the next paid step. Never throws into the worker: a failure becomes a HELD event.
 */
export async function continueAutoVerify(jobId: string, opts: { confirmedMaxInr?: number | null } = {}): Promise<AutoVerifyState | null> {
  try {
    const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true, config: true, spentInr: true } });
    const st = autoVerifyOf(job?.config);
    if (!job || !st || !FINISHED.includes(job.status)) return st;
    if (st.held && opts.confirmedMaxInr === undefined) return st;
    const settings = jobRunSettings(job.config, await getImporterSettings());
    // Job-level safeguard: a check runs by itself only while the import's TOTAL cost (spent + this check's maximum)
    // stays within workflow.autoVerifyMaxInr; an administrator's confirmation of the shown maximum lifts it once.
    const confirmed = opts.confirmedMaxInr ?? null;
    const jobLimit = settings.workflow.autoVerifyMaxInr;
    const overLimit = (maxInr: number) => autoLimitExceeded(job.spentInr, maxInr, jobLimit, confirmed);
    const limitText = (maxInr: number) => (confirmed !== null ? `its maximum cost ${formatInr(maxInr)} is above the ${formatInr(confirmed)} you confirmed` : `this import has spent ${formatInr(job.spentInr)}; with this check's maximum of ${formatInr(maxInr)} it would pass the automatic job limit of ${formatInr(jobLimit)} (Import Settings)`);
    let step = st.step;
    if (step === "verify1") {
      const r = await runVerify1(jobId, st.actorId);
      await logEvent(jobId, "AUTO_VERIFY1_DONE", `Automatic Verify 1 (free): ${r.questions} checked, ${r.passed} passed, ${r.withProblems} with findings.`);
      step = "verify2";
      await save(jobId, { step, held: null });
    }
    // A run that hit a budget stop never gets paid checks added by itself: the administrator confirms them.
    if (opts.confirmedMaxInr === undefined && (await prisma.aiImportEvent.count({ where: { jobId, type: { in: ["PAID_AI_BLOCKED", "PAUSED_BUDGET"] } } }))) {
      await holdAutoVerify(jobId, step, "this import reached a budget limit; confirm the cost of the next check to continue.");
      return autoVerifyOf((await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { config: true } }))?.config);
    }
    if (!(await getImporterSettings()).aiEnabled) {
      await holdAutoVerify(jobId, step, "paid AI is switched off in Import Settings.");
      return autoVerifyOf((await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { config: true } }))?.config);
    }
    if (step === "verify2") {
      const p = await verify2Preview(jobId, settings.models.verify ?? null);
      if (!p.units) {
        step = "answers";
      } else if (!p.model || p.maxInr === null) {
        await holdAutoVerify(jobId, "verify2", `no model can run it (${p.problems.join(" ") || p.reason}).`);
        return null;
      } else if (overLimit(p.maxInr)) {
        await holdAutoVerify(jobId, "verify2", `${limitText(p.maxInr)}. Confirm the cost to continue.`);
        return null;
      } else {
        // The step moves on BEFORE the request: the worker calls continueAutoVerify again when Verify 2 finishes.
        await save(jobId, { step: "answers", held: null });
        const r = await requestVerify2({ jobId, actorId: st.actorId, model: p.model, confirmedMaxInr: p.maxInr });
        if (!r.started) await holdAutoVerify(jobId, "verify2", r.reason);
        else await logEvent(jobId, "AUTO_VERIFY2_STARTED", `Verify 2 started automatically with ${p.model} (estimated ${formatInr(p.estimateInr)}, maximum ${formatInr(p.maxInr)}).`);
        return null;
      }
    }
    if (step === "answers") {
      const p = await verifyAnswersPreview(jobId, settings.models.verify ?? null).catch(() => verifyAnswersPreview(jobId, null));
      const spentNow = (await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { spentInr: true } }))?.spentInr ?? job.spentInr;
      job.spentInr = spentNow;
      if (p.toAsk && p.choice && overLimit(p.maxInr)) {
        await holdAutoVerify(jobId, "answers", `${limitText(p.maxInr)}. Confirm the cost to continue.`);
        return null;
      }
      await save(jobId, { step: "done", held: null });
      const r = await requestVerifyAnswers({ jobId, actorId: st.actorId, model: p.choice?.model ?? null, confirmedMaxInr: p.maxInr, keyOnly: !p.choice });
      if (!r.started) await holdAutoVerify(jobId, "answers", r.reason ?? "it could not start.");
      else await logEvent(jobId, "AUTO_VERIFY_ANSWERS_STARTED", `Verify Answers started automatically${p.choice ? ` with ${p.choice.model} (maximum ${formatInr(p.maxInr)})` : " (answer-key check only, no AI)"}.`);
      return null;
    }
    if (step === "done") return st;
    return st;
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "error";
    await logEvent(jobId, "AUTO_VERIFY_HELD", `Automatic verification stopped: ${msg}`).catch(() => undefined);
    await save(jobId, { held: msg }).catch(() => undefined);
    if (e instanceof ImportJobError) return null;
    console.error(`[ai-import] auto-verify ${jobId}: ${msg}`);
    return null;
  }
}

/** Administrator: (re)start the background verification — e.g. "Retry failed checks" after a provider failure. */
export async function restartAutoVerify(jobId: string, actorId: string, from: AutoStep, confirmedMaxInr: number | null): Promise<AutoVerifyState | null> {
  await save(jobId, { enabled: true, actorId, step: from, held: null });
  return continueAutoVerify(jobId, { confirmedMaxInr });
}

/**
 * Version of the deterministic answer / status rules. A finished job whose statuses were computed under an older
 * version shows "Statuses out of date — Refresh (free)" (2026-11-22 audit: 46 + 14 stale KEY_MISMATCH rows). Bump it
 * whenever key matching, the sequence gate or the status rules change. Refreshing is never automatic for old jobs.
 */
export const STATUS_RULES_VERSION = "2026-11-22.1";

export async function markStatusesCurrent(jobId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.$queryRaw<{ config: unknown }[]>`SELECT "config" FROM "AiImportJob" WHERE "id" = ${jobId} FOR UPDATE`;
    const cfg = ((row[0]?.config ?? {}) as Record<string, unknown>) ?? {};
    await tx.aiImportJob.update({ where: { id: jobId }, data: { config: { ...cfg, statusRulesVersion: STATUS_RULES_VERSION } as unknown as Prisma.InputJsonValue } });
  });
}

export const statusesStale = (config: unknown): boolean => (config as { statusRulesVersion?: string } | null)?.statusRulesVersion !== STATUS_RULES_VERSION;
