import "server-only";
import { prisma } from "@/lib/prisma";
import { BulkImportRollbackAction, BulkImportRowStatus, QuestionStatus, type Prisma } from "@prisma/client";

/**
 * Import-run rollback: "Delete Questions Created By This Import".
 *
 * Provenance is deterministic: a BulkImportRow with status SUCCESS is the
 * row that CREATED its questionId (written in the same transaction as the
 * Question — lib/bulk-import-execute.ts). REPLACED / SKIPPED rows point at
 * questions that existed before the run and are NEVER eligible; nothing is
 * ever matched by filename, date, exam or code prefix.
 *
 * Every candidate is classified from the live schema before anything is
 * touched, and re-classified inside its own transaction at execution time:
 *
 *   SAFE_TO_DELETE   no references — hard delete (options + its own AI
 *                    explanation cache go with it).
 *   ARCHIVE_ONLY     referenced by immutable/student history (test attempts,
 *                    answers, saved-by-students, student reports) or has AI
 *                    variants — set status ARCHIVED so it leaves every
 *                    active pool while historical results stay valid.
 *   PROTECTED        part of a live test definition (Mock / Custom Module /
 *                    Grand / Live) or later overwritten by another import —
 *                    untouched; the owner must resolve it deliberately.
 *   ALREADY_MISSING  the question no longer exists.
 *
 * Shared taxonomy (Exam / Subject / Topic / SubTopic) is never deleted here.
 */

export type RollbackClass = "SAFE_TO_DELETE" | "ARCHIVE_ONLY" | "PROTECTED" | "ALREADY_MISSING";

export type ImportAction = "CREATED" | "REPLACED" | "SKIPPED" | "FAILED" | "PENDING";

export interface ImportedQuestionRow {
  rowId: string;
  rowNumber: number;
  questionId: string | null;
  questionCode: string | null;
  action: ImportAction;
  /** Outcome of an earlier rollback of this row, if any. */
  rollbackAction: BulkImportRollbackAction | null;
  rollbackReason: string | null;
  question: {
    text: string;
    status: QuestionStatus;
    subject: string | null;
    topic: string | null;
    subTopic: string | null;
  } | null;
  /** Only for CREATED rows not yet deleted/missing; null otherwise. */
  classification: RollbackClass | null;
  reasons: string[];
  /** CREATED + not yet processed + deletable or archivable. */
  eligible: boolean;
}

export interface RollbackSummary {
  created: number;
  replaced: number;
  skipped: number;
  failed: number;
  safeToDelete: number;
  archiveOnly: number;
  protected: number;
  alreadyMissing: number;
  laterDeleted: number;
  laterArchived: number;
  laterProtected: number;
}

const ACTION_BY_STATUS: Record<BulkImportRowStatus, ImportAction> = {
  SUCCESS: "CREATED",
  REPLACED: "REPLACED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
  PENDING: "PENDING",
};

type Db = Prisma.TransactionClient | typeof prisma;

/** Reference facts for a set of questions — one grouped query per relation, never N+1. */
async function loadReferences(db: Db, questionIds: string[]) {
  const ids = questionIds.length ? questionIds : ["__none__"];
  const [mock, custom, grand, live, attempts, answers, saved, reports, variants] = await Promise.all([
    db.mockTestQuestion.findMany({ where: { questionId: { in: ids } }, select: { questionId: true, mockTest: { select: { title: true } } } }),
    db.customModuleQuestion.findMany({ where: { questionId: { in: ids } }, select: { questionId: true, customModule: { select: { title: true } } } }),
    db.grandTestQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.liveTestQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.testAttemptQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.answer.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.savedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.reportedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.question.groupBy({ by: ["parentQuestionId"], where: { parentQuestionId: { in: ids } }, _count: { _all: true } }),
  ]);
  const count = (rows: { questionId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.questionId, r._count._all]));
  const names = <T extends { questionId: string }>(rows: T[], name: (r: T) => string) => {
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.questionId, [...(m.get(r.questionId) ?? []), name(r)]);
    return m;
  };
  return {
    mock: names(mock, (r) => r.mockTest.title),
    custom: names(custom, (r) => r.customModule.title),
    grand: count(grand),
    live: count(live),
    attempts: count(attempts),
    answers: count(answers),
    saved: count(saved),
    reports: count(reports),
    variants: new Map(variants.map((r) => [r.parentQuestionId!, r._count._all])),
  };
}

