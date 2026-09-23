/**
 * Minimal CSV/XLSX parser for the Schedule Manager's bulk upload, using the
 * same papaparse/xlsx libraries as lib/bulk-import.ts (already in
 * package.json) but with its own row shape — the Question bulk-import
 * pipeline's BulkImportRun/BulkImportRow staging tables are a different
 * domain and much larger row-scale, so schedule rows are parsed here
 * directly rather than persisted through that system (see the plan).
 */
import * as XLSX from "xlsx";
import Papa from "papaparse";

export interface RawScheduleRow {
  rowNumber: number;
  testNumber: string;
  title: string;
  availableDate: string;
  availableTime: string;
  durationMinutes: string;
  publish: string;
}

const COLUMN_ALIASES: Record<string, keyof RawScheduleRow> = {
  testnumber: "testNumber",
  "test number": "testNumber",
  testtitle: "title",
  "test title": "title",
  title: "title",
  availabledate: "availableDate",
  "available date": "availableDate",
  availabletime: "availableTime",
  "available time": "availableTime",
  durationminutes: "durationMinutes",
  "duration minutes": "durationMinutes",
  publish: "publish",
}

function normalizeKey(raw: string): keyof RawScheduleRow | null {
  const key = raw.trim().toLowerCase();
  return COLUMN_ALIASES[key] ?? null;
}

function rowFromRecord(record: Record<string, unknown>, rowNumber: number): RawScheduleRow {
  const fields: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(record)) {
    const key = normalizeKey(rawKey);
    if (key) fields[key] = String(value ?? "").trim();
  }
  return {
    rowNumber,
    testNumber: fields.testNumber ?? "",
    title: fields.title ?? "",
    availableDate: fields.availableDate ?? "",
    availableTime: fields.availableTime ?? "",
    durationMinutes: fields.durationMinutes ?? "",
    publish: fields.publish ?? "",
  };
}

export function detectScheduleFileFormat(filename: string): "CSV" | "XLSX" | "XLS" | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) return "CSV";
  if (lower.endsWith(".xlsx")) return "XLSX";
  if (lower.endsWith(".xls")) return "XLS";
  return null;
}

export async function parseScheduleFile(file: File): Promise<{ rows: RawScheduleRow[]; errors: string[] }> {
  const format = detectScheduleFileFormat(file.name);
  if (!format) return { rows: [], errors: ["Unsupported file format. Please upload a CSV, XLS, or XLSX file."] };

  if (format === "CSV") {
    const text = await file.text();
    return new Promise((resolve) => {
      Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const rows = results.data.map((r, i) => rowFromRecord(r, i + 2));
          const errors = results.errors.map((e) => `Row ${e.row}: ${e.message}`);
          resolve({ rows, errors });
        },
        error: (error: Error) => resolve({ rows: [], errors: [`CSV parsing error: ${error.message}`] }),
      });
    });
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return { rows: [], errors: ["No sheets found in the uploaded file."] };
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  return { rows: records.map((r, i) => rowFromRecord(r, i + 2)), errors: [] };
}

/** CSV text for the "Download Schedule Template" link. */
export function buildScheduleTemplateCsv(): string {
  const header = "Test Number,Test Title,Available Date,Available Time,Duration Minutes,Publish";
  const example = "1,Mock Test 01,2026-09-28,10:00,120,TRUE";
  return `${header}\n${example}\n`;
}
