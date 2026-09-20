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
        metadata: { filename: file.name, totalRows: rows.length, format, label, examId, examYear, previousYearPaperId, duplicateStrategy },
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
