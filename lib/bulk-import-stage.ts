import "server-only";
import { prisma } from "@/lib/prisma";
import {
  parseImportFile,
  parseJsonText,
  detectImportFileFormat,
  runExamContextFor,
  buildTaxonomyLookups,
  mergeRowData,
  type BulkImportRow,
} from "@/lib/bulk-import";
import { getImageFilenameIndex } from "@/lib/bulk-import-images";
import { readBundleJsonManifest } from "@/lib/rich-import/bundle";
import { loadRichContext, resolveImportRow } from "@/lib/rich-import/validate";
import { JsonImportError } from "@/lib/json-import";
import {
  BulkImportDuplicateStrategy,
  BulkImportMode,
  BulkImportStatus,
  BulkImportRowStatus,
  ImportBundleStatus,
  ImportRowSeverity,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";

/**
 * Bulk Import staging + validation, shared by the Bulk Import API routes
 * (upload / validate) and the AI Question Importer's adapter. Moved out of
 * the two route handlers unchanged: the routes keep request parsing and
 * permission checks and map StageImportError to the same HTTP responses.
 */

export const VALID_STRATEGIES = ["SKIP", "REPLACE", "ADD_AS_NEW"];
/** RICH batches: a full 180-question NEET paper with room to spare; bounded so validation stays fast. */
export const RICH_MAX_ROWS = 500;

/** A refused upload: nothing was written. `status` + `body` are the route's exact HTTP response. */
export class StageImportError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error: string; details?: string[] }
  ) {
    super(body.error);
    this.name = "StageImportError";
  }
}

export interface StageImportInput {
  actorId: string;
  file: File | null;
  label: string | null;
  examId: string | null;
  examYear: number | null;
  previousYearPaperId: string | null;
  mockTestId: string | null;
  importSource: "MOCK_TEST" | "QUESTION_BANK";
  duplicateStrategy: BulkImportDuplicateStrategy;
  importMode: BulkImportMode;
  bundleId: string | null;
  jsonPackage: boolean;
  idempotencyKey: string | null;
}

export interface StageImportResult {
  success: true;
  runId: string;
  filename: string;
  format: string | null;
  total: number;
  parseErrors: string[];
  reused?: true;
}

/**
 * Persists a BulkImportRun + one BulkImportRow per parsed row at UPLOAD
 * time, so the batch has a stable identity and shows up in Import History
 * immediately — before any validation or final import has happened.
 */
