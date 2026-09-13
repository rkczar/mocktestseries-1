import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parseImportFile, validateImportRows } from "@/lib/bulk-import";

export async function POST(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    // Validate file size (10MB max)
    const maxSize = 10 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json({ error: "File size exceeds 10MB limit" }, { status: 400 });
    }

    // Parse the file
    const { rows, errors: parseErrors } = await parseImportFile(file);

    if (parseErrors.length > 0 && rows.length === 0) {
      return NextResponse.json({ error: "Failed to parse file", details: parseErrors }, { status: 400 });
    }

    // Validate rows
    const validatedRows = validateImportRows(rows);

    return NextResponse.json({
      success: true,
      filename: file.name,
      total: validatedRows.length,
      valid: validatedRows.filter((r) => r.isValid).length,
      invalid: validatedRows.filter((r) => !r.isValid).length,
      rows: validatedRows,
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
