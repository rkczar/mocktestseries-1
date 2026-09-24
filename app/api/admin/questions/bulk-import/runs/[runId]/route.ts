import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  mergeRowData,
  declaredImageFilenames,
  matchRowImagesSync,
  buildTaxonomyLookups,
  resolveRow,
  validateImportRows,
  type BulkImportRow as ParsedRowShape,
  type RunExamContext,
} from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";
import { recomputeRunCounts } from "@/lib/bulk-import-execute";
import { ImportRowSeverity, QuestionStatus, type BulkImportDuplicateStrategy, type Prisma } from "@prisma/client";

const CONCURRENCY = 15;
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type RowFilter = "all" | "valid" | "warning" | "error" | "hasImage" | "missingImage" | "reviewRequired" | "removed";

/**
 * GET run detail + a server-side-paginated, filtered slice of its rows, plus
 * a summary computed over the whole (non-removed) row set for the Import
 * Summary panel. Rows are never all sent to the client at once for large
 * runs — filtering/pagination both happen here.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { runId } = await params;

    const run = await prisma.bulkImportRun.findUnique({
      where: { id: runId },
      include: {
        adminUser: { select: { name: true, username: true } },
        exam: { select: { id: true, name: true } },
        previousYearPaper: { select: { id: true, title: true } },
        mockTest: {
          select: {
            id: true,
            title: true,
            order: true,
            status: true,
            availableFrom: true,
            availableUntil: true,
            targetQuestionCount: true,
            testSeries: { select: { name: true } },
            _count: { select: { questions: true } },
          },
        },
      },
    });
    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const pageSizeParam = searchParams.get("pageSize");
    const showAll = pageSizeParam === "all";
    const page = showAll ? 1 : Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = showAll ? 0 : Math.min(500, Math.max(1, parseInt(pageSizeParam || "25", 10) || 25));
    const filter = (searchParams.get("filter") || "all") as RowFilter;

    const removedWanted = filter === "removed";
    const allRows = await prisma.bulkImportRow.findMany({
      where: { runId, removedFromImport: removedWanted },
      orderBy: { rowNumber: "asc" },
    });

    const imageIndex = await getImageFilenameIndex();

    const enriched = allRows.map((row) => {
      const merged = mergeRowData(row.rawData, row.editedData) as ParsedRowShape;
      const declared = declaredImageFilenames(merged);
      const imageMatches = matchRowImagesSync(merged, imageIndex);
      const hasImage = declared.length > 0 && imageMatches.every((m) => m.status === "FOUND");
      const missingImage = imageMatches.some((m) => m.status === "MISSING");
      const isDuplicate = ((row.warnings as string[] | null) ?? []).some((w) => w.startsWith("Possible duplicate:"));
      const effectiveStatus: QuestionStatus = row.targetStatus ?? ((merged.status?.toUpperCase() as QuestionStatus) || QuestionStatus.DRAFT);
      return { row, merged, declared, imageMatches, hasImage, missingImage, isDuplicate, effectiveStatus };
    });

    const matchesFilter = (e: (typeof enriched)[number]): boolean => {
      switch (filter) {
        case "valid": return e.row.severity === ImportRowSeverity.VALID;
        case "warning": return e.row.severity === ImportRowSeverity.WARNING;
        case "error": return e.row.severity === ImportRowSeverity.ERROR;
        case "hasImage": return e.hasImage;
        case "missingImage": return e.missingImage;
        case "reviewRequired": return e.row.reviewRequired;
        case "removed": return true; // already filtered at the query level
        case "all":
        default: return true;
      }
    };

    const filtered = enriched.filter(matchesFilter);
    const total = filtered.length;
    const totalPages = showAll ? 1 : Math.max(1, Math.ceil(total / pageSize));
    const pageSlice = showAll ? filtered : filtered.slice((page - 1) * pageSize, page * pageSize);

    // Summary is always computed over the full non-removed set, independent of the active filter/page.
    const summaryBase = removedWanted
      ? (await prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, orderBy: { rowNumber: "asc" } })).map((row) => {
          const merged = mergeRowData(row.rawData, row.editedData) as ParsedRowShape;
          const declared = declaredImageFilenames(merged);
          const imageMatches = matchRowImagesSync(merged, imageIndex);
          const hasImage = declared.length > 0 && imageMatches.every((m) => m.status === "FOUND");
          const missingImage = imageMatches.some((m) => m.status === "MISSING");
          const isDuplicate = ((row.warnings as string[] | null) ?? []).some((w) => w.startsWith("Possible duplicate:"));
          const effectiveStatus: QuestionStatus = row.targetStatus ?? ((merged.status?.toUpperCase() as QuestionStatus) || QuestionStatus.DRAFT);
          return { row, merged, declared, imageMatches, hasImage, missingImage, isDuplicate, effectiveStatus };
        })
      : enriched;

    const strategy: BulkImportDuplicateStrategy = run.duplicateStrategy;
    const summary = summaryBase.reduce(
      (acc, e) => {
        acc.total++;
        if (e.row.severity === ImportRowSeverity.VALID) acc.valid++;
        if (e.row.severity === ImportRowSeverity.WARNING) acc.warnings++;
        if (e.row.severity === ImportRowSeverity.ERROR) acc.errors++;
        if (e.row.reviewRequired) acc.reviewRequired++;
        if (e.declared.length > 0) {
          if (e.missingImage) acc.missingImages++;
          else acc.hasImages++;
        }
        if (e.isDuplicate) {
          acc.duplicates++;
          if (strategy === "REPLACE") acc.updates++;
          else if (strategy === "SKIP") acc.skipped++;
          else if (e.row.severity !== ImportRowSeverity.ERROR) acc.newQuestions++;
        } else if (e.row.severity !== ImportRowSeverity.ERROR) {
          acc.newQuestions++;
        }
        if (e.effectiveStatus === QuestionStatus.DRAFT) acc.drafts++;
        // Mock Test target preview: every still-pending non-error row
        // resolves to a canonical Question id (new, replaced, or the
        // existing duplicate kept by SKIP) and is attached in row order.
        if (e.row.status === "PENDING" && e.row.severity !== ImportRowSeverity.ERROR) acc.toAttach++;
        return acc;
      },
      { total: 0, valid: 0, warnings: 0, errors: 0, duplicates: 0, newQuestions: 0, updates: 0, drafts: 0, skipped: 0, hasImages: 0, missingImages: 0, reviewRequired: 0, toAttach: 0 }
    );

    return NextResponse.json({
      run: {
        id: run.id,
        filename: run.filename,
        format: run.format,
        label: run.label,
        examId: run.examId,
        exam: run.exam,
        examYear: run.examYear,
        previousYearPaperId: run.previousYearPaperId,
        previousYearPaper: run.previousYearPaper,
        importSource: run.importSource,
        attachedCount: run.attachedCount,
        mockTestId: run.mockTestId,
        mockTest: run.mockTest
          ? {
              id: run.mockTest.id,
              title: run.mockTest.title,
              order: run.mockTest.order,
              status: run.mockTest.status,
              seriesName: run.mockTest.testSeries?.name ?? null,
              availableFrom: run.mockTest.availableFrom,
              availableUntil: run.mockTest.availableUntil,
              expected: run.mockTest.targetQuestionCount,
              current: run.mockTest._count.questions,
            }
          : null,
        status: run.status,
        duplicateStrategy: run.duplicateStrategy,
        totalRows: run.totalRows,
        validRows: run.validRows,
        invalidRows: run.invalidRows,
        warningRows: run.warningRows,
        reviewRequiredCount: run.reviewRequiredCount,
        successCount: run.successCount,
        skippedCount: run.skippedCount,
        replacedCount: run.replacedCount,
        failedCount: run.failedCount,
        draftCount: run.draftCount,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        errorMessage: run.errorMessage,
        adminUser: run.adminUser,
      },
      page,
      pageSize: showAll ? total : pageSize,
      total,
      totalPages,
      rows: pageSlice.map(({ row, merged, imageMatches }) => ({
        id: row.id,
        rowNumber: row.rowNumber,
        status: row.status,
        severity: row.severity,
        questionId: row.questionId,
        questionCode: row.questionCode,
        errors: row.errors ?? [],
        warnings: row.warnings ?? [],
        rawData: row.rawData,
        editedData: row.editedData,
        merged,
        removedFromImport: row.removedFromImport,
        reviewRequired: row.reviewRequired,
        targetStatus: row.targetStatus,
        imageMatches,
        updatedAt: row.updatedAt,
      })),
      summary,
    });
  } catch (error) {
    console.error("GET /api/admin/questions/bulk-import/runs/[runId] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load import run" }, { status: 500 });
  }
}

/**
 * PATCH a run's import context — currently just its selected Exam (Section
 * 1: "Allow changing the Exam before final import"). Every non-removed row
 * is re-validated against the new Exam context in the same call, so the
 * workspace never shows stale severities/warnings for the old Exam.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { runId } = await params;

    const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    const body = await request.json();
    const { examId } = body as { examId?: string };
    if (!examId) {
      return NextResponse.json({ error: "examId is required" }, { status: 400 });
    }

    const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
    if (!exam) {
      return NextResponse.json({ error: "Selected exam does not exist" }, { status: 400 });
    }

    // A previously-selected Previous Year Paper that no longer belongs to
    // the new Exam is cleared rather than left dangling on the wrong Exam.
    const previousYearPaperId =
      run.previousYearPaperId &&
      (await prisma.previousYearPaper.findFirst({ where: { id: run.previousYearPaperId, examId }, select: { id: true } }))
        ? run.previousYearPaperId
        : null;

    // Same rule for a Mock Test target: questions never attach across exams,
    // so a target of another exam is dropped (import continues as Question
    // Bank only) — the admin re-picks a target of the new exam if wanted.
    const mockTestId =
      run.mockTestId && (await prisma.mockTest.findFirst({ where: { id: run.mockTestId, examId }, select: { id: true } })) ? run.mockTestId : null;

    await prisma.bulkImportRun.update({ where: { id: runId }, data: { examId, previousYearPaperId, mockTestId } });

    const rows = await prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, orderBy: { rowNumber: "asc" } });
    const [lookups, imageIndex] = await Promise.all([buildTaxonomyLookups(prisma), getImageFilenameIndex()]);
    const runExamContext: RunExamContext | null = lookups.exams.find((e) => e.id === examId) ?? null;

    await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      const merged = mergeRowData(row.rawData, row.editedData) as ParsedRowShape;
      const [shapeParsed] = validateImportRows([merged]);
      const resolved = await resolveRow(prisma, lookups, shapeParsed, imageIndex, runExamContext);
      await prisma.bulkImportRow.update({
        where: { id: row.id },
        data: {
          severity: resolved.severity,
          errors: resolved.errors as unknown as Prisma.InputJsonValue,
          warnings: resolved.warnings as unknown as Prisma.InputJsonValue,
          errorMessage: resolved.errors.length > 0 ? resolved.errors.join(", ") : null,
          reviewRequired: resolved.reviewRequired,
        },
      });
    });

    await recomputeRunCounts(runId);

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "BULK_IMPORT_EXAM_CHANGED",
        entityType: "BulkImportRun",
        entityId: runId,
        metadata: { fromExamId: run.examId, toExamId: examId, rowCount: rows.length, mockTargetCleared: Boolean(run.mockTestId && !mockTestId) },
      },
    });

    return NextResponse.json({ success: true, examId, revalidated: rows.length });
  } catch (error) {
    console.error("PATCH /api/admin/questions/bulk-import/runs/[runId] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to change Exam" }, { status: 500 });
  }
}