export async function stageImportRun(input: StageImportInput): Promise<StageImportResult> {
  const { file, label, examId, examYear, previousYearPaperId, mockTestId, importSource, duplicateStrategy, importMode, bundleId, jsonPackage, idempotencyKey } = input;

  // A retried upload (lost response, double click) returns the run it already created.
  if (idempotencyKey) {
    const previous = await prisma.bulkImportRun.findUnique({ where: { idempotencyKey }, select: { id: true, adminUserId: true, filename: true, format: true, totalRows: true } });
    if (previous) {
      if (previous.adminUserId !== input.actorId) throw new StageImportError(409, { error: "Duplicate upload key." });
      return { success: true, runId: previous.id, filename: previous.filename, format: previous.format, total: previous.totalRows, parseErrors: [], reused: true };
    }
  }

  if (jsonPackage && !bundleId) {
    throw new StageImportError(400, { error: "Upload the JSON package ZIP first." });
  }
  if (!file && !jsonPackage) {
    throw new StageImportError(400, { error: "No file uploaded" });
  }

  if (!examId) {
    throw new StageImportError(400, { error: "Select an Exam before uploading (Section 1: Bulk Import requires an Exam context)." });
  }

  // Validate file size (10MB max)
  const maxSize = 10 * 1024 * 1024;
  if (file && file.size > maxSize) {
    throw new StageImportError(400, { error: "File size exceeds 10MB limit" });
  }

  const format = jsonPackage ? "JSON" : detectImportFileFormat(file!.name);
  if (format === "DOCX") {
    throw new StageImportError(400, { error: "DOCX bulk-import files are not supported yet. Please upload CSV, XLS, or XLSX." });
  }
  if (!format) {
    throw new StageImportError(400, { error: "Unsupported file format. Please upload CSV, XLS, XLSX or JSON files." });
  }
  if (importMode === BulkImportMode.RICH && format === "XLS") {
    throw new StageImportError(400, { error: "Rich imports take the canonical XLSX template (or CSV). Save the workbook as .xlsx." });
  }

  let filename = file?.name ?? "";
  if (bundleId) {
    const bundle = await prisma.importBundle.findUnique({ where: { id: bundleId }, select: { createdById: true, status: true, errorMessage: true, filename: true, run: { select: { id: true } } } });
    if (!bundle || bundle.createdById !== input.actorId) throw new StageImportError(400, { error: "Image bundle not found." });
    if (bundle.run) throw new StageImportError(409, { error: "This image bundle is already attached to another import." });
    if (bundle.status === ImportBundleStatus.FAILED) throw new StageImportError(400, { error: `The image bundle was refused: ${bundle.errorMessage ?? "invalid archive"}` });
    if (bundle.status === ImportBundleStatus.UPLOADING) throw new StageImportError(409, { error: "The image bundle upload is not complete yet." });
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
    throw new StageImportError(400, { error, details: parseErrors });
  }
  if (importMode === BulkImportMode.RICH && rows.length > RICH_MAX_ROWS) {
    throw new StageImportError(400, { error: `A rich import holds at most ${RICH_MAX_ROWS} questions (this file has ${rows.length}). Split it into separate imports.` });
  }

  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
  if (!exam) {
    throw new StageImportError(400, { error: "Selected exam does not exist" });
  }

  if (previousYearPaperId) {
    const paper = await prisma.previousYearPaper.findUnique({ where: { id: previousYearPaperId }, select: { examId: true } });
    if (!paper || paper.examId !== examId) {
      throw new StageImportError(400, { error: "Selected Previous Year Paper does not belong to the selected Exam" });
    }
  }

  if (mockTestId) {
    if (previousYearPaperId) {
      throw new StageImportError(400, { error: "Choose one Import Target — a Previous Year Paper or a Mock Test, not both." });
    }
    const mockTest = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { examId: true } });
    // Server-side guarantee that questions never attach across exams:
    // Question.examId (= the run's exam) must equal MockTest.examId.
    if (!mockTest || mockTest.examId !== examId) {
      throw new StageImportError(400, { error: "Selected Mock Test does not belong to the selected Exam" });
    }
  }

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.bulkImportRun.create({
      data: {
        adminUserId: input.actorId,
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
      actorId: input.actorId,
      action: "BULK_IMPORT_UPLOADED",
      entityType: "BulkImportRun",
      entityId: run.id,
      metadata: { filename, totalRows: rows.length, format, label, examId, examYear, previousYearPaperId, mockTestId, importSource, duplicateStrategy, ...(importMode === BulkImportMode.RICH ? { importMode, bundleId } : {}) },
    },
  });

  return {
    success: true,
    runId: run.id,
    filename,
    format,
    total: rows.length,
    parseErrors,
  };
}

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

export interface ValidateImportResult {
  success: true;
  runId: string;
  total: number;
  valid: number;
  invalid: number;
  warningCount: number;
  duplicates: number;
  reviewRequiredCount: number;
  status: BulkImportStatus;
}

/**
 * Validates every non-removed row of an already-persisted BulkImportRun:
 * re-runs shape validation (honoring any editedData overlay) plus
 * validateWithDatabase's resolution/duplicate logic, persists per-row
 * severity/errors/warnings/reviewRequired, and rolls the run's status +
 * counts forward to READY. Returns null when the run does not exist.
 */
export async function validateImportRun(runId: string): Promise<ValidateImportResult | null> {
  const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
  if (!run) return null;

  await prisma.bulkImportRun.update({ where: { id: runId }, data: { status: BulkImportStatus.VALIDATING } });

  const rows = await prisma.bulkImportRow.findMany({
    where: { runId, removedFromImport: false },
    orderBy: { rowNumber: "asc" },
  });

  const [lookups, imageIndex] = await Promise.all([buildTaxonomyLookups(prisma), getImageFilenameIndex()]);
  const runExamContext = runExamContextFor(lookups.exams, run);
  const richCtx = await loadRichContext(runId);

  let validCount = 0;
  let invalidCount = 0;
  let warningCount = 0;
  let duplicateCount = 0;
  let reviewRequiredCount = 0;

  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const merged = mergeRowData(row.rawData, row.editedData) as BulkImportRow;
    const resolved = await resolveImportRow(prisma, lookups, merged, imageIndex, runExamContext, richCtx);

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
        ...(richCtx ? { infos: (resolved.infos ?? []) as unknown as Prisma.InputJsonValue } : {}),
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

  return {
    success: true,
    runId,
    total: rows.length,
    valid: validCount,
    invalid: invalidCount,
    warningCount,
    duplicates: duplicateCount,
    reviewRequiredCount,
    status: updatedRun.status,
  };
}
