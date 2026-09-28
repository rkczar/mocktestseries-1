import "server-only";
import { prisma } from "@/lib/prisma";
import { AttemptStatus, BulkImportRollbackAction, BulkImportRowStatus, QuestionStatus, type Prisma } from "@prisma/client";
import {
  rowMatches,
  type Dependency,
  type ImportAction,
  type ImportedQuestionRow,
  type ImportSelection,
  type RollbackClass,
} from "@/lib/import-history-selection";

export type { Dependency, ImportedQuestionRow, RollbackClass } from "@/lib/import-history-selection";

/**
 * Import History → View Import: archive / permanently delete / resolve the
 * questions an import run CREATED.
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
 *   SAFE_TO_DELETE   no references — may be hard deleted (options + its own
 *                    AI explanation cache go with it) or archived.
 *   ARCHIVE_ONLY     student history or student-owned content: test attempts
 *                    (in progress or finished), answers, saved-by-students,
 *                    student reports, students' own Custom Modules, AI
 *                    variants. Never hard deleted — the result page still
 *                    reads the live Question for its subject/topic breakdown
 *                    and saved/report rows would cascade away. ARCHIVED
 *                    leaves every active pool; frozen attempt snapshots
 *                    keep historical results unchanged.
 *   PROTECTED        part of a live test/paper definition: Mock Test,
 *                    Previous Year Paper, admin Custom Module, Grand / Live
 *                    Test — or later overwritten by another import. Mock and
 *                    PYQ attempts serve only PUBLISHED questions, so even
 *                    archiving would silently change those tests. Untouched
 *                    until the owner explicitly resolves it (Resolve & Remove).
 *   ALREADY_MISSING  the question no longer exists.
 *
 * The BulkImportRun / BulkImportRow audit record is never deleted.
 * Shared taxonomy (Exam / Subject / Topic / SubTopic) is never deleted here.
 */

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
  /** CREATED questions that still exist and are not ARCHIVED. */
  active: number;
  /** CREATED questions that currently have status ARCHIVED (however they got there). */
  archivedNow: number;
}

const ACTION_BY_STATUS: Record<BulkImportRowStatus, ImportAction> = {
  SUCCESS: "CREATED",
  REPLACED: "REPLACED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
  PENDING: "PENDING",
};

type Db = Prisma.TransactionClient | typeof prisma;

const QUESTION_REF_SELECT = {
  id: true,
  importBatchId: true,
  status: true,
  previousYearPaper: { select: { id: true, title: true } },
} as const satisfies Prisma.QuestionSelect;

type QuestionRef = Prisma.QuestionGetPayload<{ select: typeof QUESTION_REF_SELECT }>;

/** Reference facts for a set of questions — one grouped query per relation, never N+1. */
async function loadReferences(db: Db, questionIds: string[]) {
  const ids = questionIds.length ? questionIds : ["__none__"];
  const [mock, custom, grand, live, attemptRows, answers, saved, reports, variants] = await Promise.all([
    db.mockTestQuestion.findMany({ where: { questionId: { in: ids } }, select: { questionId: true, mockTest: { select: { id: true, title: true } } } }),
    db.customModuleQuestion.findMany({
      where: { questionId: { in: ids } },
      select: { questionId: true, customModule: { select: { id: true, title: true, isStudentOwned: true } } },
    }),
    db.grandTestQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.liveTestQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.testAttemptQuestion.findMany({ where: { questionId: { in: ids } }, select: { questionId: true, attempt: { select: { status: true } } } }),
    db.answer.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.savedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.reportedQuestion.groupBy({ by: ["questionId"], where: { questionId: { in: ids } }, _count: { _all: true } }),
    db.question.groupBy({ by: ["parentQuestionId"], where: { parentQuestionId: { in: ids } }, _count: { _all: true } }),
  ]);
  const mockIds = [...new Set(mock.map((m) => m.mockTest.id))];
  const mockAttempts = mockIds.length
    ? await db.testAttempt.groupBy({ by: ["mockTestId"], where: { mockTestId: { in: mockIds } }, _count: { _all: true } })
    : [];
  const count = (rows: { questionId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.questionId, r._count._all]));
  const group = <T extends { questionId: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.questionId, [...(m.get(r.questionId) ?? []), r]);
    return m;
  };
  const activeAttempts = new Map<string, number>();
  const pastAttempts = new Map<string, number>();
  for (const r of attemptRows) {
    const target = r.attempt.status === AttemptStatus.IN_PROGRESS ? activeAttempts : pastAttempts;
    target.set(r.questionId, (target.get(r.questionId) ?? 0) + 1);
  }
  return {
    mock: group(mock),
    mockAttempts: new Map(mockAttempts.map((r) => [r.mockTestId!, r._count._all])),
    custom: group(custom),
    grand: count(grand),
    live: count(live),
    activeAttempts,
    pastAttempts,
    answers: count(answers),
    saved: count(saved),
    reports: count(reports),
    variants: new Map(variants.map((r) => [r.parentQuestionId!, r._count._all])),
  };
}