type References = Awaited<ReturnType<typeof loadReferences>>;

function classify(
  runId: string,
  question: { id: string; importBatchId: string | null; status: QuestionStatus } | null | undefined,
  refs: References
): { classification: RollbackClass; reasons: string[] } {
  if (!question) return { classification: "ALREADY_MISSING", reasons: ["Question no longer exists."] };
  const id = question.id;
  const protectedReasons: string[] = [];
  const mocks = refs.mock.get(id);
  if (mocks) protectedReasons.push(`In Mock Test: ${mocks.join(", ")}`);
  const customs = refs.custom.get(id);
  if (customs) protectedReasons.push(`In Custom Module: ${customs.join(", ")}`);
  if (refs.grand.get(id)) protectedReasons.push("In a Grand Test");
  if (refs.live.get(id)) protectedReasons.push("In a Live Test");
  if (question.importBatchId !== runId) protectedReasons.push("Later overwritten by another import run");
  if (protectedReasons.length) return { classification: "PROTECTED", reasons: protectedReasons };

  const archiveReasons: string[] = [];
  const attempts = refs.attempts.get(id) ?? 0;
  if (attempts) archiveReasons.push(`Used in ${attempts} student test attempt${attempts === 1 ? "" : "s"}`);
  const answers = refs.answers.get(id) ?? 0;
  if (answers && !attempts) archiveReasons.push(`${answers} stored answer${answers === 1 ? "" : "s"}`);
  if (refs.saved.get(id)) archiveReasons.push(`Saved by ${refs.saved.get(id)} student(s)`);
  if (refs.reports.get(id)) archiveReasons.push(`${refs.reports.get(id)} student report(s)`);
  if (refs.variants.get(id)) archiveReasons.push(`${refs.variants.get(id)} AI variant(s) depend on it`);
  if (archiveReasons.length) return { classification: "ARCHIVE_ONLY", reasons: archiveReasons };

  return { classification: "SAFE_TO_DELETE", reasons: [] };
}

