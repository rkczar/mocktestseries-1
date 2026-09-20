import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  buildTaxonomyLookups,
  resolveRow,
  validateImportRows,
  mergeRowData,
  type BulkImportRow as ParsedRowShape,
} from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";
import { recomputeRunCounts } from "@/lib/bulk-import-execute";
import { QuestionStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";

/**
 * PATCH a single staged row: save inline corrections (editedData), toggle
 * removedFromImport / targetStatus / reviewRequired, and (whenever the data
 * itself changed, or the caller explicitly asks) re-run validation using
 * the exact same rules as the batch validate route.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ rowId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { rowId } = await params;

    const existing = await prisma.bulkImportRow.findUnique({ where: { id: rowId } });
    if (!existing) {
      return NextResponse.json({ error: "Row not found" }, { status: 404 });
    }

    const body = await request.json();
    const {
      editedData,
      removedFromImport,
      targetStatus,
      reviewRequired: explicitReviewRequired,
      revalidate,
    } = body as {
      editedData?: Partial<ParsedRowShape>;
      removedFromImport?: boolean;
      targetStatus?: QuestionStatus | null;
      reviewRequired?: boolean;
      revalidate?: boolean;
    };

    const updateData: Prisma.BulkImportRowUpdateInput = {};
    if (editedData !== undefined) {
      updateData.editedData = { ...((existing.editedData as object | null) ?? {}), ...editedData } as unknown as Prisma.InputJsonValue;
    }
    if (removedFromImport !== undefined) updateData.removedFromImport = removedFromImport;
    if (targetStatus !== undefined) updateData.targetStatus = targetStatus;

    let saved = await prisma.bulkImportRow.update({ where: { id: rowId }, data: updateData });

    const shouldRevalidate = editedData !== undefined || revalidate === true;
    if (shouldRevalidate) {
      const merged = mergeRowData(saved.rawData, saved.editedData) as ParsedRowShape;
      const [shapeParsed] = validateImportRows([merged]);
      const [lookups, imageIndex, run] = await Promise.all([
        buildTaxonomyLookups(prisma),
        getImageFilenameIndex(),
        prisma.bulkImportRun.findUnique({ where: { id: existing.runId }, select: { examId: true } }),
      ]);
      const runExamContext = run?.examId ? (lookups.exams.find((e) => e.id === run.examId) ?? null) : null;
      const resolved = await resolveRow(prisma, lookups, shapeParsed, imageIndex, runExamContext);

      const finalReviewRequired = explicitReviewRequired !== undefined ? explicitReviewRequired || resolved.reviewRequired : resolved.reviewRequired;

      saved = await prisma.bulkImportRow.update({
        where: { id: rowId },
        data: {
          severity: resolved.severity,
          errors: resolved.errors as unknown as Prisma.InputJsonValue,
          warnings: resolved.warnings as unknown as Prisma.InputJsonValue,
          errorMessage: resolved.errors.length > 0 ? resolved.errors.join(", ") : null,
          reviewRequired: finalReviewRequired,
        },
      });
    } else if (explicitReviewRequired !== undefined) {
      saved = await prisma.bulkImportRow.update({ where: { id: rowId }, data: { reviewRequired: explicitReviewRequired } });
    }

    await recomputeRunCounts(existing.runId);

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "BULK_IMPORT_ROW_EDITED",
        entityType: "BulkImportRow",
        entityId: rowId,
        metadata: { runId: existing.runId, rowNumber: existing.rowNumber, fieldsChanged: Object.keys(body) },
      },
    });

    return NextResponse.json({
      success: true,
      row: {
        id: saved.id,
        rowNumber: saved.rowNumber,
        status: saved.status,
        severity: saved.severity,
        errors: saved.errors ?? [],
        warnings: saved.warnings ?? [],
        rawData: saved.rawData,
        editedData: saved.editedData,
        removedFromImport: saved.removedFromImport,
        reviewRequired: saved.reviewRequired,
        targetStatus: saved.targetStatus,
      },
    });
  } catch (error) {
    console.error("PATCH /api/admin/questions/bulk-import/rows/[rowId] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to update row" }, { status: 500 });
  }
}