type References = Awaited<ReturnType<typeof loadReferences>>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function dependenciesOf(runId: string, question: QuestionRef, refs: References): Dependency[] {
  const id = question.id;
  const deps: Dependency[] = [];
  const mocks = refs.mock.get(id) ?? [];
  if (mocks.length) {
    deps.push({
      kind: "MOCK_TEST",
      level: "PROTECT",
      detachable: true,
      count: mocks.length,
      label: `Used in ${plural(mocks.length, "Mock Test")}`,
      items: mocks.map((m) => ({ id: m.mockTest.id, title: m.mockTest.title, attempts: refs.mockAttempts.get(m.mockTest.id) ?? 0 })),
    });
  }
  if (question.previousYearPaper) {
    deps.push({
      kind: "PYQ_PAPER",
      level: "PROTECT",
      detachable: true,
      count: 1,
      label: `Previous Year Paper: ${question.previousYearPaper.title}`,
      items: [{ id: question.previousYearPaper.id, title: question.previousYearPaper.title }],
    });
  }
  const customs = refs.custom.get(id) ?? [];
  const adminModules = customs.filter((c) => !c.customModule.isStudentOwned);
  const studentModules = customs.filter((c) => c.customModule.isStudentOwned);
  if (adminModules.length) {
    deps.push({
      kind: "ADMIN_CUSTOM_MODULE",
      level: "PROTECT",
      detachable: true,
      count: adminModules.length,
      label: `Used by ${plural(adminModules.length, "Custom Module")}`,
      items: adminModules.map((c) => ({ id: c.customModule.id, title: c.customModule.title })),
    });
  }
  const grand = refs.grand.get(id) ?? 0;
  if (grand) deps.push({ kind: "GRAND_TEST", level: "PROTECT", detachable: false, count: grand, label: `In ${plural(grand, "Grand Test")}` });
  const live = refs.live.get(id) ?? 0;
  if (live) deps.push({ kind: "LIVE_TEST", level: "PROTECT", detachable: false, count: live, label: `In ${plural(live, "Live Test")}` });
  if (question.importBatchId !== runId) {
    deps.push({ kind: "OVERWRITTEN", level: "PROTECT", detachable: false, count: 1, label: "Later overwritten by another import run" });
  }

  const active = refs.activeAttempts.get(id) ?? 0;
  if (active) deps.push({ kind: "ATTEMPT_ACTIVE", level: "ARCHIVE", detachable: false, count: active, label: `In-progress attempt dependency (${active})` });
  const past = refs.pastAttempts.get(id) ?? 0;
  if (past) deps.push({ kind: "ATTEMPT_HISTORY", level: "ARCHIVE", detachable: false, count: past, label: `Historical attempt dependency (${past})` });
  const answers = refs.answers.get(id) ?? 0;
  if (answers && !active && !past) deps.push({ kind: "ATTEMPT_HISTORY", level: "ARCHIVE", detachable: false, count: answers, label: `${plural(answers, "stored answer")}` });
  if (studentModules.length) {
    deps.push({
      kind: "STUDENT_CUSTOM_MODULE",
      level: "ARCHIVE",
      detachable: false,
      count: studentModules.length,
      label: `In ${plural(studentModules.length, "student's Custom Module", "students' Custom Modules")}`,
    });
  }
  const saved = refs.saved.get(id) ?? 0;
  if (saved) deps.push({ kind: "SAVED", level: "ARCHIVE", detachable: false, count: saved, label: `Saved by ${plural(saved, "student")}` });
  const reports = refs.reports.get(id) ?? 0;
  if (reports) deps.push({ kind: "REPORTED", level: "ARCHIVE", detachable: false, count: reports, label: `${plural(reports, "student report")}` });
  const variants = refs.variants.get(id) ?? 0;
  if (variants) deps.push({ kind: "AI_VARIANTS", level: "ARCHIVE", detachable: false, count: variants, label: `${plural(variants, "AI variant")} depend on it` });
  return deps;
}

