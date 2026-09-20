import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  buildTaxonomyLookups,
  resolveRow,
  validateImportRows,
  mergeRowData,
  IMPORT_ROW_EDITABLE_KEYS,
  type BulkImportRow as ParsedRowShape,
  type RunExamContext,
} from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";
import { executeBulkImport, recomputeRunCounts } from "@/lib/bulk-import-execute";
import { QuestionStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";

type ColumnAction = "SET_COLUMN" | "CLEAR_COLUMN" | "IGNORE_COLUMN" | "KEEP_COLUMN";
const COLUMN_ACTIONS: ColumnAction[] = ["SET_COLUMN", "CLEAR_COLUMN", "IGNORE_COLUMN", "KEEP_COLUMN"];

type BulkAction =
  | "IMPORT_VALID_ONLY"
  | "MOVE_TO_DRAFT"
  | "MARK_REVIEW_REQUIRED"
  | "REMOVE_FROM_IMPORT"
  | "REVALIDATE"
  | ColumnAction;
const VALID_ACTIONS: BulkAction[] = [
  "IMPORT_VALID_ONLY",
  "MOVE_TO_DRAFT",
  "MARK_REVIEW_REQUIRED",
  "REMOVE_FROM_IMPORT",
  "REVALIDATE",
  ...COLUMN_ACTIONS,
];

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
 * Applies a column-level edit (SET/CLEAR/IGNORE/KEEP) to every targeted row's
 * `editedData`, then revalidates each row with the same rules as REVALIDATE —
 * so a column bulk-edit always leaves severities/errors/warnings consistent
 * with what a row-by-row edit would have produced.
 */
async function applyColumnEdit(
  runId: string,
  rowIds: string[],
  edit: (existing: Record<string, unknown>) => Record<string, unknown>,
  runExamContext: RunExamContext | null
): Promise<number> {
  const rows = await prisma.bulkImportRow.findMany({ where: { id: { in: rowIds }, runId, removedFromImport: false } });
  const [lookups, imageIndex] = await Promise.all([buildTaxonomyLookups(prisma), getImageFilenameIndex()]);
  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const nextEdited = edit(((row.editedData as Record<string, unknown> | null) ?? {}) as Record<string, unknown>);
    const merged = mergeRowData(row.rawData, nextEdited) as ParsedRowShape;
    const [shapeParsed] = validateImportRows([merged]);
    const resolved = await resolveRow(prisma, lookups, shapeParsed, imageIndex, runExamContext);
    await prisma.bulkImportRow.update({
      where: { id: row.id },
      data: {
        editedData: nextEdited as unknown as Prisma.InputJsonValue,
        severity: resolved.severity,
        errors: resolved.errors as unknown as Prisma.InputJsonValue,
        warnings: resolved.warnings as unknown as Prisma.InputJsonValue,
        errorMessage: resolved.errors.length > 0 ? resolved.errors.join(", ") : null,
        reviewRequired: resolved.reviewRequired,
      },
    });
  });
  await recomputeRunCounts(runId);
  return rows.length;
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
    const { action, rowIds, column, value } = body as {
      action?: BulkAction;
      rowIds?: string[];
      column?: string;
      value?: string;
    };

    if (!action || !VALID_ACTIONS.includes(action)) {
      return NextResponse.json({ error: "Invalid bulk action" }, { status: 400 });
    }

    if (COLUMN_ACTIONS.includes(action as ColumnAction)) {
      if (!column || !IMPORT_ROW_EDITABLE_KEYS.includes(column as keyof ParsedRowShape)) {
        return NextResponse.json({ error: "A valid column is required for this action" }, { status: 400 });
      }
      // Every uploaded column can be ignored (Section 3) — ignoring a column
      // with no safe default just leaves affected rows unable to become a
      // Question until fixed; it never blocks the action itself.
    }

    const targetRowIds =
      rowIds && rowIds.length > 0
        ? rowIds
        : (await prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, select: { id: true } })).map((r) => r.id);

    const runExamContext: RunExamContext | null = run.examId
      ? await prisma.exam.findUnique({ where: { id: run.examId }, select: { id: true, name: true, code: true, year: true } })
      : null;

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
        resultSummary = { affected: rows.length };
        break;
      }
      case "SET_COLUMN": {
        const affected = await applyColumnEdit(runId, targetRowIds, (existing) => ({ ...existing, [column as string]: value ?? "" }), runExamContext);
        resultSummary = { affected };
        break;
      }
      case "CLEAR_COLUMN":
      case "IGNORE_COLUMN": {
        const affected = await applyColumnEdit(runId, targetRowIds, (existing) => ({ ...existing, [column as string]: "" }), runExamContext);
        resultSummary = { affected };
        break;
      }
      case "KEEP_COLUMN": {
        const affected = await applyColumnEdit(
          runId,
          targetRowIds,
          (existing) => {
            const next = { ...existing };
            delete next[column as string];
            return next;
          },
          runExamContext
        );
        resultSummary = { affected };
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
        metadata: { action, rowCount: targetRowIds.length, ...(column ? { column, value } : {}), ...resultSummary },
      },
    });

    return NextResponse.json({ success: true, action, ...resultSummary });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-import/runs/[runId]/bulk-actions error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bulk action failed" }, { status: 500 });
  }
}
