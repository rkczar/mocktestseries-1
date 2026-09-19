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
import { executeBulkImport, recomputeRunCounts } from "@/lib/bulk-import-execute";
import { QuestionStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";

type BulkAction = "IMPORT_VALID_ONLY" | "MOVE_TO_DRAFT" | "MARK_REVIEW_REQUIRED" | "REMOVE_FROM_IMPORT" | "REVALIDATE";
const VALID_ACTIONS: BulkAction[] = ["IMPORT_VALID_ONLY", "MOVE_TO_DRAFT", "MARK_REVIEW_REQUIRED", "REMOVE_FROM_IMPORT", "REVALIDATE"];

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
 * Bulk actions toolbar backend. "Remove" always just flags rows
 * (removedFromImport=true) — rows are never hard-deleted.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { runId } = await params;

    const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    const body = await request.json();
    const { action, rowIds } = body as { action?: BulkAction; rowIds?: string[] };

    if (!action || !VALID_ACTIONS.includes(action)) {
      return NextResponse.json({ error: "Invalid bulk action" }, { status: 400 });
    }

    const targetRowIds =
      rowIds && rowIds.length > 0
        ? rowIds
        : (await prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, select: { id: true } })).map((r) => r.id);

    let resultSummary: Record<string, number> = {};

    switch (action) {
      case "REMOVE_FROM_IMPORT": {
        const { count } = await prisma.bulkImportRow.updateMany({
          where: { id: { in: targetRowIds }, runId },
          data: { removedFromImport: true },
        });
        await recomputeRunCounts(runId);
        resultSummary = { affected: count };
        break;
      }
      case "MOVE_TO_DRAFT": {
        const { count } = await prisma.bulkImportRow.updateMany({
          where: { id: { in: targetRowIds }, runId },
          data: { targetStatus: QuestionStatus.DRAFT },
        });
        resultSummary = { affected: count };
        break;
      }
      case "MARK_REVIEW_REQUIRED": {
        const { count } = await prisma.bulkImportRow.updateMany({
          where: { id: { in: targetRowIds }, runId },
          data: { reviewRequired: true },
        });
        await recomputeRunCounts(runId);
        resultSummary = { affected: count };
        break;
      }
      case "REVALIDATE": {
        const rows = await prisma.bulkImportRow.findMany({ where: { id: { in: targetRowIds }, runId, removedFromImport: false } });
        const [lookups, imageIndex] = await Promise.all([buildTaxonomyLookups(prisma), getImageFilenameIndex()]);
        await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
          const merged = mergeRowData(row.rawData, row.editedData) as ParsedRowShape;
          const [shapeParsed] = validateImportRows([merged]);
          const resolved = await resolveRow(prisma, lookups, shapeParsed, imageIndex);
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
        resultSummary = { affected: rows.length };
        break;
      }
      case "IMPORT_VALID_ONLY": {
        const result = await executeBulkImport({ runId, adminUserId: session.user.id!, rowIds: targetRowIds, onlyValid: true });
        resultSummary = {
          affected: result.attempted,
          successCount: result.successCount,
          skippedCount: result.skippedCount,
          replacedCount: result.replacedCount,
          failedCount: result.failedCount,
        };
        break;
      }
    }

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: `BULK_IMPORT_BULK_ACTION_${action}`,
        entityType: "BulkImportRun",
        entityId: runId,
        metadata: { action, rowCount: targetRowIds.length, ...resultSummary },
      },
    });

    return NextResponse.json({ success: true, action, ...resultSummary });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-import/runs/[runId]/bulk-actions error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bulk action failed" }, { status: 500 });
  }
}
