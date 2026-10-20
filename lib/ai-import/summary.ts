import "server-only";
import { AiImportAnswerStatus, AiImportQuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { qualityReport, type QualityReport, type SequenceAck } from "@/lib/ai-import/quality";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Batch-level reconciliation: every detected question is in exactly one
 * bucket. A job is never "Completed" while `unaccounted` or `pendingDecision`
 * is above zero.
 */
export interface JobSummary {
  detected: number;
  extracted: number;
  eligibleImport: number;
  imported: number;
  eligiblePublish: number;
  published: number;
  needsCorrection: number;
  duplicates: number;
  notImportable: number;
  rejected: number;
  importFailed: number;
  unverifiedAnswers: number;
  imageIssues: number;
  /** Importable but not imported yet (waiting for the admin's approval or import choice). */
  pendingDecision: number;
  /** Approved and importable, not yet in the Question Bank. */
  approvedReady: number;
  /** Still in a working state (EXTRACTED) — must be 0 for a finished job. */
  unaccounted: number;
  pages: { total: number; done: number; failed: number; skipped: number; pending: number };
  answerStatus: Record<string, number>;
  costInr: number;
}

export async function jobSummary(jobId: string): Promise<JobSummary> {
  const [job, qs, pages] = await Promise.all([
    prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { spentInr: true } }),
    prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true } }),
    prisma.aiImportPage.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } }),
  ]);
  const settings = await getImporterSettings();
  const count = (s: AiImportQuestionStatus) => qs.filter((q) => q.status === s).length;
  const answerStatus: Record<string, number> = {};
  for (const q of qs) answerStatus[q.answerStatus] = (answerStatus[q.answerStatus] ?? 0) + 1;
  const pageCount = (s: string) => pages.find((p) => p.status === s)?._count._all ?? 0;
  // Importable once approved (approval itself is counted separately).
  const eligibleImport = qs.filter((q) => !q.questionId && !importBlocker(q, settings, { ignoreApproval: true })).length;
  return {
    detected: qs.length,
    extracted: qs.length,
    eligibleImport,
    imported: qs.filter((q) => q.questionId && (q.status === AiImportQuestionStatus.IMPORTED || q.status === AiImportQuestionStatus.PUBLISHED)).length,
    eligiblePublish: qs.filter((q) => q.status === AiImportQuestionStatus.IMPORTED && !publishBlocker(q, settings)).length,
    published: count(AiImportQuestionStatus.PUBLISHED),
    needsCorrection: count(AiImportQuestionStatus.NEEDS_CORRECTION),
    duplicates: count(AiImportQuestionStatus.DUPLICATE),
    notImportable: count(AiImportQuestionStatus.NOT_IMPORTABLE),
    rejected: count(AiImportQuestionStatus.REJECTED),
    importFailed: count(AiImportQuestionStatus.IMPORT_FAILED),
    unverifiedAnswers: qs.filter((q) => q.answerStatus === AiImportAnswerStatus.UNVERIFIED).length,
    imageIssues: qs.filter((q) => q.issueCodes.some((c) => c === "IMAGE_MISSING" || c === "IMAGE_MAPPING_UNCERTAIN")).length,
    pendingDecision: qs.filter((q) => q.status === AiImportQuestionStatus.READY && !q.questionId).length,
    approvedReady: qs.filter((q) => !q.questionId && !!q.approvedById && !importBlocker(q, settings)).length,
    unaccounted: count(AiImportQuestionStatus.EXTRACTED),
    pages: { total: pages.reduce((a, p) => a + p._count._all, 0), done: pageCount("DONE"), failed: pageCount("FAILED"), skipped: pageCount("SKIPPED"), pending: pageCount("PENDING") },
    answerStatus,
    costInr: job?.spentInr ?? 0,
  };
}

/** Recomputes the summary and records it in the job log (used after processing and imports). */
export async function reconcileJob(jobId: string): Promise<JobSummary> {
  const s = await jobSummary(jobId);
  await prisma.aiImportEvent.create({
    data: { jobId, type: "RECONCILED", message: `Reconciled ${s.detected} question(s): ${s.published} published, ${s.imported - s.published} imported as draft, ${s.pendingDecision} ready, ${s.needsCorrection} need correction, ${s.duplicates} duplicates, ${s.notImportable} not importable, ${s.rejected} rejected, ${s.importFailed} failed, ${s.unaccounted} unaccounted.`, data: s as unknown as object },
  });
  return s;
}

