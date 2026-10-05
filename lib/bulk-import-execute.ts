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
  runExamContextFor,
  buildTaxonomyLookups,
  mergeRowData,
  type BulkImportRow as ParsedRowShape,
} from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";
import { linkSubjectToExam, linkSubTopicToExam, linkTopicToExam } from "@/lib/exam-taxonomy";
import { loadRichContext, resolveImportRow, type RichContext } from "@/lib/rich-import/validate";
import { allImageRefs, composeQuestionText, fallbackAlt, type ManifestQuestion } from "@/lib/rich-import/manifest";
import { discardBundleFiles, verifyEntryMedia } from "@/lib/rich-import/bundle";
import { EditorialStage, QuestionAssetRole, QuestionContentFormat } from "@prisma/client";

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
  /** RICH runs: the admin explicitly reviewed the WARNING rows (required to import them). */
  acknowledgeWarnings?: boolean;
}

/** Refused before anything is written (rich gate, or another import of this run is already running). */
export class ImportBlockedError extends Error {
  constructor(
    message: string,
    readonly code: "ALREADY_RUNNING" | "ROWS_HAVE_ERRORS" | "WARNINGS_UNACKNOWLEDGED" | "IMAGES_PENDING",
    readonly details?: Record<string, number>
  ) {
    super(message);
    this.name = "ImportBlockedError";
  }
}

const EXECUTION_LEASE_MS = 10 * 60_000;

/** A row another transaction already committed: skipped, never re-marked. */
class RowAlreadyClaimed extends Error {}

/** One QuestionAsset per image reference, from media the bundle step already processed (Phase 2 engine). */
interface PreparedAsset {
  role: QuestionAssetRole;
  optionLabel: string | null;
  order: number;
  storageKey: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  alt: string;
  caption: string | null;
}

async function prepareRichAssets(m: ManifestQuestion, ctx: RichContext): Promise<PreparedAsset[]> {
  const out: PreparedAsset[] = [];
  const nextOrder = new Map<string, number>();
  for (const ref of allImageRefs(m)) {
    const entry = (ctx.index.get(ref.filename.toLowerCase()) ?? [])[0];
    if (!entry || !(await verifyEntryMedia(entry))) {
      throw new Error(`${ref.field}: the processed media for "${ref.filename}" is no longer available — re-process the bundle images, then import again.`);
    }
    // List-entry images become QUESTION figures after the stem's own figures.
    const slot = `${ref.role}|${ref.optionLabel ?? ""}`;
    const order = nextOrder.get(slot) ?? 0;
    nextOrder.set(slot, order + 1);
    out.push({
      role: ref.role as QuestionAssetRole,
      optionLabel: ref.role === "OPTION" ? ref.optionLabel : null,
      order,
      storageKey: entry.storageKey!,
      mime: entry.mime ?? "image/webp",
      width: entry.width!,
      height: entry.height!,
      bytes: entry.bytes!,
      sha256: entry.sha256!,
      alt: ref.decorative ? "" : ref.alt && ref.alt.length >= 3 ? ref.alt.slice(0, 500) : fallbackAlt(ref),
      caption: ref.caption,
    });
  }
  return out;
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
  /** RICH runs: QuestionAsset references written by this call. */
  assetCount: number;
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
  const run = await prisma.bulkImportRun.findUnique({ where: { id: options.runId } });
  if (!run) throw new Error("Import run not found");
  // Execution lease: a double click / retry / second tab while this run is
  // importing is refused instead of processing the same PENDING rows twice.
  const leased = await prisma.bulkImportRun.updateMany({
    where: { id: run.id, OR: [{ executingAt: null }, { executingAt: { lt: new Date(Date.now() - EXECUTION_LEASE_MS) } }] },
    data: { executingAt: new Date() },
  });
  if (leased.count === 0) throw new ImportBlockedError("This import is already running (another click or tab). Wait for it to finish, then refresh.", "ALREADY_RUNNING");
  try {
    return await executeLeased(run, options);
  } finally {
    await prisma.bulkImportRun.update({ where: { id: run.id }, data: { executingAt: null } }).catch(() => undefined);
  }
}

