import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { parseImportFile, parseJsonText, detectImportFileFormat, type BulkImportRow } from "@/lib/bulk-import";
import { readBundleJsonManifest } from "@/lib/rich-import/bundle";
import { JsonImportError } from "@/lib/json-import";
import { BulkImportDuplicateStrategy, BulkImportMode, BulkImportStatus, BulkImportRowStatus, ImportBundleStatus, ImportRowSeverity } from "@prisma/client";
import type { Prisma } from "@prisma/client";

const VALID_STRATEGIES = ["SKIP", "REPLACE", "ADD_AS_NEW"];
/** RICH batches: a full 180-question NEET paper with room to spare; bounded so validation stays fast. */
const RICH_MAX_ROWS = 500;

/**
 * Persists a BulkImportRun + one BulkImportRow per parsed row at UPLOAD
 * time, so the batch has a stable identity and shows up in Import History
 * immediately — before any validation or final import has happened.
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

    // A retried upload (lost response, double click) returns the run it already created.
    if (idempotencyKey) {
      const previous = await prisma.bulkImportRun.findUnique({ where: { idempotencyKey }, select: { id: true, adminUserId: true, filename: true, format: true, totalRows: true } });
      if (previous) {
        if (previous.adminUserId !== session.user.id) return NextResponse.json({ error: "Duplicate upload key." }, { status: 409 });
        return NextResponse.json({ success: true, runId: previous.id, filename: previous.filename, format: previous.format, total: previous.totalRows, parseErrors: [], reused: true });
      }
    }

    if (jsonPackage && !bundleId) {
      return NextResponse.json({ error: "Upload the JSON package ZIP first." }, { status: 400 });
    }
    if (!file && !jsonPackage) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    if (!examId) {
      return NextResponse.json({ error: "Select an Exam before uploading (Section 1: Bulk Import requires an Exam context)." }, { status: 400 });
    }

    // Validate file size (10MB max)
    const maxSize = 10 * 1024 * 1024;
    if (file && file.size > maxSize) {
      return NextResponse.json({ error: "File size exceeds 10MB limit" }, { status: 400 });
    }

    const format = jsonPackage ? "JSON" : detectImportFileFormat(file!.name);
    if (format === "DOCX") {
      return NextResponse.json(
        { error: "DOCX bulk-import files are not supported yet. Please upload CSV, XLS, or XLSX." },
        { status: 400 }
      );
    }
    if (!format) {
      return NextResponse.json({ error: "Unsupported file format. Please upload CSV, XLS, XLSX or JSON files." }, { status: 400 });
    }
    if (importMode === BulkImportMode.RICH && format === "XLS") {
      return NextResponse.json({ error: "Rich imports take the canonical XLSX template (or CSV). Save the workbook as .xlsx." }, { status: 400 });
    }

    let filename = file?.name ?? "";
    if (bundleId) {
      const bundle = await prisma.importBundle.findUnique({ where: { id: bundleId }, select: { createdById: true, status: true, errorMessage: true, filename: true, run: { select: { id: true } } } });
      if (!bundle || bundle.createdById !== session.user.id) return NextResponse.json({ error: "Image bundle not found." }, { status: 400 });
      if (bundle.run) return NextResponse.json({ error: "This image bundle is already attached to another import." }, { status: 409 });
      if (bundle.status === ImportBundleStatus.FAILED) return NextResponse.json({ error: `The image bundle was refused: ${bundle.errorMessage ?? "invalid archive"}` }, { status: 400 });
      if (bundle.status === ImportBundleStatus.UPLOADING) return NextResponse.json({ error: "The image bundle upload is not complete yet." }, { status: 409 });
      if (jsonPackage) filename = bundle.filename;
    }

    // Parse the file
    let parsed: { rows: BulkImportRow[]; errors: string[] };
    try {
      parsed = jsonPackage ? parseJsonText(await readBundleJsonManifest(bundleId!), "RICH") : await parseImportFile(file!, importMode);
    } catch (e) {
      if (!(e instanceof JsonImportError)) throw e;
      parsed = { rows: [], errors: e.problems };
    }
    const { rows, errors: parseErrors } = parsed;

    if (rows.length === 0) {
      // JSON problems are structural and precise ("Question 3 › correct: …") — show them, not a generic line.
      const error = format === "JSON" && parseErrors.length ? `JSON file refused: ${parseErrors.slice(0, 8).join(" · ")}${parseErrors.length > 8 ? ` · …and ${parseErrors.length - 8} more` : ""}` : "Failed to parse file";
      return NextResponse.json({ error, details: parseErrors }, { status: 400 });
    }
    if (importMode === BulkImportMode.RICH && rows.length > RICH_MAX_ROWS) {
      return NextResponse.json({ error: `A rich import holds at most ${RICH_MAX_ROWS} questions (this file has ${rows.length}). Split it into separate imports.` }, { status: 400 });
    }

    const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
    if (!exam) {
      return NextResponse.json({ error: "Selected exam does not exist" }, { status: 400 });
    }

    if (previousYearPaperId) {
      const paper = await prisma.previousYearPaper.findUnique({ where: { id: previousYearPaperId }, select: { examId: true } });
      if (!paper || paper.examId !== examId) {
        return NextResponse.json({ error: "Selected Previous Year Paper does not belong to the selected Exam" }, { status: 400 });
      }
    }

    if (mockTestId) {
      if (previousYearPaperId) {
        return NextResponse.json({ error: "Choose one Import Target — a Previous Year Paper or a Mock Test, not both." }, { status: 400 });
      }
      const mockTest = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { examId: true } });
      // Server-side guarantee that questions never attach across exams:
      // Question.examId (= the run's exam) must equal MockTest.examId.
      if (!mockTest || mockTest.examId !== examId) {
        return NextResponse.json({ error: "Selected Mock Test does not belong to the selected Exam" }, { status: 400 });
      }
    }

    const run = await prisma.$transaction(async (tx) => {
      const created = await tx.bulkImportRun.create({
        data: {
          adminUserId: session.user.id!,
          filename,
          format,
          label,
          examId,
          examYear,
          previousYearPaperId,
          mockTestId,
          importSource: mockTestId ? importSource : "QUESTION_BANK",
          totalRows: rows.length,
          duplicateStrategy,
          status: BulkImportStatus.UPLOADED,
          ...(importMode === BulkImportMode.RICH ? { importMode, bundleId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      });

      await tx.bulkImportRow.createMany({
        data: rows.map((row: BulkImportRow) => ({
          runId: created.id,
          rowNumber: row.rowNumber,
          status: BulkImportRowStatus.PENDING,
          // Safe default until the /validate step runs — see schema comment.
          severity: ImportRowSeverity.ERROR,
          rawData: row as unknown as Prisma.InputJsonValue,
        })),
      });

      return created;
    });

    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "BULK_IMPORT_UPLOADED",
        entityType: "BulkImportRun",
        entityId: run.id,
        metadata: { filename, totalRows: rows.length, format, label, examId, examYear, previousYearPaperId, mockTestId, importSource, duplicateStrategy, ...(importMode === BulkImportMode.RICH ? { importMode, bundleId } : {}) },
      },
    });

    return NextResponse.json({
      success: true,
      runId: run.id,
      filename,
      format,
      total: rows.length,
      parseErrors,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
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