/** Read-only impact analysis of one import run — safe for any admin (FULL_ADMIN included). */
export async function analyzeImportRun(runId: string): Promise<{ rows: ImportedQuestionRow[]; summary: RollbackSummary } | null> {
  const run = await prisma.bulkImportRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) return null;

  const rows = await prisma.bulkImportRow.findMany({
    where: { runId, status: { in: [BulkImportRowStatus.SUCCESS, BulkImportRowStatus.REPLACED, BulkImportRowStatus.SKIPPED] }, questionId: { not: null } },
    orderBy: { rowNumber: "asc" },
    select: { id: true, rowNumber: true, status: true, questionId: true, questionCode: true, rollbackAction: true, rollbackReason: true },
  });
  const questionIds = [...new Set(rows.map((r) => r.questionId!))];
  const [questions, refs, allCounts] = await Promise.all([
    prisma.question.findMany({
      where: { id: { in: questionIds } },
      select: {
        id: true,
        text: true,
        status: true,
        importBatchId: true,
        subject: { select: { name: true } },
        topic: { select: { name: true } },
        subTopic: { select: { name: true } },
      },
    }),
    loadReferences(prisma, rows.filter((r) => r.status === BulkImportRowStatus.SUCCESS).map((r) => r.questionId!)),
    prisma.bulkImportRow.groupBy({ by: ["status"], where: { runId }, _count: { _all: true } }),
  ]);
  const byId = new Map(questions.map((q) => [q.id, q]));

  const out: ImportedQuestionRow[] = rows.map((r) => {
    const q = byId.get(r.questionId!);
    const action = ACTION_BY_STATUS[r.status];
    const done = r.rollbackAction === BulkImportRollbackAction.DELETED || r.rollbackAction === BulkImportRollbackAction.ALREADY_MISSING;
    const c = action === "CREATED" && !done ? classify(runId, q, refs) : null;
    const archivedAlready = c?.classification === "ARCHIVE_ONLY" && q?.status === QuestionStatus.ARCHIVED;
    return {
      rowId: r.id,
      rowNumber: r.rowNumber,
      questionId: r.questionId,
      questionCode: r.questionCode,
      action,
      rollbackAction: r.rollbackAction,
      rollbackReason: r.rollbackReason,
      question: q
        ? { text: q.text, status: q.status, subject: q.subject?.name ?? null, topic: q.topic?.name ?? null, subTopic: q.subTopic?.name ?? null }
        : null,
      classification: c?.classification ?? null,
      reasons: c?.reasons ?? (action === "CREATED" ? [] : ["Existed before this import — never deleted by rollback."]),
      eligible: Boolean(c && (c.classification === "SAFE_TO_DELETE" || (c.classification === "ARCHIVE_ONLY" && !archivedAlready))),
    };
  });

  const statusCount = (s: BulkImportRowStatus) => allCounts.find((c) => c.status === s)?._count._all ?? 0;
  const created = out.filter((r) => r.action === "CREATED");
  const summary: RollbackSummary = {
    created: statusCount(BulkImportRowStatus.SUCCESS),
    replaced: statusCount(BulkImportRowStatus.REPLACED),
    skipped: statusCount(BulkImportRowStatus.SKIPPED),
    failed: statusCount(BulkImportRowStatus.FAILED),
    safeToDelete: created.filter((r) => r.classification === "SAFE_TO_DELETE").length,
    archiveOnly: created.filter((r) => r.classification === "ARCHIVE_ONLY").length,
    protected: created.filter((r) => r.classification === "PROTECTED").length,
    alreadyMissing: created.filter((r) => r.classification === "ALREADY_MISSING" || r.rollbackAction === "ALREADY_MISSING").length,
    laterDeleted: created.filter((r) => r.rollbackAction === "DELETED").length,
    laterArchived: created.filter((r) => r.rollbackAction === "ARCHIVED").length,
    laterProtected: created.filter((r) => r.rollbackAction === "PROTECTED").length,
  };
  return { rows: out, summary };
}

export interface RollbackResult {
  deleted: { questionId: string; code: string | null }[];
  archived: { questionId: string; code: string | null }[];
  protected: { questionId: string; code: string | null; reason: string }[];
  alreadyMissing: { questionId: string; code: string | null }[];
  failed: { questionId: string; code: string | null; error: string }[];
  /** Rows already deleted by an earlier (or concurrent) rollback — the idempotent no-op case. */
  alreadyProcessed: number;
}

/**
 * Executes the rollback for CREATED rows of one run (optionally only the
 * given row ids). Each question is handled in its own short transaction that
 * first locks the run row (serializing concurrent/double submissions), then
 * re-reads the row and re-classifies against current references — so a
 * retry or double click can never delete twice or act on stale analysis,
 * and thousands of questions never sit in one long-running transaction.
 */
