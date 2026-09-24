import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { parseImportFile, detectImportFileFormat, type BulkImportRow } from "@/lib/bulk-import";
import { BulkImportDuplicateStrategy, BulkImportStatus, BulkImportRowStatus, ImportRowSeverity } from "@prisma/client";
import type { Prisma } from "@prisma/client";

const VALID_STRATEGIES = ["SKIP", "REPLACE", "ADD_AS_NEW"];

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

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    if (!examId) {
      return NextResponse.json({ error: "Select an Exam before uploading (Section 1: Bulk Import requires an Exam context)." }, { status: 400 });
    }

    // Validate file size (10MB max)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json({ error: "File size exceeds 10MB limit" }, { status: 400 });
    }

    const format = detectImportFileFormat(file.name);
    if (format === "DOCX") {
      return NextResponse.json(
        { error: "DOCX bulk-import files are not supported yet. Please upload CSV, XLS, or XLSX." },
        { status: 400 }
      );
    }
    if (!format) {
      return NextResponse.json({ error: "Unsupported file format. Please upload CSV, XLS, or XLSX files." }, { status: 400 });
    }

    // Parse the file
    const { rows, errors: parseErrors } = await parseImportFile(file);

    if (rows.length === 0) {
      return NextResponse.json({ error: "Failed to parse file", details: parseErrors }, { status: 400 });
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
          filename: file.name,
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
        metadata: { filename: file.name, totalRows: rows.length, format, label, examId, examYear, previousYearPaperId, mockTestId, importSource, duplicateStrategy },
      },
    });

    return NextResponse.json({
      success: true,
      runId: run.id,
      filename: file.name,
      format,
      total: rows.length,
      parseErrors,
    });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-import/upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process upload" },
      { status: 500 }
    );
  }
}