async function executeLeased(
  run: NonNullable<Awaited<ReturnType<typeof prisma.bulkImportRun.findUnique>>>,
  options: ExecuteImportOptions
): Promise<ExecuteImportResult> {
  const { runId, adminUserId, rowIds, onlyValid, allowExceedTarget } = options;
  const richCtx = await loadRichContext(runId);
  if (richCtx) await checkRichGate(runId, { rowIds, onlyValid, acknowledgeWarnings: options.acknowledgeWarnings === true });
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
  const runExamContext = runExamContextFor(lookups.exams, run);

  let assetCount = 0;
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
    const resolved = await resolveImportRow(prisma, lookups, merged, imageIndex, runExamContext, richCtx);
    const manifest = richCtx ? resolved.manifest ?? null : null;

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
    if (resolved.forceDraft && !manifest) {
      effectiveStatus = QuestionStatus.DRAFT;
      reviewReason = reviewReason ?? "Auto-saved as Draft: no valid Correct Answer was provided";
    }

    // RICH: import is never publish. Always DRAFT; editorial stage NEEDS_REVIEW
    // when anything needs a human look, else DRAFT — never VERIFIED.
    let rich: { m: ManifestQuestion; assets: PreparedAsset[]; stage: EditorialStage } | null = null;
    if (manifest && richCtx) {
      effectiveStatus = QuestionStatus.DRAFT;
      const authorReason = manifest.review.required ? `Author: ${manifest.review.reason ?? "flagged for review"}` : null;
      const systemReason = resolved.warnings[0] ?? null;
      reviewReason = [authorReason, systemReason].filter(Boolean).join(" · ").slice(0, 1000) || null;
      const stage = manifest.review.required || resolved.warnings.length > 0 || resolved.reviewRequired ? EditorialStage.NEEDS_REVIEW : EditorialStage.DRAFT;
      try {
        rich = { m: manifest, assets: await prepareRichAssets(manifest, richCtx), stage };
      } catch (error) {
        failedCount++;
        await prisma.bulkImportRow.update({
          where: { id: row.id },
          data: { status: BulkImportRowStatus.FAILED, errorMessage: error instanceof Error ? error.message : "Image preparation failed" },
        });
        continue;
      }
    }
    const questionText = rich ? composeQuestionText(rich.m) : merged.questionText;
    const optionText = (label: (typeof OPTION_LABELS)[number]) =>
      rich ? rich.m.options.find((o) => o.label === label)!.text : (merged[`option${label}` as keyof ParsedRowShape] as string);
    const isCorrect = (label: string) => (rich ? rich.m.correct.includes(label) : merged.correctAnswer === label);
    const richFields = rich
      ? {
          contentFormat: rich.m.contentFormat === "RICH_V1" ? QuestionContentFormat.RICH_V1 : QuestionContentFormat.PLAIN,
          explanation: rich.m.explanation,
          editorialStage: rich.stage,
          reviewRequired: rich.stage === EditorialStage.NEEDS_REVIEW,
          reviewReason: rich.stage === EditorialStage.NEEDS_REVIEW ? reviewReason : null,
        }
      : {};
    const writeAssets = async (tx: Prisma.TransactionClient, questionId: string) => {
      if (!rich) return;
      // References only: files are immutable and shared; frozen attempts keep theirs.
      await tx.questionAsset.deleteMany({ where: { questionId } });
      if (rich.assets.length) await tx.questionAsset.createMany({ data: rich.assets.map((a) => ({ ...a, questionId })) });
    };

    // Section 21: when the run itself is scoped to a Previous Year Paper,
    // link every successfully imported question to it (unless the row
    // already resolved a more specific paper of its own).
    // RICH: rd.previousYearPaperId already IS the run target / Paper Code paper (resolveRichRow).
    const previousYearPaperId = rd.previousYearPaperId ?? run.previousYearPaperId ?? null;
    const source = run.previousYearPaperId && !rd.previousYearPaperId ? QuestionSource.PYQ : rd.source;

    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const finishRow = async <T extends { kind: "SUCCESS" | "SKIPPED" | "REPLACED"; questionId: string; questionCode: string | null }>(result: T): Promise<T> => {
          // Per-question run provenance is written in the SAME transaction as
          // the Question itself: a committed Question always has its row
          // (runId, rowNumber, questionId, action), which is what
          // "Delete Questions Created By This Import" relies on.
          await tx.bulkImportRow.update({
            where: { id: row.id },
            data: {
              status:
                result.kind === "SUCCESS"
                  ? BulkImportRowStatus.SUCCESS
                  : result.kind === "SKIPPED"
                    ? BulkImportRowStatus.SKIPPED
                    : BulkImportRowStatus.REPLACED,
              severity: resolved.severity,
              questionId: result.questionId,
              questionCode: result.questionCode,
              errors: resolved.errors as unknown as Prisma.InputJsonValue,
              warnings: resolved.warnings as unknown as Prisma.InputJsonValue,
              errorMessage: null,
              reviewRequired: resolved.reviewRequired,
            },
          });
          return result;
        };
        // A row claimed by a concurrent transaction is skipped, never written twice.
        const claimed = await tx.bulkImportRow.updateMany({ where: { id: row.id, status: BulkImportRowStatus.PENDING }, data: { updatedAt: new Date() } });
        if (claimed.count === 0) throw new RowAlreadyClaimed();
        // Canonical taxonomy: a shared record the exam doesn't link yet is
        // linked (never copied) before a question of this exam uses it.
        const linkTaxonomy = async () => {
          if (rd.subTopicId) await linkSubTopicToExam(tx, rd.examId, rd.subTopicId);
          else if (rd.topicId) await linkTopicToExam(tx, rd.examId, rd.topicId);
          else await linkSubjectToExam(tx, rd.examId, rd.subjectId!);
        };
        const dedupKey = runKey(rd.examId, rd.subjectId!, questionText);
        const runMatch = seenInRun.get(dedupKey);
        const isDuplicate = rd.isDuplicate || Boolean(runMatch);
        const duplicateQuestionId = runMatch?.id ?? rd.duplicateQuestionId;

        if (isDuplicate && duplicateQuestionId) {
          if (run.duplicateStrategy === BulkImportDuplicateStrategy.SKIP) {
            const existing = await tx.question.findUnique({ where: { id: duplicateQuestionId }, select: { code: true } });
            // SKIP keeps the existing canonical Question — that is the id a
            // Mock Test target receives (no new row, no duplicate content).
            const attached = await attachInTx(tx, duplicateQuestionId);
            return finishRow({ kind: "SKIPPED" as const, questionId: duplicateQuestionId, questionCode: existing?.code ?? null, attached });
          }
          if (run.duplicateStrategy === BulkImportDuplicateStrategy.REPLACE) {
            await linkTaxonomy();
            // A Mock Test import only REFERENCES questions: replacing an
            // existing question's content from it never reclassifies the
            // question's canonical ownership (exam / PYQ paper / source /
            // year) — e.g. never unlinks a RUHS 2024 PYQ from its paper.
            const ownership = mockTarget ? {} : { examId: rd.examId, previousYearPaperId, source, examYear: rd.examYear };
            const updated = await tx.question.update({
              where: { id: duplicateQuestionId },
              data: {
                ...ownership,
                subjectId: rd.subjectId!,
                topicId: rd.topicId,
                subTopicId: rd.subTopicId,
                text: questionText,
                imageUrl: rich ? null : merged.image || null,
                difficulty: rd.difficulty,
                status: effectiveStatus,
                importBatchId: runId,
                reviewRequired: resolved.reviewRequired,
                reviewReason,
                ...richFields,
              },
            });
            await tx.questionOption.deleteMany({ where: { questionId: updated.id } });
            await tx.questionOption.createMany({
              data: OPTION_LABELS.map((label, order) => ({
                questionId: updated.id,
                label,
                text: optionText(label),
                isCorrect: isCorrect(label),
                order,
              })),
            });
            await writeAssets(tx, updated.id);
            const attached = await attachInTx(tx, updated.id);
            return finishRow({ kind: "REPLACED" as const, questionId: updated.id, questionCode: updated.code, attached });
          }
          // ADD_AS_NEW falls through to create below.
        }

        await linkTaxonomy();
        const code = await allocateQuestionCode(tx, questionCodeScope(rd.examCode, rd.examYear));
        const created = await tx.question.create({
          data: {
            code,
            examId: rd.examId,
            subjectId: rd.subjectId!,
            topicId: rd.topicId,
            subTopicId: rd.subTopicId,
            previousYearPaperId,
            text: questionText,
            imageUrl: rich ? null : merged.image || null,
            difficulty: rd.difficulty,
            status: effectiveStatus,
            source,
            examYear: rd.examYear,
            importBatchId: runId,
            reviewRequired: resolved.reviewRequired,
            reviewReason,
            ...richFields,
          },
        });
        await tx.questionOption.createMany({
          data: OPTION_LABELS.map((label, order) => ({
            questionId: created.id,
            label,
            text: optionText(label),
            isCorrect: isCorrect(label),
            order,
          })),
        });
        await writeAssets(tx, created.id);
        // The id is only remembered for later rows AFTER this transaction
        // commits (below): if attaching or the provenance write throws, the
        // row (and its new Question) rolls back, and no later row may reuse
        // an id that was never committed.
        const attached = await attachInTx(tx, created.id);
        return finishRow({ kind: "SUCCESS" as const, questionId: created.id, questionCode: created.code, attached });
      });

      seenInRun.set(runKey(rd.examId, rd.subjectId, questionText), { id: outcome.questionId, code: outcome.questionCode ?? "" });
      if (rich && outcome.kind !== "SKIPPED") assetCount += rich.assets.length;
      if (outcome.attached) attachedNow++;
      if (outcome.kind === "SUCCESS") successCount++;
      else if (outcome.kind === "SKIPPED") skippedCount++;
      else if (outcome.kind === "REPLACED") replacedCount++;
      if (effectiveStatus === QuestionStatus.DRAFT) draftCount++;
      if (resolved.reviewRequired) reviewRequiredCount++;

    } catch (error) {
      if (error instanceof RowAlreadyClaimed) continue;
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
      ...(richCtx ? { assetCount: { increment: assetCount }, formatCounts: (await richFormatCounts(runId)) as unknown as Prisma.InputJsonValue } : {}),
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

  // RICH: once nothing is pending, the private staging archive has served its
  // purpose (every referenced image is an immutable MediaObject by now).
  if (richCtx?.bundle && remainingPending === 0) await discardBundleFiles(richCtx.bundle.id).catch(() => undefined);

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
        ...(richCtx ? { importMode: "RICH", assetCount } : {}),
        ...(mockTarget ? { mockTestId: mockTarget.id, attachedNow, attachedCount } : {}),
      },
    },
  });

  return {
    assetCount,
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

/**
 * RICH gate (before anything is written): ERROR rows block "Import Questions"
 * (fix or Remove them — or use the explicit "Import Valid Only"), WARNING rows
 * need an explicit acknowledgement, and every referenced image must be processed.
 */
async function checkRichGate(runId: string, scope: { rowIds?: string[]; onlyValid?: boolean; acknowledgeWarnings: boolean }) {
  const where = { runId, removedFromImport: false, status: BulkImportRowStatus.PENDING, ...(scope.rowIds ? { id: { in: scope.rowIds } } : {}) };
  const [errorRows, warningRows] = await Promise.all([
    prisma.bulkImportRow.count({ where: { ...where, severity: ImportRowSeverity.ERROR } }),
    prisma.bulkImportRow.count({ where: { ...where, severity: ImportRowSeverity.WARNING } }),
  ]);
  if (errorRows > 0 && !scope.onlyValid) {
    throw new ImportBlockedError(`${errorRows} row(s) still have errors. Fix or Remove them (or use "Import Valid Only") — nothing was imported.`, "ROWS_HAVE_ERRORS", { errorRows });
  }
  if (warningRows > 0 && !scope.onlyValid && !scope.acknowledgeWarnings) {
    throw new ImportBlockedError(`${warningRows} row(s) have warnings. Review them and confirm to import — nothing was imported yet.`, "WARNINGS_UNACKNOWLEDGED", { warningRows });
  }
}

/** PLAIN / RICH_V1 / image counts of a RICH run's imported questions (for Import History). */
export async function richFormatCounts(runId: string) {
  const rows = await prisma.bulkImportRow.findMany({
    where: { runId, status: { in: [BulkImportRowStatus.SUCCESS, BulkImportRowStatus.REPLACED] }, questionId: { not: null } },
    select: { questionId: true },
  });
  const ids = rows.map((r) => r.questionId!);
  if (ids.length === 0) return { PLAIN: 0, RICH_V1: 0, withImages: 0, questionImages: 0, optionImages: 0, explanationImages: 0 };
  const [formats, assets] = await Promise.all([
    prisma.question.groupBy({ by: ["contentFormat"], where: { id: { in: ids } }, _count: true }),
    prisma.questionAsset.groupBy({ by: ["role"], where: { questionId: { in: ids } }, _count: true }),
  ]);
  const withImages = await prisma.question.count({ where: { id: { in: ids }, assets: { some: {} } } });
  const fmt = (f: string) => formats.find((x) => x.contentFormat === f)?._count ?? 0;
  const role = (r: string) => assets.find((x) => x.role === r)?._count ?? 0;
  return { PLAIN: fmt("PLAIN"), RICH_V1: fmt("RICH_V1"), withImages, questionImages: role("QUESTION"), optionImages: role("OPTION"), explanationImages: role("EXPLANATION") };
}
