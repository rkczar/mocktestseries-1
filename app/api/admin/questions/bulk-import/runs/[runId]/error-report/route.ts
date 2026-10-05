import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import Papa from "papaparse";
import { ImportRowSeverity } from "@prisma/client";
import { mergeRowData } from "@/lib/bulk-import";
import { allImageRefs, toManifestQuestion } from "@/lib/rich-import/manifest";
import { loadRichContext, unusedBundleImages } from "@/lib/rich-import/validate";

/** Rich messages are "<Field>: <message>"; the field is split out for the report. */
const RICH_FIELDS = /^(Question Text|Question Images|Option [A-D]( Image)?|Correct|Explanation( Images)?|Content Format|Question Type|Code|QNo|Year|Paper Code|Review Required|Status|Duplicate|List I+|List I \/ List II|List entry \w+|Image|Spreadsheet formula[^:]*):\s*/;

function richSuggest(field: string, message: string): string {
  if (/not found in the uploaded image bundle/.test(message)) return "Add the file to the ZIP (exact name) or correct the reference, re-upload the bundle, then Revalidate.";
  if (/ambiguous/.test(message)) return "Rename the images so every file name is unique.";
  if (/not processed yet/.test(message)) return "Click Process Images, then Revalidate.";
  if (/not a valid image|cannot be used/.test(message)) return "Replace the file with a PNG, JPEG, WebP or AVIF image.";
  if (/MULTIPLE_CORRECT ENGINE NOT YET ENABLED/.test(message)) return "Remove this row until multiple-correct scoring is approved.";
  if (/formula/i.test(field) || /Spreadsheet formula/.test(message)) return "Copy the cells and Paste Special → Values.";
  if (/taxonomy|Subject|Topic|Sub-topic/.test(message)) return "Correct the spelling to an existing Subject/Topic/Sub-topic (the importer never creates taxonomy).";
  if (/alt text/.test(message)) return 'Add "file.png :: description" (or ":: decorative").';
  if (field === "Correct") return "Use one letter A–D.";
  return suggestFor(message);
}

/** Best-effort, deterministic suggestions for the most common recurring messages. */
function suggestFor(message: string): string {
  if (/needs mapping/i.test(message)) return "Open Fix Mapping and select the matching existing entry, or edit the row to correct the spelling.";
  if (/not found — can still be saved as Draft/i.test(message)) return "Upload the missing image, or leave as Draft until it is available.";
  if (/will default to DRAFT/i.test(message)) return "No action needed — Status will default to DRAFT.";
  if (/will default to Question Bank/i.test(message)) return "No action needed — Source will default to Question Bank.";
  if (/Possible duplicate/i.test(message)) return "Review the existing question; choose Skip/Replace/Add as New for this duplicate strategy.";
  if (/Exam Year must be a 4-digit year/i.test(message)) return "Correct the Exam Year to a 4-digit value, e.g. 2026.";
  if (/Correct Answer must be A, B, C, or D/i.test(message)) return "Set Correct Answer to one of A, B, C, D.";
  if (/Difficulty must be/i.test(message)) return "Set Difficulty to EASY, MEDIUM, or HARD.";
  if (/is required/i.test(message)) return "Fill in the missing value and revalidate the row.";
  if (/exists but does not belong to/i.test(message)) return "Pick the correct parent (Subject/Topic) for this taxonomy value, or correct the value.";
  return "";
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { runId } = await params;

    const run = await prisma.bulkImportRun.findUnique({ where: { id: runId } });
    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }
    if (run.importMode === "RICH") return richReport(runId);

    const rows = await prisma.bulkImportRow.findMany({
      where: { runId, severity: { in: [ImportRowSeverity.WARNING, ImportRowSeverity.ERROR] } },
      orderBy: { rowNumber: "asc" },
    });

    const csvRows: Record<string, string>[] = [];
    for (const row of rows) {
      const errors = ((row.errors as string[] | null) ?? []);
      const warnings = ((row.warnings as string[] | null) ?? []);
      const messages = errors.length + warnings.length > 0 ? [...errors.map((e) => ({ type: "Error", text: e })), ...warnings.map((w) => ({ type: "Warning", text: w }))] : [{ type: row.severity, text: row.errorMessage ?? "" }];

      for (const m of messages) {
        csvRows.push({
          Row: String(row.rowNumber),
          "Question Code": row.questionCode ?? "",
          Severity: row.severity,
          Error: m.type === "Error" ? m.text : "",
          Warning: m.type === "Warning" ? m.text : "",
          "Suggested Correction": suggestFor(m.text),
        });
      }
    }

    const csv = Papa.unparse(csvRows, { columns: ["Row", "Question Code", "Severity", "Error", "Warning", "Suggested Correction"] });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="bulk-import-${runId}-error-report.csv"`,
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET /api/admin/questions/bulk-import/runs/[runId]/error-report error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate error report" }, { status: 500 });
  }
}

/** RICH runs: one line per message — row, code, field, severity, message, suggested action. No paths, no secrets. */
async function richReport(runId: string) {
  const [rows, ctx] = await Promise.all([
    prisma.bulkImportRow.findMany({ where: { runId, removedFromImport: false }, orderBy: { rowNumber: "asc" } }),
    loadRichContext(runId),
  ]);
  const out: Record<string, string>[] = [];
  const referenced = new Set<string>();
  for (const row of rows) {
    const merged = mergeRowData(row.rawData, row.editedData);
    for (const ref of allImageRefs(toManifestQuestion(merged))) referenced.add(ref.filename.toLowerCase());
    const code = merged.questionCode?.trim() || row.questionCode || "";
    const push = (severity: string, text: string) => {
      const m = text.match(RICH_FIELDS);
      const field = m ? m[1] : "";
      const message = m ? text.slice(m[0].length) : text;
      out.push({ Row: String(row.rowNumber), "Question Code": code, Field: field, Severity: severity, Message: message, "Suggested Action": richSuggest(field, message) });
    };
    for (const e of (row.errors as string[] | null) ?? []) push("ERROR", e);
    for (const w of (row.warnings as string[] | null) ?? []) push("WARNING", w);
    if (row.status === "FAILED" && row.errorMessage && !((row.errors as string[] | null) ?? []).length) push("ERROR", row.errorMessage);
  }
  if (ctx?.bundle?.status === "FAILED") out.push({ Row: "", "Question Code": "", Field: "Image Bundle", Severity: "ERROR", Message: "The image bundle was refused.", "Suggested Action": "Fix the archive and upload it again." });
  if (ctx) for (const name of unusedBundleImages(ctx, referenced)) out.push({ Row: "", "Question Code": "", Field: "Image Bundle", Severity: "WARNING", Message: `"${name}" is in the bundle but no row references it (it was not processed).`, "Suggested Action": "Reference it from a row, or remove it from the ZIP." });
  const csv = Papa.unparse(out, { columns: ["Row", "Question Code", "Field", "Severity", "Message", "Suggested Action"] });
  return new NextResponse(csv, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="rich-import-${runId}-error-report.csv"` },
  });
}
