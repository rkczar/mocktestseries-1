import "server-only";
import { AiImportAnswerStatus, AiImportQuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { importBlocker, publishBlocker } from "@/lib/ai-import/adapter";

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
  /** Importable but not imported yet (waiting for the admin's import choice). */
  pendingDecision: number;
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
  const eligibleImport = qs.filter((q) => !q.questionId && !importBlocker(q, settings)).length;
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
