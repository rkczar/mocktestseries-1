"use server";

import { createHash } from "node:crypto";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";
import { applyImport, type DuplicatePolicy } from "@/lib/questions/applyImport";
import { parseSpreadsheet } from "@/lib/questions/parseSpreadsheet";
import { validateAndClassifyRows, type RowOutcome } from "@/lib/questions/validateRows";
import { storage } from "@/lib/storage";
import { UploadValidationError, validateUpload } from "@/lib/storage/validate";

export type ImportState =
  | undefined
  | { step: "error"; error: string }
  | {
      step: "preview";
      storageKey: string;
      fileName: string;
      fileHash: string;
      examId: string;
      examTitle: string;
      totalRows: number;
      validCount: number;
      duplicateCount: number;
      invalidCount: number;
      invalidSample: { rowNumber: number; errors: string[] }[];
      duplicateSample: { rowNumber: number; matchType: string; stem: string }[];
    };

function summarize(outcomes: RowOutcome[]) {
  const invalid = outcomes.filter((o) => o.kind === "invalid");
  const duplicate = outcomes.filter((o) => o.kind === "duplicate");
  const valid = outcomes.filter((o) => o.kind === "valid");
  return { invalid, duplicate, valid };
}

export async function previewImportAction(
  _prevState: ImportState,
  formData: FormData,
): Promise<ImportState> {
  await requireAdminRole();

  const examId = String(formData.get("examId") ?? "");
  const file = formData.get("file") as File | null;
  if (!examId) return { step: "error", error: "Choose an exam first." };
  if (!file || file.size === 0) return { step: "error", error: "Choose a CSV or XLSX file." };

  try {
    validateUpload("spreadsheet", { name: file.name, type: file.type, size: file.size });
  } catch (error) {
    if (error instanceof UploadValidationError) return { step: "error", error: error.message };
    throw error;
  }

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) return { step: "error", error: "Exam not found." };

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(buffer).digest("hex");

  let rawRows;
  try {
    rawRows = parseSpreadsheet(buffer, file.name);
  } catch {
    return { step: "error", error: "Could not read this file — check it's a valid CSV or XLSX export." };
  }
  if (rawRows.length === 0) return { step: "error", error: "The file has no data rows." };

  const outcomes = await validateAndClassifyRows(rawRows, examId);
  const { invalid, duplicate, valid } = summarize(outcomes);

  const stored = await storage.save({ buffer, originalName: file.name, mimeType: file.type });

  return {
    step: "preview",
    storageKey: stored.key,
    fileName: file.name,
    fileHash,
    examId,
    examTitle: exam.title,
    totalRows: outcomes.length,
    validCount: valid.length,
    duplicateCount: duplicate.length,
    invalidCount: invalid.length,
    invalidSample: invalid.slice(0, 25).map((o) => ({ rowNumber: o.rowNumber, errors: o.errors })),
    duplicateSample: duplicate.slice(0, 25).map((o) => ({
      rowNumber: o.rowNumber,
      matchType: o.matchType,
      stem: o.data.stem.slice(0, 80),
    })),
  };
}

export async function confirmImportAction(
  _prevState: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const session = await requireAdminRole();

  const storageKey = String(formData.get("storageKey") ?? "");
  const fileName = String(formData.get("fileName") ?? "");
  const fileHash = String(formData.get("fileHash") ?? "");
  const examId = String(formData.get("examId") ?? "");
  const duplicatePolicy = String(formData.get("duplicatePolicy") ?? "skip") as DuplicatePolicy;

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam) return { step: "error", error: "Exam not found." };

  const stored = await storage.read(storageKey);
  if (!stored) return { step: "error", error: "The uploaded file has expired — please upload it again." };

  const rawRows = parseSpreadsheet(stored.buffer, fileName);
  const outcomes = await validateAndClassifyRows(rawRows, examId);

  const result = await applyImport({
    examId,
    examSlug: exam.slug,
    outcomes,
    duplicatePolicy,
    adminId: session.user.id,
    fileName,
    fileHash,
  });

  await storage.delete(storageKey);
  updateTag("homepage");

  redirect(
    `/admin/questions?success=${encodeURIComponent(
      `Imported ${result.imported}, replaced ${result.replaced}, added anyway ${result.addedAnyway}, skipped ${result.skipped}, invalid ${result.invalid}`,
    )}`,
  );
}
