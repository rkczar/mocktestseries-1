import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { validateWithDatabase, type ParsedImportRow } from "@/lib/bulk-import";

export async function POST(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const body = await request.json();
    const { rows } = body as { rows: ParsedImportRow[] };

    if (!rows || !Array.isArray(rows)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    // Validate rows against database
    const result = await validateWithDatabase(prisma, rows);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error("POST /api/admin/questions/bulk-import/validate error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to validate rows" },
      { status: 500 }
    );
  }
}
