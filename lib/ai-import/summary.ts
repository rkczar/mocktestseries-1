import "server-only";
import { AiImportAnswerStatus, AiImportQuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { blockerOnceApproved, importBlocker, publishBlocker } from "@/lib/ai-import/adapter";
import { reconcilePaper, type PaperReconciliation } from "@/lib/ai-import/paper-reconciliation";
import { qualityReport, type ExpectedSource, type QualityReport, type SequenceAck } from "@/lib/ai-import/quality";
import { printedQuestionTotal, type KeyHeader } from "@/lib/ai-import/keys";
import { readDocx } from "@/lib/ai-import/docx";
import { vaultPath } from "@/lib/ai-import/vault";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/** Statuses in which approved questions can be added to the Question Bank (lib/ai-import/review.ts requestImport). */
export const DRAFT_IMPORT_STATUSES = ["NEEDS_REVIEW", "COMPLETED_WITH_ISSUES", "COMPLETED"];
/** The label of the one action that adds a job's approved questions to the Question Bank as Draft (every page uses it). */
export const ADD_DRAFT_LABEL = "Add approved to Question Bank (Draft)";

/**
 * Approved questions of each job that "Add approved to Question Bank (Draft)" would add now: approved by an
 * administrator, not in the Question Bank, and passing every mandatory check (importBlocker) — the same rule the
 * job page's count and the worker use. Read-only.
 */
export async function approvedReadyCounts(jobIds: string[]): Promise<Map<string, number>> {
  const out = new Map(jobIds.map((id) => [id, 0]));
  if (!jobIds.length) return out;
  const [settings, qs] = await Promise.all([getImporterSettings(), prisma.aiImportQuestion.findMany({ where: { jobId: { in: jobIds }, questionId: null, approvedById: { not: null } }, include: { figures: true } })]);
  for (const q of qs) if (!importBlocker(q, settings)) out.set(q.jobId, (out.get(q.jobId) ?? 0) + 1);
  return out;
}

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
  /** Not approved yet; approving would make it importable (status Ready, every gate clear). */
  readyAwaitingApproval: number;
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
  // The actual import gate (approval, status, checks, holds, duplicates): what an Import would take now. Needs-correction
  // questions are never counted, whatever their other checks say (2026-11-12).
  const eligibleImport = qs.filter((q) => !q.questionId && !importBlocker(q, settings)).length;
  const readyAwaitingApproval = qs.filter((q) => !q.questionId && !q.approvedById && !blockerOnceApproved(q, settings)).length;
  // "Published" = published in the Question Bank (import rows stay IMPORTED when an admin publishes there).
  const storedIds = qs.filter((q) => q.questionId && (q.status === AiImportQuestionStatus.IMPORTED || q.status === AiImportQuestionStatus.PUBLISHED)).map((q) => q.questionId!);
  const publishedInBank = storedIds.length ? await prisma.question.count({ where: { id: { in: storedIds }, status: "PUBLISHED" } }) : 0;
  return {
    detected: qs.length,
    extracted: qs.length,
    eligibleImport,
    imported: qs.filter((q) => q.questionId && (q.status === AiImportQuestionStatus.IMPORTED || q.status === AiImportQuestionStatus.PUBLISHED)).length,
    eligiblePublish: qs.filter((q) => q.status === AiImportQuestionStatus.IMPORTED && !publishBlocker(q, settings)).length,
    published: publishedInBank,
    needsCorrection: count(AiImportQuestionStatus.NEEDS_CORRECTION),
    duplicates: count(AiImportQuestionStatus.DUPLICATE),
    notImportable: count(AiImportQuestionStatus.NOT_IMPORTABLE),
    rejected: count(AiImportQuestionStatus.REJECTED),
    importFailed: count(AiImportQuestionStatus.IMPORT_FAILED),
    unverifiedAnswers: qs.filter((q) => q.answerStatus === AiImportAnswerStatus.UNVERIFIED).length,
    imageIssues: qs.filter((q) => q.issueCodes.some((c) => c === "IMAGE_MISSING" || c === "IMAGE_MAPPING_UNCERTAIN" || c === "IMAGE_REFERENCE_UNCERTAIN")).length,
    pendingDecision: qs.filter((q) => q.status === AiImportQuestionStatus.READY && !q.questionId).length,
    approvedReady: qs.filter((q) => !q.questionId && !!q.approvedById && !importBlocker(q, settings)).length,
    readyAwaitingApproval,
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

/** Printed totals of Word papers, by vault key (the file never changes once stored). */
const docxTotals = new Map<string, number | null>();

/**
 * Question totals printed on the job's own files — the question paper's header (first pages / the Word document's
 * opening) and each answer key's header — never anything the extraction produced (Sprint A item 6, 2026-11-06).
 */
export async function printedExpectedSources(jobId: string): Promise<ExpectedSource[]> {
  const files = await prisma.aiImportFile.findMany({ where: { jobId, role: { in: ["PAPER", "ANSWER_KEY"] }, status: { not: "REJECTED" } }, select: { id: true, role: true, originalName: true, detected: true, storageKey: true } });
  const out: ExpectedSource[] = [];
  for (const f of files) {
    const detected = f.detected as { kind?: string; keyHeader?: KeyHeader | null } | null;
    if (f.role === "ANSWER_KEY") {
      const n = detected?.keyHeader?.totalQuestions ?? null;
      if (n) out.push({ source: `printed on the answer key “${f.originalName}”`, value: n });
      continue;
    }
    let n: number | null = null;
    if (detected?.kind === "docx" && f.storageKey) {
      if (!docxTotals.has(f.storageKey)) {
        const total = await readDocx(vaultPath(f.storageKey)).then((d) => printedQuestionTotal(d.lines.slice(0, 60).map((l) => l.text).join("\n"))).catch(() => null);
        docxTotals.set(f.storageKey, total);
      }
      n = docxTotals.get(f.storageKey) ?? null;
    } else {
      const pages = await prisma.aiImportPage.findMany({ where: { fileId: f.id, pageNumber: { lte: 3 } }, orderBy: { pageNumber: "asc" }, select: { textLayer: true, ocrText: true, rawOutput: true } });
      for (const p of pages) {
        const ai = (p.rawOutput as { ai?: { paper_header?: { total_questions?: number | string | null } | null } } | null)?.ai?.paper_header?.total_questions;
        n = printedQuestionTotal(p.textLayer ?? "") ?? printedQuestionTotal(p.ocrText ?? "") ?? (ai ? Number.parseInt(String(ai), 10) || null : null);
        if (n) break;
      }
    }
    if (n) out.push({ source: `printed on the question paper “${f.originalName}”`, value: n });
  }
  return out;
}

/** The sequence / quality report of a job, from stored facts only (see lib/ai-import/quality.ts). */
export async function jobQuality(jobId: string): Promise<QualityReport | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true, expectedQuestions: true, config: true } });
  if (!job) return null;
  const [qs, pages, pending, unmatched, failedKeys] = await Promise.all([
    prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true } }),
    prisma.aiImportPage.findMany({ where: { jobId }, select: { status: true, kind: true, attempts: true, errorMessage: true, rawOutput: true, fileId: true, pageNumber: true, outcome: true, outcomeReason: true } }),
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
        page: q.pages[0] ?? null,
      };
    }),
    pages: pages.map((p) => ({ status: p.status, kind: p.kind, attempts: p.attempts, errorMessage: p.errorMessage, fileId: p.fileId, pageNumber: p.pageNumber, outcome: p.outcome, outcomeReason: p.outcomeReason })),
    keyMaxNumber: (await prisma.aiImportKeyEntry.aggregate({ where: { jobId, status: { not: "WITHDRAWN" } }, _max: { sourceNumber: true } }))._max.sourceNumber ?? null,
    unmatchedKeyEntries: unmatched,
    failedKeyFiles: failedKeys,
    verifierExtras: [...new Set(extras)],
    ack: ((job.config as { sequenceAck?: SequenceAck } | null)?.sequenceAck ?? null),
    processed: PROCESSED_STATES.includes(job.status),
    expectedSources: await printedExpectedSources(jobId),
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

