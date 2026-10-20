import "server-only";
import { AiImportQuestionStatus, type AiImportJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { formatIst } from "@/lib/ist-time";
import { STALL_AFTER_MS, WORKER_STATUSES, plainJobStatus, type PlainTone } from "@/lib/ai-import/config";

/**
 * Plain, truthful view of import jobs for the one-page importer and the
 * Processing Jobs page: one status label, progress, counts, spend, the one
 * next action, and which controls are allowed now (re-checked on the server
 * by every action).
 */

export interface JobCounts {
  extracted: number;
  ready: number;
  imported: number;
  published: number;
  needsReview: number;
  notImportable: number;
  duplicates: number;
  rejected: number;
  importFailed: number;
  unverifiedAnswers: number;
  /** Questions held back because no subject of the exam could be determined. */
  noSubject: number;
  /** Approved by an administrator and not in the Question Bank yet. */
  approved: number;
}

export interface JobCard {
  id: string;
  title: string;
  status: string;
  label: string;
  tone: PlainTone;
  stalled: boolean;
  createdAt: string;
  updatedAt: string;
  files: { name: string; role: string }[];
  pages: { total: number; done: number; skipped: number; failed: number; pending: number };
  /** Answer-key files whose required reading failed (they are read again by Retry failed pages). */
  failedKeys: number;
  counts: JobCounts;
  spentInr: number;
  budgetInr: number;
  maxCostInr: number | null;
  message: string | null;
  nextAction: string;
  actions: { cancel: boolean; retry: boolean; delete: boolean; recover: boolean; reconfigure: boolean };
  runIds: string[];
}

const CANCELLABLE = ["DRAFT", "ANALYZING", "AWAITING_CONFIRMATION", "QUEUED", "PROCESSING", "PAUSED", "PAUSED_BUDGET"];

export function isStalled(j: Pick<AiImportJob, "status" | "leaseUntil" | "updatedAt">, now = Date.now()): boolean {
  if (!(WORKER_STATUSES as readonly string[]).includes(j.status)) return false;
  if (j.leaseUntil && j.leaseUntil.getTime() > now) return false;
  const since = Math.max(j.updatedAt.getTime(), j.leaseUntil?.getTime() ?? 0);
  return now - since > STALL_AFTER_MS;
}

/** A finished job whose page or answer-key reading failed: Retry reads only those again (lib/ai-import/jobs.ts retryJob). */
export function canRetryFailed(j: Pick<AiImportJob, "status" | "confirmedAt">, pages: { failed: number }, failedKeys: number): boolean {
  return j.status === "NEEDS_REVIEW" && !!j.confirmedAt && (pages.failed > 0 || failedKeys > 0);
}

function nextAction(j: AiImportJob, c: JobCounts, stalled: boolean, pages: JobCard["pages"], failedKeys: number): string {
  if (stalled) return "The background worker is not running this import. Click Start again — it continues from the last finished step.";
  switch (j.status) {
    case "DRAFT":
      return "Analysis starts automatically after the upload.";
    case "ANALYZING":
    case "QUEUED":
    case "PROCESSING":
    case "IMPORTING":
      return "Working — this page updates by itself. You can leave it and come back.";
    case "AWAITING_CONFIRMATION":
      return "Check the exam, the Previous Year Paper, the expected number of questions and the estimated cost, then click Confirm Cost & Start Processing.";
    case "PAUSED":
    case "PAUSED_BUDGET":
      return j.pauseReason ? `${j.pauseReason} Then click Retry.` : "Click Retry to continue from the last finished page.";
    case "FAILED":
      return "Click Retry to continue from the last finished page, or delete the import.";
    case "CANCELLED":
      return j.leaseUntil && j.leaseUntil.getTime() > Date.now() ? "Cancelled — the worker is stopping after its current step. Retry and Delete become available in a few seconds." : "Cancelled. Click Retry to continue it, or delete it to remove its files.";
    case "NEEDS_REVIEW":
      if (c.extracted === 0) return j.errorMessage ?? "No questions could be read from this file.";
      if (canRetryFailed(j, pages, failedKeys)) return `${j.errorMessage ?? `${pages.failed} page(s) failed.`} The ${c.extracted} question(s) already read are kept.`;
      if (c.approved > 0) return `${c.approved} approved question(s) are ready. Click Add approved questions to the Question Bank to store them as Draft.`;
      if (c.ready > 0) return `${c.ready} question(s) passed every check. Review and approve them — nothing enters the Question Bank before approval.`;
      if (c.noSubject > 0) return `${c.noSubject} question(s) have no subject (the file has no subject headings and AI classification is off). Open Review questions and set the subject — or delete this import and upload again as a Single-subject paper (Advanced options).`;
      return `${c.needsReview + c.notImportable + c.duplicates} question(s) need attention before they can be imported — open Review questions.`;
    case "COMPLETED":
      return `Done: ${c.imported} question(s) are in the Question Bank${c.published ? ` (${c.published} published)` : " as Draft"}. Review and publish them in the Question Bank.`;
    case "COMPLETED_WITH_ISSUES":
      if (c.noSubject > 0) return `${c.imported} question(s) imported${c.published ? ` (${c.published} published)` : " as Draft"}; ${c.noSubject} have no subject — set it in Review questions, then import them.`;
      return `${c.imported} question(s) imported${c.published ? ` (${c.published} published)` : " as Draft"}; ${c.needsReview + c.notImportable + c.importFailed} need review${pages.skipped ? `; ${pages.skipped} page(s) were skipped` : ""}.`;
    default:
      return "";
  }
}

async function countsFor(jobIds: string[]): Promise<Map<string, JobCounts>> {
  const [byStatus, imported, unverified, noSubject, approved] = await Promise.all([
    prisma.aiImportQuestion.groupBy({ by: ["jobId", "status"], where: { jobId: { in: jobIds } }, _count: { _all: true } }),
    prisma.aiImportQuestion.groupBy({ by: ["jobId"], where: { jobId: { in: jobIds }, questionId: { not: null } }, _count: { _all: true } }),
    prisma.aiImportQuestion.groupBy({ by: ["jobId"], where: { jobId: { in: jobIds }, answerStatus: "UNVERIFIED" }, _count: { _all: true } }),
    prisma.aiImportQuestion.groupBy({ by: ["jobId"], where: { jobId: { in: jobIds }, questionId: null, issueCodes: { has: "SUBJECT_UNKNOWN" } }, _count: { _all: true } }),
    prisma.aiImportQuestion.groupBy({ by: ["jobId"], where: { jobId: { in: jobIds }, questionId: null, approvedById: { not: null }, status: { notIn: [AiImportQuestionStatus.REJECTED] } }, _count: { _all: true } }),
  ]);
  const out = new Map<string, JobCounts>();
  for (const id of jobIds) {
    const n = (s: AiImportQuestionStatus) => byStatus.find((r) => r.jobId === id && r.status === s)?._count._all ?? 0;
    out.set(id, {
      extracted: byStatus.filter((r) => r.jobId === id).reduce((a, r) => a + r._count._all, 0),
      ready: n(AiImportQuestionStatus.READY),
      imported: imported.find((r) => r.jobId === id)?._count._all ?? 0,
      published: n(AiImportQuestionStatus.PUBLISHED),
      needsReview: n(AiImportQuestionStatus.NEEDS_CORRECTION) + n(AiImportQuestionStatus.EXTRACTED),
      notImportable: n(AiImportQuestionStatus.NOT_IMPORTABLE),
      duplicates: n(AiImportQuestionStatus.DUPLICATE),
      rejected: n(AiImportQuestionStatus.REJECTED),
      importFailed: n(AiImportQuestionStatus.IMPORT_FAILED),
      unverifiedAnswers: unverified.find((r) => r.jobId === id)?._count._all ?? 0,
      noSubject: noSubject.find((r) => r.jobId === id)?._count._all ?? 0,
      approved: approved.find((r) => r.jobId === id)?._count._all ?? 0,
    });
  }
  return out;
}

export async function jobCards(where: { ids?: string[]; take?: number }, canManage: boolean): Promise<JobCard[]> {
  const jobs = await prisma.aiImportJob.findMany({
    where: where.ids ? { id: { in: where.ids } } : undefined,
    orderBy: { updatedAt: "desc" },
    take: where.take ?? 100,
    include: { files: { select: { originalName: true, role: true, status: true, errorMessage: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!jobs.length) return [];
  const ids = jobs.map((j) => j.id);
  const [counts, pages, stages, runs] = await Promise.all([
    countsFor(ids),
    prisma.aiImportPage.groupBy({ by: ["jobId", "status"], where: { jobId: { in: ids } }, _count: { _all: true } }),
    prisma.aiImportEvent.findMany({ where: { jobId: { in: ids }, type: "STAGE" }, orderBy: { createdAt: "desc" }, distinct: ["jobId"], select: { jobId: true, data: true } }),
    prisma.aiImportQuestion.findMany({ where: { jobId: { in: ids }, bulkImportRunId: { not: null } }, distinct: ["jobId", "bulkImportRunId"], select: { jobId: true, bulkImportRunId: true } }),
  ]);
  const now = Date.now();
  return jobs.map((j) => {
    const c = counts.get(j.id)!;
    const pc = (s: string) => pages.find((p) => p.jobId === j.id && p.status === s)?._count._all ?? 0;
    const pg = { total: pages.filter((p) => p.jobId === j.id).reduce((a, p) => a + p._count._all, 0), done: pc("DONE"), skipped: pc("SKIPPED"), failed: pc("FAILED"), pending: pc("PENDING") };
    const failedKeys = j.files.filter((f) => f.role === "ANSWER_KEY" && f.status === "ANALYZED" && !!f.errorMessage).length;
    const stalled = isStalled(j, now);
    const stage = ((stages.find((s) => s.jobId === j.id)?.data ?? null) as { stage?: string } | null)?.stage ?? null;
    const plain = plainJobStatus({ status: j.status, stage, extracted: c.extracted, eligibleImport: c.ready, imported: c.imported, needsReview: c.needsReview, skippedPages: pg.skipped, stalled });
    const leased = !!j.leaseUntil && j.leaseUntil.getTime() > now;
    const estimate = j.estimate as { maxInr?: number | null } | null;
    return {
      id: j.id,
      title: j.title,
      status: j.status,
      label: plain.label,
      tone: plain.tone,
      stalled,
      createdAt: formatIst(j.createdAt),
      updatedAt: formatIst(j.updatedAt),
      files: j.files.filter((f) => f.status !== "REJECTED").map((f) => ({ name: f.originalName, role: f.role })),
      pages: pg,
      failedKeys,
      counts: c,
      spentInr: j.spentInr,
      budgetInr: j.budgetInr,
      maxCostInr: estimate?.maxInr ?? null,
      message: j.status === "PAUSED" || j.status === "PAUSED_BUDGET" ? j.pauseReason : j.errorMessage,
      nextAction: nextAction(j, c, stalled, pg, failedKeys),
      actions: {
        cancel: CANCELLABLE.includes(j.status),
        retry: !leased && (j.status === "FAILED" || j.status === "PAUSED" || j.status === "CANCELLED" || j.status === "PAUSED_BUDGET" || canRetryFailed(j, pg, failedKeys)),
        delete: canManage && j.status !== "IMPORTING" && !leased,
        recover: stalled,
        // Paused after confirmation, no worker holding it (lib/ai-import/reconfigure.ts re-checks everything).
        reconfigure: !leased && !!j.confirmedAt && (j.status === "PAUSED" || j.status === "PAUSED_BUDGET"),
      },
      runIds: [...new Set(runs.filter((r) => r.jobId === j.id).map((r) => r.bulkImportRunId!))],
    };
  });
}

/** Exam ↔ Previous Year Paper mapping of a job, shown on every importer screen (from the stored records). */
export interface JobMapping {
  jobId: string;
  examId: string;
  examName: string;
  paper: { id: string; title: string; year: number; paperCode: string | null } | null;
  /** The job points at a paper record that no longer exists. */
  paperMissing: boolean;
  year: number | null;
  paperCode: string | null;
  subjectName: string | null;
  paperType: string;
  expectedQuestions: number | null;
  status: string;
}

export async function jobMapping(jobId: string): Promise<JobMapping | null> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { id: true, examId: true, previousYearPaperId: true, year: true, paperCode: true, subjectId: true, paperType: true, expectedQuestions: true, status: true } });
  if (!job) return null;
  const [exam, paper, subject] = await Promise.all([
    prisma.exam.findUnique({ where: { id: job.examId }, select: { name: true } }),
    job.previousYearPaperId ? prisma.previousYearPaper.findUnique({ where: { id: job.previousYearPaperId }, select: { id: true, title: true, year: true, paperCode: true } }) : null,
    job.subjectId ? prisma.subject.findUnique({ where: { id: job.subjectId }, select: { name: true } }) : null,
  ]);
  return {
    jobId: job.id,
    examId: job.examId,
    examName: exam?.name ?? "(deleted exam)",
    paper,
    paperMissing: !!job.previousYearPaperId && !paper,
    year: paper?.year ?? job.year,
    paperCode: paper?.paperCode ?? job.paperCode,
    subjectName: subject?.name ?? null,
    paperType: job.paperType,
    expectedQuestions: job.expectedQuestions,
    status: job.status,
  };
}
