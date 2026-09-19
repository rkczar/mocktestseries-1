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
import { BulkImportStatus, ImportRowSeverity } from "@prisma/client";
import type { Prisma } from "@prisma/client";

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

/**
 * Validates every non-removed row of an already-persisted BulkImportRun:
 * re-runs shape validation (honoring any editedData overlay) plus
 * validateWithDatabase's resolution/duplicate logic, persists per-row
 * severity/errors/warnings/reviewRequired, and rolls the run's status +
 * counts forward to READY.
 */
export async function POST(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const body = await request.json();
    const { runId } = body as { runId?: string };

    if (!runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }

    const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    await prisma.bulkImportRun.update({ where: { id: runId }, data: { status: BulkImportStatus.VALIDATING } });

    const rows = await prisma.bulkImportRow.findMany({
      where: { runId, removedFromImport: false },
      orderBy: { rowNumber: "asc" },
    });

    const [lookups, imageIndex] = await Promise.all([buildTaxonomyLookups(prisma), getImageFilenameIndex()]);

    let validCount = 0;
    let invalidCount = 0;
    let warningCount = 0;
    let duplicateCount = 0;
    let reviewRequiredCount = 0;

    await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      const merged = mergeRowData(row.rawData, row.editedData) as ParsedRowShape;
      const [shapeParsed] = validateImportRows([merged]);
      const resolved = await resolveRow(prisma, lookups, shapeParsed, imageIndex);

      if (resolved.severity === ImportRowSeverity.ERROR) invalidCount++;
      else validCount++;
      if (resolved.severity === ImportRowSeverity.WARNING) warningCount++;
      if (resolved.resolvedData?.isDuplicate) duplicateCount++;
      if (resolved.reviewRequired) reviewRequiredCount++;

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

    const updatedRun = await prisma.bulkImportRun.update({
      where: { id: runId },
      data: {
        status: BulkImportStatus.READY,
        validRows: validCount,
        invalidRows: invalidCount,
        warningRows: warningCount,
        reviewRequiredCount,
      },
    });

    return NextResponse.json({
      success: true,
      runId,
      total: rows.length,
      valid: validCount,
      invalid: invalidCount,
      warningCount,
      duplicates: duplicateCount,
      reviewRequiredCount,
      status: updatedRun.status,
    });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-import/validate error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to validate rows" },
      { status: 500 }
    );
  }
}
