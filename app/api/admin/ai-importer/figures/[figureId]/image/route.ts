import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { readVault } from "@/lib/ai-import/vault";

/** Original bytes of an extracted figure (private vault copy) for review. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ figureId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.AI_IMPORTER_VIEW);
    const { figureId } = await params;
    const f = await prisma.aiImportFigure.findUnique({ where: { id: figureId }, select: { originalKey: true, originalMime: true } });
    if (!f?.originalKey) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const bytes = await readVault(f.originalKey);
    const mime = /^image\/(png|jpeg|webp|gif)$/.test(f.originalMime) ? f.originalMime : "application/octet-stream";
    return new NextResponse(new Uint8Array(bytes), { headers: { "content-type": mime, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