/** The 1..expected question-number reconciliation of one job's paper (lib/ai-import/paper-reconciliation.ts). */
export async function jobPaperReconciliation(jobId: string): Promise<PaperReconciliation | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { expectedQuestions: true } });
  const qs = await prisma.aiImportQuestion.findMany({ where: { jobId }, include: { figures: true }, orderBy: { orderIndex: "asc" } });
  if (!qs.length) return null;
  const settings = await getImporterSettings();
  const bankIds = qs.map((q) => q.questionId).filter((x): x is string => !!x);
  const bank = new Map((await prisma.question.findMany({ where: { id: { in: bankIds } }, select: { id: true, status: true } })).map((b) => [b.id, b.status as string]));
  const numbered = qs.filter((q) => q.sourceNumber !== null).map((q) => q.sourceNumber!);
  const expected = job?.expectedQuestions ?? (numbered.length ? Math.max(...numbered) : 0);
  return reconcilePaper(
    expected,
    qs.map((q) => ({
      id: q.id,
      // Numbered sections restart: only the first section's numbers are the paper's question numbers.
      number: (q.data as { section?: string | null }).section ? null : q.sourceNumber,
      status: q.status,
      answerStatus: q.answerStatus,
      approved: !!q.approvedById,
      questionId: q.questionId,
      bankStatus: q.questionId ? (bank.get(q.questionId) ?? null) : null,
      gate: q.questionId ? null : importBlocker(q, settings),
      gateOnceApproved: q.questionId ? null : blockerOnceApproved(q, settings),
      pages: q.pages,
    }))
  );
}