const PROCESSED_STATES = ["NEEDS_REVIEW", "IMPORTING", "COMPLETED", "COMPLETED_WITH_ISSUES"];

/** The sequence / quality report of a job, from stored facts only (see lib/ai-import/quality.ts). */
export async function jobQuality(jobId: string): Promise<QualityReport | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true, expectedQuestions: true, config: true } });
  if (!job) return null;
  const [qs, pages, pending, unmatched, failedKeys] = await Promise.all([
    prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true } }),
    prisma.aiImportPage.findMany({ where: { jobId }, select: { status: true, kind: true, attempts: true, errorMessage: true, rawOutput: true } }),
    prisma.aiImportQuestionVersion.findMany({ where: { jobId, kind: "RESCAN", status: "PENDING" }, select: { questionId: true } }),
    prisma.aiImportKeyEntry.count({ where: { jobId, status: "UNMATCHED" } }),
    prisma.aiImportFile.count({ where: { jobId, role: "ANSWER_KEY", status: "ANALYZED", errorMessage: { not: null } } }),
  ]);
  const settings = await getImporterSettings();
  const pendingIds = new Set(pending.map((p) => p.questionId));
  const extras = pages.flatMap((p) => ((p.rawOutput as { verified?: { extra?: string[] } } | null)?.verified?.extra ?? []));
  return qualityReport({
    expected: job.expectedQuestions,
    questions: qs.map((q) => {
      const raw = q.data as unknown as ExtractedQuestion;
      const e = (q.editedData ?? q.data) as unknown as ExtractedQuestion;
      return {
        fileId: q.fileId,
        section: e.section ?? "",
        number: e.number ?? null,
        printedNumber: e.printedNumber ?? null,
        status: q.status,
        approved: !!q.approvedById,
        stored: !!q.questionId && (q.status === AiImportQuestionStatus.IMPORTED || q.status === AiImportQuestionStatus.PUBLISHED),
        verified: raw.verification ? raw.verification.agree : null,
        issueCodes: q.issueCodes,
        answerStatus: q.answerStatus,
        importBlocker: q.questionId ? null : importBlocker(q, settings, { ignoreApproval: true }),
        rescanPending: pendingIds.has(q.id),
      };
    }),
    pages: pages.map((p) => ({ status: p.status, kind: p.kind, attempts: p.attempts, errorMessage: p.errorMessage })),
    unmatchedKeyEntries: unmatched,
    failedKeyFiles: failedKeys,
    verifierExtras: [...new Set(extras)],
    ack: ((job.config as { sequenceAck?: SequenceAck } | null)?.sequenceAck ?? null),
    processed: PROCESSED_STATES.includes(job.status),
  });
}

const SETTLED = ["NEEDS_REVIEW", "COMPLETED", "COMPLETED_WITH_ISSUES"] as const;

/**
 * Re-derives the status of a finished job from its quality report after a review decision (approval,
 * rejection, a confirmed count, an explanation): "Completed" only when nothing is unresolved,
 * "Completed with warnings" when only warnings remain, otherwise back to review. Only a job in a
 * finished state is touched (the update is conditional on that state).
 */
export async function settleJobStatus(jobId: string): Promise<string | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true } });
  // A finished job's status is never changed by the worker (it only leaves IMPORTING / PROCESSING itself),
  // so a lease still being released at that moment does not matter here.
  if (!job || !(SETTLED as readonly string[]).includes(job.status)) return job?.status ?? null;
  const q = await jobQuality(jobId);
  if (!q) return null;
  // Completion needs at least one stored question, or every question explicitly decided (rejected / not importable).
  const target = q.state === "COMPLETED" ? "COMPLETED" : q.state === "COMPLETED_WITH_WARNINGS" ? "COMPLETED_WITH_ISSUES" : "NEEDS_REVIEW";
  if (target === job.status) return target;
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: job.status as never }, data: { status: target as never, ...(target !== "NEEDS_REVIEW" ? { finishedAt: new Date() } : {}) } });
  if (r.count) await prisma.aiImportEvent.create({ data: { jobId, type: "STATUS_SETTLED", message: `Status: ${target.toLowerCase().replace(/_/g, " ")} (quality: ${q.state.toLowerCase().replace(/_/g, " ")})`, data: { state: q.state, blockers: q.blockers } } });
  return target;
}