function classify(
  runId: string,
  question: QuestionRef | null | undefined,
  refs: References
): { classification: RollbackClass; reasons: string[]; dependencies: Dependency[] } {
  if (!question) return { classification: "ALREADY_MISSING", reasons: ["Question no longer exists."], dependencies: [] };
  const dependencies = dependenciesOf(runId, question, refs);
  const protect = dependencies.filter((d) => d.level === "PROTECT");
  if (protect.length) return { classification: "PROTECTED", reasons: protect.map((d) => d.label), dependencies };
  const archive = dependencies.filter((d) => d.level === "ARCHIVE");
  if (archive.length) return { classification: "ARCHIVE_ONLY", reasons: archive.map((d) => d.label), dependencies };
  return { classification: "SAFE_TO_DELETE", reasons: [], dependencies };
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
        ...QUESTION_REF_SELECT,
        text: true,
        exam: { select: { name: true } },
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
    const archivedAlready = q?.status === QuestionStatus.ARCHIVED;
    return {
      rowId: r.id,
      rowNumber: r.rowNumber,
      questionId: r.questionId,
      questionCode: r.questionCode,
      action,
      rollbackAction: r.rollbackAction,
      rollbackReason: r.rollbackReason,
      question: q
        ? {
            text: q.text,
            status: q.status,
            exam: q.exam?.name ?? null,
            subject: q.subject?.name ?? null,
            topic: q.topic?.name ?? null,
            subTopic: q.subTopic?.name ?? null,
          }
        : null,
      classification: c?.classification ?? null,
      reasons: c?.reasons ?? (action === "CREATED" ? [] : ["Existed before this import — never deleted from here."]),
      dependencies: c?.dependencies ?? [],
      // Eligible for a plain bulk operation: deletable (even if already
      // archived — it can still be permanently removed), or archivable and
      // not archived yet. PROTECTED needs Resolve & Remove.
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
    active: created.filter((r) => r.question && r.question.status !== QuestionStatus.ARCHIVED).length,
    archivedNow: created.filter((r) => r.question?.status === QuestionStatus.ARCHIVED).length,
  };
  return { rows: out, summary };
}

export class SelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelectionError";
  }
}

/**
 * Turns a client selection into this run's CREATED row ids. Explicit ids
 * are validated as a whole: any id that is not a CREATED row of THIS run
 * (another import's row, a replaced/skipped row, garbage) rejects the entire
 * request — nothing is silently dropped or acted on. "all" re-runs the
 * analysis and the shared filter on the server; the client never sends ids
 * it did not render.
 */
