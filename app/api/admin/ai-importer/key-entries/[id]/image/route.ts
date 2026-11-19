import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ensureRender } from "@/lib/ai-import/process";
import { keyEntryCrop } from "@/lib/ai-import/figures";
import { getImporterSettings } from "@/lib/ai-import/settings";

/** Crop of the answer-key page around one key entry's cell (admin review only; 404 when the entry has no stored box). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(PERMISSIONS.AI_IMPORTER_VIEW);
    const { id } = await params;
    const entry = await prisma.aiImportKeyEntry.findUnique({ where: { id }, select: { jobId: true, keyFileId: true, page: true, box: true } });
    if (!entry?.box) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const file = await prisma.aiImportFile.findUnique({ where: { id: entry.keyFileId } });
    if (!file || file.jobId !== entry.jobId || !file.storageKey || file.status === "PURGED") return NextResponse.json({ error: "Not found" }, { status: 404 });
    const kind = (file.detected as { kind?: string } | null)?.kind;
    if (kind !== "pdf" && kind !== "png" && kind !== "jpeg") return NextResponse.json({ error: "This document has no page images." }, { status: 404 });
    const settings = await getImporterSettings();
    const png = await keyEntryCrop(await ensureRender({ id: entry.jobId }, file, entry.page ?? 1, settings.limits.renderDpi), entry.box);
    if (!png) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new NextResponse(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=600", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET ai-importer key entry image error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
}
