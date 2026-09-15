import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const { runId } = await params;
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100);
    const skip = (page - 1) * limit;
    const status = searchParams.get("status") || undefined;

    const run = await prisma.bulkImportRun.findUnique({
      where: { id: runId },
      include: {
        adminUser: {
          select: { id: true, name: true, username: true },
        },
      },
    });

    if (!run) {
      return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    }

    const where: Prisma.BulkImportRowWhereInput = { runId };
    if (status) {
      where.status = status as Prisma.BulkImportRowWhereInput["status"];
    }

    const [rows, total] = await Promise.all([
      prisma.bulkImportRow.findMany({
        where,
        orderBy: { rowNumber: "asc" },
        skip,
        take: limit,
      }),
      prisma.bulkImportRow.count({ where }),
    ]);

    return NextResponse.json({
      run,
      rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("GET /api/admin/questions/bulk-import/history/[runId] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch import details" },
      { status: 500 }
    );
  }
}
