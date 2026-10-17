import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { validateImportRun } from "@/lib/bulk-import-stage";

/**
 * Validates every non-removed row of an already-persisted BulkImportRun:
 * re-runs shape validation (honoring any editedData overlay) plus
 * validateWithDatabase's resolution/duplicate logic, persists per-row
 * severity/errors/warnings/reviewRequired, and rolls the run's status +
 * counts forward to READY. The work itself is validateImportRun
 * (lib/bulk-import-stage.ts), shared with the AI Question Importer.
 */
export async function POST(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const body = await request.json();
    const { runId } = body as { runId?: string };

    if (!runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }

    const result = await validateImportRun(runId);
    if (!result) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("POST /api/admin/questions/bulk-import/validate error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to validate rows" },
      { status: 500 }
    );
  }
}