export async function resolveSelection(runId: string, selection: ImportSelection): Promise<string[]> {
  if (selection.kind === "ids") {
    const ids = [...new Set(selection.rowIds)];
    if (ids.length === 0) throw new SelectionError("Nothing selected.");
    const found = await prisma.bulkImportRow.findMany({
      where: { id: { in: ids }, runId, status: BulkImportRowStatus.SUCCESS, questionId: { not: null } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new SelectionError(`${ids.length - found.length} selected row(s) are not questions created by this import. Nothing was changed.`);
    }
    return ids;
  }
  const analysis = await analyzeImportRun(runId);
  if (!analysis) throw new SelectionError("Import run not found.");
  return analysis.rows.filter((r) => r.action === "CREATED" && rowMatches(r, selection.filter, selection.search)).map((r) => r.rowId);
}

export interface SelectionPreview {
  total: number;
  safe: number;
  archive: number;
  protected: number;
  missing: number;
  /** ARCHIVE_ONLY rows that are already ARCHIVED — nothing left to do for them. */
  alreadyArchived: number;
  /** SAFE rows that are not archived yet (what an Archive would change). */
  safeNotArchived: number;
}

export async function previewSelection(runId: string, rowIds: string[]): Promise<SelectionPreview | null> {
  const analysis = await analyzeImportRun(runId);
  if (!analysis) return null;
  const set = new Set(rowIds);
  const inScope = analysis.rows.filter((r) => set.has(r.rowId) && r.action === "CREATED");
  const archived = (r: ImportedQuestionRow) => r.question?.status === QuestionStatus.ARCHIVED;
  return {
    total: inScope.length,
    safe: inScope.filter((r) => r.classification === "SAFE_TO_DELETE").length,
    archive: inScope.filter((r) => r.classification === "ARCHIVE_ONLY" && !archived(r)).length,
    protected: inScope.filter((r) => r.classification === "PROTECTED").length,
    missing: inScope.filter((r) => r.classification === "ALREADY_MISSING" || r.classification === null).length,
    alreadyArchived: inScope.filter((r) => r.classification === "ARCHIVE_ONLY" && archived(r)).length,
    safeNotArchived: inScope.filter((r) => r.classification === "SAFE_TO_DELETE" && !archived(r)).length,
  };
}

/**
 * AUTO     permanently delete SAFE, archive ARCHIVE_ONLY (the original
 *          "Delete Questions Created By This Import").
 * DELETE   permanently delete SAFE only; ARCHIVE_ONLY is left untouched and
 *          reported as needing archive.
 * ARCHIVE  archive SAFE and ARCHIVE_ONLY; nothing is hard deleted.
 * PROTECTED is never touched by any mode — see resolveProtectedQuestions.
 */
export type RollbackMode = "AUTO" | "DELETE" | "ARCHIVE";

type Ref = { questionId: string; code: string | null };

export interface RollbackResult {
  deleted: Ref[];
  archived: Ref[];
  protected: (Ref & { reason: string })[];
  /** DELETE mode: history-referenced questions that were left untouched (archive them instead). */
  keptForHistory: (Ref & { reason: string })[];
  alreadyMissing: Ref[];
  failed: (Ref & { error: string })[];
  /** Rows already deleted (or already archived, for ARCHIVE) — the idempotent no-op case. */
  alreadyProcessed: number;
}

function auditActionFor(mode: RollbackMode, scopeSize: number, result: RollbackResult): string {
  const single = scopeSize === 1;
  if (mode === "ARCHIVE") return single ? "IMPORT_QUESTION_ARCHIVED" : "IMPORT_BULK_ARCHIVED";
  if (single) return result.archived.length && !result.deleted.length ? "IMPORT_QUESTION_ARCHIVED" : "IMPORT_QUESTION_DELETED";
  return "IMPORT_BULK_DELETED";
}

/**
 * Executes delete/archive for CREATED rows of one run (optionally only the
 * given row ids). Each question is handled in its own short transaction that
 * first locks the run row (serializing concurrent/double submissions), then
 * re-reads the row and re-classifies against current references — so a
 * retry or double click can never delete twice or act on stale analysis,
 * and thousands of questions never sit in one long-running transaction.
 */
export async function executeImportRollback(input: { runId: string; rowIds?: string[]; actorId: string; mode?: RollbackMode }): Promise<RollbackResult> {
  const { runId, rowIds, actorId } = input;
  const mode = input.mode ?? "AUTO";
  const result: RollbackResult = { deleted: [], archived: [], protected: [], keptForHistory: [], alreadyMissing: [], failed: [], alreadyProcessed: 0 };

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

          const question = await tx.question.findUnique({ where: { id: row.questionId }, select: QUESTION_REF_SELECT });
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
          const archive = async (reason: string | null) => {
            if (question!.status === QuestionStatus.ARCHIVED && row.rollbackAction === BulkImportRollbackAction.ARCHIVED) return { kind: "processed" as const };
            if (question!.status !== QuestionStatus.ARCHIVED) {
              await tx.question.update({ where: { id: question!.id }, data: { status: QuestionStatus.ARCHIVED } });
            }
            await mark(BulkImportRollbackAction.ARCHIVED, reason);
            return { kind: "archived" as const };
          };
          if (mode === "ARCHIVE") return archive(reasons.length ? reasons.join("; ") : "Archived by Master Admin");
          if (classification === "ARCHIVE_ONLY") {
            if (mode === "DELETE") return { kind: "kept" as const, reason: reasons.join("; ") };
            return archive(reasons.join("; "));
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
      else if (outcome.kind === "kept") result.keptForHistory.push({ questionId, code, reason: outcome.reason });
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
      action: auditActionFor(mode, rowIds ? rowIds.length : candidates.length, result),
      entityType: "BulkImportRun",
      entityId: runId,
      metadata: {
        importRunId: runId,
        operation: mode,
        scope: rowIds ? "SELECTED" : "ALL_CREATED",
        requested: candidates.length,
        counts: {
          deleted: result.deleted.length,
          archived: result.archived.length,
          protected: result.protected.length,
          keptForHistory: result.keptForHistory.length,
          alreadyMissing: result.alreadyMissing.length,
          failed: result.failed.length,
          alreadyProcessed: result.alreadyProcessed,
        },
        deleted: result.deleted,
        archived: result.archived,
        protected: result.protected,
        keptForHistory: result.keptForHistory,
        alreadyMissing: result.alreadyMissing,
        failed: result.failed,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return result;
}

// ---------------------------------------------------------------------------
// Resolve & Remove (protected override)
// ---------------------------------------------------------------------------

export interface ResolveDetach {
  /** Remove the question from every Mock Test it is attached to. */
  mockTests: boolean;
  /** Clear its Previous Year Paper link (the Question itself is kept). */
  pyqPaper: boolean;
  /** Remove it from admin-authored Custom Modules (never students' own modules). */
  adminCustomModules: boolean;
}

export type ResolveThen = "NONE" | "ARCHIVE" | "DELETE";

export interface ResolveResult {
  detached: (Ref & { mockTests: string[]; pyqPaper: string | null; adminCustomModules: string[] })[];
  deleted: Ref[];
  archived: Ref[];
  /** Still protected after the chosen detaches (e.g. Grand/Live Test, overwritten, or a link not chosen). */
  stillProtected: (Ref & { reason: string })[];
  alreadyMissing: Ref[];
  failed: (Ref & { error: string })[];
}

/** What Resolve & Remove could do for one row — shown before anything happens. */
export interface ResolvePlanRow {
  rowId: string;
  questionCode: string | null;
  text: string | null;
  exam: string | null;
  classification: RollbackClass | null;
  dependencies: Dependency[];
  /** After detaching every detachable link: DELETE (safe), ARCHIVE (history), or PROTECTED (non-detachable link remains). */
  bestOutcome: "DELETE" | "ARCHIVE" | "PROTECTED" | "MISSING";
}

export async function planResolve(runId: string, rowIds: string[]): Promise<{ filename: string; rows: ResolvePlanRow[] } | null> {
  const run = await prisma.bulkImportRun.findUnique({ where: { id: runId }, select: { filename: true } });
  const analysis = await analyzeImportRun(runId);
  if (!run || !analysis) return null;
  const set = new Set(rowIds);
  const rows = analysis.rows
    // Resolve & Remove is only for PROTECTED rows; everything else uses the plain Archive / Delete flow.
    .filter((r) => set.has(r.rowId) && r.action === "CREATED" && r.classification === "PROTECTED")
    .map((r): ResolvePlanRow => {
      const deps = r.dependencies;
      const bestOutcome: ResolvePlanRow["bestOutcome"] = !r.question
        ? "MISSING"
        : deps.some((d) => d.level === "PROTECT" && !d.detachable)
          ? "PROTECTED"
          : deps.some((d) => d.level === "ARCHIVE")
            ? "ARCHIVE"
            : "DELETE";
      return {
        rowId: r.rowId,
        questionCode: r.questionCode,
        text: r.question?.text ?? null,
        exam: r.question?.exam ?? null,
        classification: r.classification,
        dependencies: deps,
        bestOutcome,
      };
    });
  return { filename: run.filename, rows };
}

/**
 * Explicit, owner-confirmed resolution of protected imported questions.
 * Per question, in its own locked transaction: detach ONLY the link kinds
 * the owner ticked (never Grand/Live Tests, never students' own modules,
 * never attempts or snapshots), then re-classify and apply `then`:
 *   NONE     keep the question (e.g. only a wrong PYQ link was removed)
 *   ARCHIVE  archive it if nothing protective remains
 *   DELETE   permanently delete it if now SAFE; if student history exists
 *            it is ARCHIVED instead — history is never destroyed.
 * Tests and papers themselves are never deleted; frozen TestAttemptQuestion
 * snapshots and Answers are never touched, so submitted results stay identical.
 */
export async function resolveProtectedQuestions(input: {
  runId: string;
  rowIds: string[];
  detach: ResolveDetach;
  then: ResolveThen;
  actorId: string;
}): Promise<ResolveResult> {
  const { runId, rowIds, detach, then, actorId } = input;
  const result: ResolveResult = { detached: [], deleted: [], archived: [], stillProtected: [], alreadyMissing: [], failed: [] };

  const candidates = await prisma.bulkImportRow.findMany({
    where: { runId, status: BulkImportRowStatus.SUCCESS, questionId: { not: null }, id: { in: rowIds } },
    orderBy: { rowNumber: "asc" },
    select: { id: true },
  });

  for (const { id: rowId } of candidates) {
    let questionId = "";
    let code: string | null = null;
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "BulkImportRun" WHERE id = ${runId} FOR UPDATE`;
          const row = await tx.bulkImportRow.findUnique({ where: { id: rowId }, select: { questionId: true, questionCode: true, status: true, runId: true } });
          if (!row || row.runId !== runId || row.status !== BulkImportRowStatus.SUCCESS || !row.questionId) return;
          questionId = row.questionId;
          code = row.questionCode;
          const mark = (action: BulkImportRollbackAction, reason: string | null) =>
            tx.bulkImportRow.update({ where: { id: rowId }, data: { rollbackAction: action, rollbackReason: reason, rollbackAt: new Date() } });

          const question = await tx.question.findUnique({ where: { id: row.questionId }, select: QUESTION_REF_SELECT });
          if (!question) {
            await mark(BulkImportRollbackAction.ALREADY_MISSING, "Question no longer exists.");
            result.alreadyMissing.push({ questionId, code });
            return;
          }
          // A question another import later overwrote belongs to that import now.
          if (question.importBatchId !== runId) {
            result.stillProtected.push({ questionId, code, reason: "Later overwritten by another import run" });
            return;
          }

          const refs = await loadReferences(tx, [question.id]);
          const deps = dependenciesOf(runId, question, refs);
          const detachedMocks: string[] = [];
          const detachedModules: string[] = [];
          let detachedPaper: string | null = null;
          if (detach.mockTests) {
            const mock = deps.find((d) => d.kind === "MOCK_TEST");
            if (mock) {
              await tx.mockTestQuestion.deleteMany({ where: { questionId: question.id } });
              detachedMocks.push(...(mock.items ?? []).map((i) => i.title));
            }
          }
          if (detach.adminCustomModules) {
            const mods = deps.find((d) => d.kind === "ADMIN_CUSTOM_MODULE");
            if (mods) {
              await tx.customModuleQuestion.deleteMany({ where: { questionId: question.id, customModule: { isStudentOwned: false } } });
              detachedModules.push(...(mods.items ?? []).map((i) => i.title));
            }
          }
          if (detach.pyqPaper && question.previousYearPaper) {
            await tx.question.update({ where: { id: question.id }, data: { previousYearPaperId: null } });
            detachedPaper = question.previousYearPaper.title;
          }
          if (detachedMocks.length || detachedModules.length || detachedPaper) {
            result.detached.push({ questionId, code, mockTests: detachedMocks, pyqPaper: detachedPaper, adminCustomModules: detachedModules });
          }

          const fresh = await tx.question.findUnique({ where: { id: question.id }, select: QUESTION_REF_SELECT });
          const { classification, reasons } = classify(runId, fresh, await loadReferences(tx, [question.id]));
          if (classification === "PROTECTED") {
            await mark(BulkImportRollbackAction.PROTECTED, reasons.join("; "));
            result.stillProtected.push({ questionId, code, reason: reasons.join("; ") });
            return;
          }
          if (then === "NONE") {
            // Only links were removed; clear a stale PROTECTED mark so history shows the current truth.
            await tx.bulkImportRow.update({ where: { id: rowId }, data: { rollbackAction: null, rollbackReason: null, rollbackAt: new Date() } });
            return;
          }
          if (then === "DELETE" && classification === "SAFE_TO_DELETE") {
            await tx.question.delete({ where: { id: question.id } });
            await mark(BulkImportRollbackAction.DELETED, "Resolved & removed by Master Admin");
            result.deleted.push({ questionId, code });
            return;
          }
          // ARCHIVE, or DELETE of a question with student history → archive (history is never destroyed).
          if (fresh!.status !== QuestionStatus.ARCHIVED) {
            await tx.question.update({ where: { id: question.id }, data: { status: QuestionStatus.ARCHIVED } });
          }
          await mark(BulkImportRollbackAction.ARCHIVED, reasons.length ? reasons.join("; ") : "Resolved & archived by Master Admin");
          result.archived.push({ questionId, code });
        },
        { timeout: 20_000 }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      result.failed.push({ questionId, code, error: message });
    }
  }

  await prisma.bulkImportRun.update({ where: { id: runId }, data: { lastRollbackAt: new Date(), lastRollbackById: actorId } });
  const base = { importRunId: runId, requested: candidates.length, detachChoice: detach, then };
  const events: Prisma.AuditLogCreateManyInput[] = [
    {
      actorId,
      action: "IMPORT_PROTECTED_OVERRIDE",
      entityType: "BulkImportRun",
      entityId: runId,
      metadata: {
        ...base,
        counts: {
          detached: result.detached.length,
          deleted: result.deleted.length,
          archived: result.archived.length,
          stillProtected: result.stillProtected.length,
          alreadyMissing: result.alreadyMissing.length,
          failed: result.failed.length,
        },
        stillProtected: result.stillProtected,
        failed: result.failed,
      } as unknown as Prisma.InputJsonValue,
    },
  ];
  if (result.detached.length) {
    events.push({
      actorId,
      action: "IMPORT_QUESTION_DETACHED",
      entityType: "BulkImportRun",
      entityId: runId,
      metadata: { ...base, detached: result.detached } as unknown as Prisma.InputJsonValue,
    });
  }
  if (result.deleted.length) {
    events.push({
      actorId,
      action: result.deleted.length === 1 ? "IMPORT_QUESTION_DELETED" : "IMPORT_BULK_DELETED",
      entityType: "BulkImportRun",
      entityId: runId,
      metadata: { ...base, operation: "RESOLVE_DELETE", deleted: result.deleted } as unknown as Prisma.InputJsonValue,
    });
  }
  if (result.archived.length) {
    events.push({
      actorId,
      action: result.archived.length === 1 ? "IMPORT_QUESTION_ARCHIVED" : "IMPORT_BULK_ARCHIVED",
      entityType: "BulkImportRun",
      entityId: runId,
      metadata: { ...base, operation: "RESOLVE_ARCHIVE", archived: result.archived } as unknown as Prisma.InputJsonValue,
    });
  }
  await prisma.auditLog.createMany({ data: events });
  return result;
}

/**
 * Per-run lifecycle counts for the Import History list, from the live
 * questions each run's CREATED rows point at (one grouped query): a missing
 * question counts as deleted, an ARCHIVED one as archived — the same facts
 * the run detail page shows.
 */
export async function importRunLifecycle(runIds: string[]) {
  const out = new Map<string, { created: number; deleted: number; archived: number }>();
  if (runIds.length === 0) return out;
  const rows = await prisma.$queryRaw<{ runId: string; created: number; deleted: number; archived: number }[]>`
    SELECT r."runId",
           count(*)::int AS created,
           count(*) FILTER (WHERE q.id IS NULL)::int AS deleted,
           count(*) FILTER (WHERE q.status = 'ARCHIVED')::int AS archived
      FROM "BulkImportRow" r
      LEFT JOIN "Question" q ON q.id = r."questionId"
     WHERE r."runId" = ANY(${runIds}) AND r.status = 'SUCCESS' AND r."questionId" IS NOT NULL
     GROUP BY r."runId"`;
  for (const r of rows) out.set(r.runId, { created: r.created, deleted: r.deleted, archived: r.archived });
  return out;
}
