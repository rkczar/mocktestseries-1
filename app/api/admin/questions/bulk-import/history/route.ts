import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 50);
    const skip = (page - 1) * limit;

    const [runs, total] = await Promise.all([
      prisma.bulkImportRun.findMany({
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          adminUser: {
            select: { id: true, name: true, username: true },
          },
          _count: {
            select: { rows: true },
          },
        },
      }),
      prisma.bulkImportRun.count(),
    ]);

    return NextResponse.json({
      runs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("GET /api/admin/questions/bulk-import/history error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch import history" },
      { status: 500 }
    );
  }
}
