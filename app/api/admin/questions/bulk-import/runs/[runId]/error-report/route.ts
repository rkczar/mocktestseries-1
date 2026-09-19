import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import Papa from "papaparse";
import { ImportRowSeverity } from "@prisma/client";

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
    console.error("GET /api/admin/questions/bulk-import/runs/[runId]/error-report error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate error report" }, { status: 500 });
  }
}
