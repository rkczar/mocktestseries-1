import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { bundleSummary } from "@/lib/rich-import/bundle";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ bundleId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { bundleId } = await params;
    const bundle = await prisma.importBundle.findUnique({ where: { id: bundleId } });
    if (!bundle || bundle.createdById !== session.user.id) return NextResponse.json({ error: "Image bundle not found." }, { status: 404 });
    return NextResponse.json(bundleSummary(bundle));
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET bundle error:", error);
    return NextResponse.json({ error: "Failed to load the image bundle" }, { status: 500 });
  }
}
