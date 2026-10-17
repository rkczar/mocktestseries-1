import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { stageImportRun, StageImportError, VALID_STRATEGIES } from "@/lib/bulk-import-stage";
import { BulkImportDuplicateStrategy, BulkImportMode } from "@prisma/client";

/**
 * Persists a BulkImportRun + one BulkImportRow per parsed row at UPLOAD
 * time, so the batch has a stable identity and shows up in Import History
 * immediately — before any validation or final import has happened.
 * The staging itself lives in lib/bulk-import-stage.ts (shared with the
 * AI Question Importer); this route parses the request and checks permissions.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const label = (formData.get("label") as string | null)?.trim() || null;
    const examId = (formData.get("examId") as string | null)?.trim() || null;
    const examYearRaw = (formData.get("examYear") as string | null)?.trim();
    const examYear = examYearRaw && /^\d{4}$/.test(examYearRaw) ? parseInt(examYearRaw, 10) : null;
    const previousYearPaperId = (formData.get("previousYearPaperId") as string | null)?.trim() || null;
    // Optional Mock Test target (Import Target = Mock Test). Attaching
    // questions to a test is a Test Series mutation, so it additionally
    // needs TEST_SERIES_MANAGE — QUESTIONS_MANAGE alone (e.g. TEACHER) can
    // still import to the Question Bank / a Previous Year Paper.
    const mockTestId = (formData.get("mockTestId") as string | null)?.trim() || null;
    const importSource = formData.get("importSource") === "MOCK_TEST" ? "MOCK_TEST" : "QUESTION_BANK";
    if (mockTestId) await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
    const duplicateStrategyRaw = (formData.get("duplicateStrategy") as string | null)?.trim().toUpperCase();
    const duplicateStrategy = (
      duplicateStrategyRaw && VALID_STRATEGIES.includes(duplicateStrategyRaw) ? duplicateStrategyRaw : "SKIP"
    ) as BulkImportDuplicateStrategy;
    // NEET Phase 3: RICH mode is opt-in per upload; anything else is the unchanged LEGACY import.
    const importMode = formData.get("importMode") === "RICH" ? BulkImportMode.RICH : BulkImportMode.LEGACY;
    const bundleId = importMode === BulkImportMode.RICH ? (formData.get("bundleId") as string | null)?.trim() || null : null;
    // JSON package (RICH): one ZIP holding questions.json + its images, uploaded as the image bundle.
    const jsonPackage = importMode === BulkImportMode.RICH && formData.get("jsonPackage") === "1";
    const idempotencyKeyRaw = (formData.get("idempotencyKey") as string | null)?.trim() || null;
    const idempotencyKey = idempotencyKeyRaw && /^[A-Za-z0-9-]{16,64}$/.test(idempotencyKeyRaw) ? idempotencyKeyRaw : null;

    const result = await stageImportRun({
      actorId: session.user.id!,
      file,
      label,
      examId,
      examYear,
      previousYearPaperId,
      mockTestId,
      importSource,
      duplicateStrategy,
      importMode,
      bundleId,
      jsonPackage,
      idempotencyKey,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof StageImportError) return NextResponse.json(error.body, { status: error.status });
    // Two simultaneous submissions with the same key: the loser gets the winner's run.
    if ((error as { code?: string })?.code === "P2002") {
      return NextResponse.json({ error: "This upload was already received — refresh Import History." }, { status: 409 });
    }
    console.error("POST /api/admin/questions/bulk-import/upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process upload" },
      { status: 500 }
    );
  }
}
