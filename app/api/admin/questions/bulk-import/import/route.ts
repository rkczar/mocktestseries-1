import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { BulkImportStatus } from "@prisma/client";
import { executeBulkImport, MockTargetError } from "@/lib/bulk-import-execute";

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

    const body = (await request.json()) as { runId?: string; allowExceedTarget?: boolean };
    runId = body.runId;

    if (!runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }

    const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    if (run.mockTestId) await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);

    const result = await executeBulkImport({ runId, adminUserId: session.user.id!, allowExceedTarget: body.allowExceedTarget === true });

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
      mockTestId: result.mockTestId,
      attachedNow: result.attachedNow,
      attachedCount: result.attachedCount,
    });
  } catch (error) {
    // A refused Mock Test target is a pre-flight rejection: nothing was
    // written, so the run must stay READY (not be marked FAILED).
    if (error instanceof MockTargetError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: 409 });
    }
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
