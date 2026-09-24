import "server-only";
import { prisma } from "@/lib/prisma";
import { allocateQuestionCode, questionCodeScope } from "@/lib/question-code";
import {
  BulkImportDuplicateStrategy,
  BulkImportRowStatus,
  BulkImportStatus,
  ImportRowSeverity,
  QuestionSource,
  QuestionStatus,
  type Prisma,
} from "@prisma/client";
import {
  buildTaxonomyLookups,
  resolveRow,
  validateImportRows,
  mergeRowData,
  type BulkImportRow as ParsedRowShape,
} from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";

const OPTION_LABELS = ["A", "B", "C", "D"] as const;

/** Recomputes a run's validRows/invalidRows/warningRows/reviewRequiredCount from its current (non-removed) rows. Call after any edit/removal that changes severity or reviewRequired. */
export async function recomputeRunCounts(runId: string): Promise<void> {
  const rows = await prisma.bulkImportRow.findMany({
    where: { runId, removedFromImport: false },
    select: { severity: true, reviewRequired: true },
  });
  const validRows = rows.filter((r) => r.severity === ImportRowSeverity.VALID).length;
  const invalidRows = rows.filter((r) => r.severity === ImportRowSeverity.ERROR).length;
  const warningRows = rows.filter((r) => r.severity === ImportRowSeverity.WARNING).length;
  const reviewRequiredCount = rows.filter((r) => r.reviewRequired).length;
  await prisma.bulkImportRun.update({
    where: { id: runId },
    data: { validRows, invalidRows, warningRows, reviewRequiredCount },
  });
}

export interface ExecuteImportOptions {
  runId: string;
  adminUserId: string;
  /** Restrict to these persisted row ids (used by "Import Valid Only" and similar scoped actions). Omit to process every non-removed row. */
  rowIds?: string[];
  /** When true, only rows that resolve to VALID severity are attempted; others are left untouched (not marked FAILED). */
  onlyValid?: boolean;
  /** Mock Test target only: the admin explicitly accepted exceeding the test's expected question count. */
  allowExceedTarget?: boolean;
}

/** Thrown before anything is written when a Mock Test target can't accept this import as-is. */
export class MockTargetError extends Error {
  constructor(
    message: string,
    readonly code: "TARGET_MISSING" | "EXAM_MISMATCH" | "EXCEEDS_EXPECTED",
    readonly details?: Record<string, number>
  ) {
    super(message);
    this.name = "MockTargetError";
  }
}

/**
 * Pre-flight for a run whose target is a Mock Test: the test must still
 * exist and share the run's exam, and — unless the admin explicitly
 * accepted it — the projected total (current questions + rows about to be
 * attempted) must not exceed the test's expected question count. The
 * projection is an upper bound (a SKIP duplicate already in the test adds
 * nothing), so it can only over-warn, never under-warn.
 */
export async function checkMockTarget(
  run: { mockTestId: string | null; examId: string | null },
  scope: { runId: string; rowIds?: string[]; onlyValid?: boolean; allowExceedTarget?: boolean }
) {
  if (!run.mockTestId) return null;
  const mockTest = await prisma.mockTest.findUnique({
    where: { id: run.mockTestId },
    select: { id: true, examId: true, targetQuestionCount: true, _count: { select: { questions: true } } },
  });
  if (!mockTest) throw new MockTargetError("The target Mock Test no longer exists — choose another target.", "TARGET_MISSING");
  if (mockTest.examId !== run.examId) {
    throw new MockTargetError("The target Mock Test belongs to a different exam than this import.", "EXAM_MISMATCH");
  }
  const incoming = await prisma.bulkImportRow.count({
    where: {
      runId: scope.runId,
      removedFromImport: false,
      status: BulkImportRowStatus.PENDING,
      severity: scope.onlyValid ? ImportRowSeverity.VALID : { not: ImportRowSeverity.ERROR },
      ...(scope.rowIds ? { id: { in: scope.rowIds } } : {}),
    },
  });
  const current = mockTest._count.questions;
  const expected = mockTest.targetQuestionCount;
  if (expected !== null && current + incoming > expected && !scope.allowExceedTarget) {
    throw new MockTargetError(
      `This import would take the Mock Test to up to ${current + incoming} questions, above its expected ${expected}. Confirm to exceed, or remove rows.`,
      "EXCEEDS_EXPECTED",
      { current, incoming, expected, projected: current + incoming }
    );
  }
  return mockTest;
}

/**
 * Deterministic reconciliation of a Mock Test run: attachedCount is always
 * recomputed from what actually exists — rows that produced a canonical
 * Question id AND whose Question is assigned to the target test — never
 * from an in-memory tally, so a crash mid-run can't leave it wrong.
 */
