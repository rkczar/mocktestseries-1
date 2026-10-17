import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ensureRender } from "@/lib/ai-import/process";
import { getImporterSettings } from "@/lib/ai-import/settings";

/** Page image of a source paper for side-by-side review (rendered on first view, cached privately). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.AI_IMPORTER_VIEW);
    const { pageId } = await params;
    const page = await prisma.aiImportPage.findUnique({ where: { id: pageId }, include: { file: true } });
    if (!page || !page.file.storageKey || page.file.status === "PURGED") return NextResponse.json({ error: "Not found" }, { status: 404 });
    const kind = (page.file.detected as { kind?: string } | null)?.kind;
    if (kind !== "pdf" && kind !== "png" && kind !== "jpeg") return NextResponse.json({ error: "This document has no page images." }, { status: 404 });
    const settings = await getImporterSettings();
    const png = await ensureRender({ id: page.jobId }, page.file, page.pageNumber, settings.limits.renderDpi);
    return new NextResponse(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=600", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET ai-importer page image error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
}
