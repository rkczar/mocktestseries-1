import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { BulkImportStatus } from "@prisma/client";
import { executeBulkImport } from "@/lib/bulk-import-execute";

/**
 * Final "Import Questions" step: operates on an ALREADY-PERSISTED run+rows
 * (looked up by runId), honoring editedData overlays, removedFromImport
 * skips, and targetStatus overrides. WARNING and VALID rows are attempted;
 * ERROR rows are recorded as FAILED with a clear per-row message rather
 * than silently dropped (a system failure mid-import must not corrupt
 * already-written rows — each row commits in its own transaction).
 */
export async function POST(request: NextRequest) {
  let runId: string | undefined;

  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const body = await request.json();
    runId = (body as { runId?: string }).runId;

    if (!runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }

    const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    const result = await executeBulkImport({ runId, adminUserId: session.user.id! });

    return NextResponse.json({
      success: true,
      runId: result.runId,
      attempted: result.attempted,
      successCount: result.successCount,
      skippedCount: result.skippedCount,
      replacedCount: result.replacedCount,
      failedCount: result.failedCount,
      draftCount: result.draftCount,
      reviewRequiredCount: result.reviewRequiredCount,
      status: result.status,
    });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-import/import error:", error);

    if (runId) {
      await prisma.bulkImportRun
        .update({
          where: { id: runId },
          data: {
            status: BulkImportStatus.FAILED,
            errorMessage: error instanceof Error ? error.message : "Unknown error",
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import questions" },
      { status: 500 }
    );
  }
}