export async function reconcileMockAttachment(runId: string): Promise<number> {
  const run = await prisma.bulkImportRun.findUnique({ where: { id: runId }, select: { mockTestId: true } });
  if (!run?.mockTestId) return 0;
  const rows = await prisma.bulkImportRow.findMany({
    where: { runId, questionId: { not: null }, status: { in: [BulkImportRowStatus.SUCCESS, BulkImportRowStatus.SKIPPED, BulkImportRowStatus.REPLACED] } },
    select: { questionId: true },
  });
  const ids = [...new Set(rows.map((r) => r.questionId!))];
  const attachedCount = ids.length === 0 ? 0 : await prisma.mockTestQuestion.count({ where: { mockTestId: run.mockTestId, questionId: { in: ids } } });
  await prisma.bulkImportRun.update({ where: { id: runId }, data: { attachedCount } });
  return attachedCount;
}

export interface ExecuteImportResult {
  runId: string;
  attempted: number;
  successCount: number;
  skippedCount: number;
  replacedCount: number;
  failedCount: number;
  draftCount: number;
  reviewRequiredCount: number;
  status: BulkImportStatus;
  /** Mock Test target only: questions newly assigned by this call. */
  attachedNow: number;
  /** Mock Test target only: reconciled total of this run's questions now in the test. */
  attachedCount: number;
  mockTestId: string | null;
}

/**
 * Shared import-execution core: loads the persisted, non-removed rows of a
 * run (optionally scoped to a rowId subset / valid-only), applies
 * editedData overlays and targetStatus overrides, and runs the existing
 * SKIP/REPLACE/ADD_AS_NEW duplicate-handling logic per row inside
 * per-row transactions. Used by both the final "Import Questions" route and
 * the "Import Valid Only" bulk action so they share identical semantics.
 */