export async function executeImportRollback(input: { runId: string; rowIds?: string[]; actorId: string }): Promise<RollbackResult> {
  const { runId, rowIds, actorId } = input;
  const result: RollbackResult = { deleted: [], archived: [], protected: [], alreadyMissing: [], failed: [], alreadyProcessed: 0 };

  const candidates = await prisma.bulkImportRow.findMany({
    where: {
      runId,
      status: BulkImportRowStatus.SUCCESS,
      questionId: { not: null },
      ...(rowIds ? { id: { in: rowIds } } : {}),
    },
    orderBy: { rowNumber: "asc" },
    select: { id: true },
  });

  for (const { id: rowId } of candidates) {
    let questionId = "";
    let code: string | null = null;
    try {
      const outcome = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "BulkImportRun" WHERE id = ${runId} FOR UPDATE`;
          const row = await tx.bulkImportRow.findUnique({
            where: { id: rowId },
            select: { questionId: true, questionCode: true, status: true, runId: true, rollbackAction: true },
          });
          // Defense in depth: only this run's CREATED rows, never twice.
          if (!row || row.runId !== runId || row.status !== BulkImportRowStatus.SUCCESS || !row.questionId) return { kind: "skip" as const };
          questionId = row.questionId;
          code = row.questionCode;
          if (row.rollbackAction === BulkImportRollbackAction.DELETED || row.rollbackAction === BulkImportRollbackAction.ALREADY_MISSING) {
            return { kind: "processed" as const };
          }

          const question = await tx.question.findUnique({ where: { id: row.questionId }, select: { id: true, importBatchId: true, status: true } });
          const refs = await loadReferences(tx, [row.questionId]);
          const { classification, reasons } = classify(runId, question, refs);
          const mark = (action: BulkImportRollbackAction, reason: string | null) =>
            tx.bulkImportRow.update({ where: { id: rowId }, data: { rollbackAction: action, rollbackReason: reason, rollbackAt: new Date() } });

          if (classification === "ALREADY_MISSING") {
            await mark(BulkImportRollbackAction.ALREADY_MISSING, reasons.join("; "));
            return { kind: "missing" as const };
          }
          if (classification === "PROTECTED") {
            await mark(BulkImportRollbackAction.PROTECTED, reasons.join("; "));
            return { kind: "protected" as const, reason: reasons.join("; ") };
          }
          if (classification === "ARCHIVE_ONLY") {
            if (question!.status !== QuestionStatus.ARCHIVED) {
              await tx.question.update({ where: { id: question!.id }, data: { status: QuestionStatus.ARCHIVED } });
            }
            await mark(BulkImportRollbackAction.ARCHIVED, reasons.join("; "));
            return { kind: "archived" as const };
          }
          // SAFE_TO_DELETE: the question row only (options / its own AI
          // explanation cache cascade). Never Subject/Topic/SubTopic/Exam.
          await tx.question.delete({ where: { id: question!.id } });
          await mark(BulkImportRollbackAction.DELETED, null);
          return { kind: "deleted" as const };
        },
        { timeout: 20_000 }
      );

      if (outcome.kind === "deleted") result.deleted.push({ questionId, code });
      else if (outcome.kind === "archived") result.archived.push({ questionId, code });
      else if (outcome.kind === "protected") result.protected.push({ questionId, code, reason: outcome.reason });
      else if (outcome.kind === "missing") result.alreadyMissing.push({ questionId, code });
      else if (outcome.kind === "processed") result.alreadyProcessed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      result.failed.push({ questionId, code, error: message });
      await prisma.bulkImportRow
        .update({ where: { id: rowId }, data: { rollbackAction: BulkImportRollbackAction.FAILED, rollbackReason: message.slice(0, 500), rollbackAt: new Date() } })
        .catch(() => undefined);
    }
  }

  // The run (audit record) is kept; it only remembers when/who rolled back.
  await prisma.bulkImportRun.update({ where: { id: runId }, data: { lastRollbackAt: new Date(), lastRollbackById: actorId } });
  await prisma.auditLog.create({
    data: {
      actorId,
      action: "BULK_IMPORT_ROLLBACK",
      entityType: "BulkImportRun",
      entityId: runId,
      metadata: {
        scope: rowIds ? "SELECTED" : "ALL_CREATED",
        deleted: result.deleted,
        archived: result.archived,
        protected: result.protected,
        alreadyMissing: result.alreadyMissing,
        failed: result.failed,
        alreadyProcessed: result.alreadyProcessed,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return result;
}
