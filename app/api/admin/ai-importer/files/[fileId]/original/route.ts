import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { readVault } from "@/lib/ai-import/vault";

/** Original uploaded file from the private vault — admins only, never cached, never public. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.AI_IMPORTER_VIEW);
    const { fileId } = await params;
    const f = await prisma.aiImportFile.findUnique({ where: { id: fileId }, select: { storageKey: true, mime: true, originalName: true, status: true } });
    if (!f?.storageKey || f.status === "PURGED") return NextResponse.json({ error: "Not found" }, { status: 404 });
    const bytes = await readVault(f.storageKey);
    const safeName = f.originalName.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 120) || "paper";
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": f.mime ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${safeName}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