export async function executeBulkImport(options: ExecuteImportOptions): Promise<ExecuteImportResult> {
  const { runId, adminUserId, rowIds, onlyValid, allowExceedTarget } = options;

  const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error("Import run not found");
  // Mock Test target: validated up front, before any row is written.
  const mockTarget = await checkMockTarget(run, { runId, rowIds, onlyValid, allowExceedTarget });

  const rows = await prisma.bulkImportRow.findMany({
    where: {
      runId,
      removedFromImport: false,
      status: BulkImportRowStatus.PENDING,
      ...(rowIds ? { id: { in: rowIds } } : {}),
    },
    orderBy: { rowNumber: "asc" },
  });

  const [lookups, imageIndex] = await Promise.all([buildTaxonomyLookups(prisma), getImageFilenameIndex()]);
  const runExamContext = run.examId ? (lookups.exams.find((e) => e.id === run.examId) ?? null) : null;

  let successCount = 0;
  let skippedCount = 0;
  let replacedCount = 0;
  let failedCount = 0;
  let draftCount = 0;
  let reviewRequiredCount = 0;
  let attachedNow = 0;

  /**
   * Attaches one resolved canonical Question to the target Mock Test inside
   * the row's own transaction, appended after the test's current last slot
   * — rows are processed in rowNumber order, so spreadsheet order becomes
   * test order. Already-assigned questions are left in place (never a
   * duplicate assignment; @@unique([mockTestId, questionId]) backs this),
   * and a question of another exam is refused, which rolls the whole row
   * back rather than leaving a written Question without its assignment.
   */
  const attachInTx = async (tx: Prisma.TransactionClient, questionId: string): Promise<boolean> => {
    if (!mockTarget) return false;
    const question = await tx.question.findUnique({ where: { id: questionId }, select: { examId: true } });
    if (question?.examId !== mockTarget.examId) {
      throw new Error("Resolved question belongs to a different exam than the target Mock Test — not imported or attached.");
    }
    const existing = await tx.mockTestQuestion.findUnique({
      where: { mockTestId_questionId: { mockTestId: mockTarget.id, questionId } },
      select: { id: true },
    });
    if (existing) return false;
    const last = await tx.mockTestQuestion.aggregate({ where: { mockTestId: mockTarget.id }, _max: { order: true } });
    await tx.mockTestQuestion.create({ data: { mockTestId: mockTarget.id, questionId, order: (last._max.order ?? -1) + 1 } });
    return true;
  };

  // Dedups identical questions created earlier IN THIS SAME invocation — the
  // persisted duplicate check only knows about questions that existed before
  // this call started.
  const seenInRun = new Map<string, { id: string; code: string }>();
  const runKey = (examId: string, subjectId: string, text: string) => `${examId}:${subjectId}:${text}`;

  for (const row of rows) {
    const merged = mergeRowData(row.rawData, row.editedData) as ParsedRowShape;
    const [shapeParsed] = validateImportRows([merged]);
    const resolved = await resolveRow(prisma, lookups, shapeParsed, imageIndex, runExamContext);

    if (resolved.severity === ImportRowSeverity.ERROR) {
      if (onlyValid) continue; // leave untouched — user asked for valid rows only
      failedCount++;
      await prisma.bulkImportRow.update({
        where: { id: row.id },
        data: {
          status: BulkImportRowStatus.FAILED,
          severity: resolved.severity,
          errors: resolved.errors as unknown as Prisma.InputJsonValue,
          warnings: resolved.warnings as unknown as Prisma.InputJsonValue,
          errorMessage: resolved.errors.join(", "),
        },
      });
      continue;
    }

    if (onlyValid && resolved.severity !== ImportRowSeverity.VALID) continue;

    const rd = resolved.resolvedData!;

    if (!rd.subjectId) {
      failedCount++;
      await prisma.bulkImportRow.update({
        where: { id: row.id },
        data: {
          status: BulkImportRowStatus.FAILED,
          severity: resolved.severity,
          reviewRequired: true,
          errorMessage: "Subject is not mapped to an existing Subject — edit this row and map it before importing.",
        },
      });
      continue;
    }

    // Effective status: per-row override wins, else the row's own resolved status.
    let effectiveStatus: QuestionStatus = row.targetStatus ?? rd.status;
    let reviewReason: string | null = null;
    if (resolved.reviewRequired) {
      reviewReason = resolved.warnings[0] ?? "Flagged for review during bulk import";
    }

    // A declared-but-missing required image blocks PUBLISHED, not the import itself.
    const missingRequiredImage = resolved.imageMatches?.some((m) => m.status === "MISSING");
    if (missingRequiredImage && effectiveStatus === QuestionStatus.PUBLISHED) {
      effectiveStatus = QuestionStatus.DRAFT;
      reviewReason = reviewReason ?? "Auto-saved as Draft: a referenced image was missing at import time";
    }

    // No valid Correct Answer means no option can be marked correct — never
    // silently Publish a question with no right answer (Section 5), no
    // matter what status the row/admin requested.
    if (resolved.forceDraft) {
      effectiveStatus = QuestionStatus.DRAFT;
      reviewReason = reviewReason ?? "Auto-saved as Draft: no valid Correct Answer was provided";
    }

    // Section 21: when the run itself is scoped to a Previous Year Paper,
    // link every successfully imported question to it (unless the row
    // already resolved a more specific paper of its own).
    const previousYearPaperId = rd.previousYearPaperId ?? run.previousYearPaperId ?? null;
    const source = run.previousYearPaperId && !rd.previousYearPaperId ? QuestionSource.PYQ : rd.source;

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const dedupKey = runKey(rd.examId, rd.subjectId!, merged.questionText);
        const runMatch = seenInRun.get(dedupKey);
        const isDuplicate = rd.isDuplicate || Boolean(runMatch);
        const duplicateQuestionId = runMatch?.id ?? rd.duplicateQuestionId;

        if (isDuplicate && duplicateQuestionId) {
          if (run.duplicateStrategy === BulkImportDuplicateStrategy.SKIP) {
            const existing = await tx.question.findUnique({ where: { id: duplicateQuestionId }, select: { code: true } });
            // SKIP keeps the existing canonical Question — that is the id a
            // Mock Test target receives (no new row, no duplicate content).
            const attached = await attachInTx(tx, duplicateQuestionId);
            seenInRun.set(dedupKey, { id: duplicateQuestionId, code: existing?.code ?? "" });
            return { kind: "SKIPPED" as const, questionId: duplicateQuestionId, questionCode: existing?.code ?? null, attached };
          }
          if (run.duplicateStrategy === BulkImportDuplicateStrategy.REPLACE) {
            const updated = await tx.question.update({
              where: { id: duplicateQuestionId },
              data: {
                examId: rd.examId,
                subjectId: rd.subjectId!,
                topicId: rd.topicId,
                subTopicId: rd.subTopicId,
                previousYearPaperId,
                text: merged.questionText,
                imageUrl: merged.image || null,
                difficulty: rd.difficulty,
                status: effectiveStatus,
                source,
                examYear: rd.examYear,
                importBatchId: runId,
                reviewRequired: resolved.reviewRequired,
                reviewReason,
              },
            });
            await tx.questionOption.deleteMany({ where: { questionId: updated.id } });
            await tx.questionOption.createMany({
              data: OPTION_LABELS.map((label, order) => ({
                questionId: updated.id,
                label,
                text: merged[`option${label}` as keyof ParsedRowShape] as string,
                isCorrect: merged.correctAnswer === label,
                order,
              })),
            });
            const attached = await attachInTx(tx, updated.id);
            seenInRun.set(dedupKey, { id: updated.id, code: updated.code });
            return { kind: "REPLACED" as const, questionId: updated.id, questionCode: updated.code, attached };
          }
          // ADD_AS_NEW falls through to create below.
        }

        const code = await allocateQuestionCode(tx, questionCodeScope(rd.examCode, rd.examYear));
        const created = await tx.question.create({
          data: {
            code,
            examId: rd.examId,
            subjectId: rd.subjectId!,
            topicId: rd.topicId,
            subTopicId: rd.subTopicId,
            previousYearPaperId,
            text: merged.questionText,
            imageUrl: merged.image || null,
            difficulty: rd.difficulty,
            status: effectiveStatus,
            source,
            examYear: rd.examYear,
            importBatchId: runId,
            reviewRequired: resolved.reviewRequired,
            reviewReason,
          },
        });
        await tx.questionOption.createMany({
          data: OPTION_LABELS.map((label, order) => ({
            questionId: created.id,
            label,
            text: merged[`option${label}` as keyof ParsedRowShape] as string,
            isCorrect: merged.correctAnswer === label,
            order,
          })),
        });
        // Attach before remembering the id: if attaching throws, the row's
        // transaction (and its new Question) rolls back, and no later row
        // may reuse an id that was never committed.
        const attached = await attachInTx(tx, created.id);
        seenInRun.set(dedupKey, { id: created.id, code: created.code });
        return { kind: "SUCCESS" as const, questionId: created.id, questionCode: created.code, attached };
      });

      if (outcome.attached) attachedNow++;
      if (outcome.kind === "SUCCESS") successCount++;
      else if (outcome.kind === "SKIPPED") skippedCount++;
      else if (outcome.kind === "REPLACED") replacedCount++;
      if (effectiveStatus === QuestionStatus.DRAFT) draftCount++;
      if (resolved.reviewRequired) reviewRequiredCount++;

      await prisma.bulkImportRow.update({
        where: { id: row.id },
        data: {
          status:
            outcome.kind === "SUCCESS"
              ? BulkImportRowStatus.SUCCESS
              : outcome.kind === "SKIPPED"
                ? BulkImportRowStatus.SKIPPED
                : BulkImportRowStatus.REPLACED,
          severity: resolved.severity,
          questionId: outcome.questionId,
          questionCode: outcome.questionCode,
          errors: resolved.errors as unknown as Prisma.InputJsonValue,
          warnings: resolved.warnings as unknown as Prisma.InputJsonValue,
          errorMessage: null,
          reviewRequired: resolved.reviewRequired,
        },
      });
    } catch (error) {
      // A genuine system/transaction failure for this one row — never let it
      // abort rows that already succeeded (each row commits independently).
      failedCount++;
      await prisma.bulkImportRow.update({
        where: { id: row.id },
        data: {
          status: BulkImportRowStatus.FAILED,
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }
  }

  const remainingPending = await prisma.bulkImportRow.count({
    where: { runId, removedFromImport: false, status: BulkImportRowStatus.PENDING },
  });

  const updatedRun = await prisma.bulkImportRun.update({
    where: { id: runId },
    data: {
      successCount: { increment: successCount },
      skippedCount: { increment: skippedCount },
      replacedCount: { increment: replacedCount },
      failedCount: { increment: failedCount },
      draftCount: { increment: draftCount },
      reviewRequiredCount: { increment: reviewRequiredCount },
      status:
        remainingPending > 0
          ? BulkImportStatus.READY
          : run.failedCount + failedCount > 0
            ? BulkImportStatus.PARTIALLY_IMPORTED
            : BulkImportStatus.IMPORTED,
      completedAt: remainingPending > 0 ? null : new Date(),
    },
  });

  const attachedCount = mockTarget ? await reconcileMockAttachment(runId) : 0;

  await prisma.auditLog.create({
    data: {
      actorId: adminUserId,
      action: onlyValid ? "BULK_IMPORT_VALID_ONLY" : "BULK_IMPORT_COMPLETED",
      entityType: "BulkImportRun",
      entityId: runId,
      metadata: {
        successCount,
        skippedCount,
        replacedCount,
        failedCount,
        draftCount,
        reviewRequiredCount,
        ...(mockTarget ? { mockTestId: mockTarget.id, attachedNow, attachedCount } : {}),
      },
    },
  });

  return {
    attachedNow,
    attachedCount,
    mockTestId: mockTarget?.id ?? null,
    runId,
    attempted: rows.length,
    successCount,
    skippedCount,
    replacedCount,
    failedCount,
    draftCount,
    reviewRequiredCount,
    status: updatedRun.status,
  };
}
