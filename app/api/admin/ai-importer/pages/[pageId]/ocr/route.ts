import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

/** The page's ORIGINAL OCR reading (as the engine returned it, in reading order) for side-by-side review. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  try {
    await requirePermission(PERMISSIONS.AI_IMPORTER_VIEW);
    const { pageId } = await params;
    const page = await prisma.aiImportPage.findUnique({ where: { id: pageId }, select: { ocrText: true, ocrEngine: true, ocrLines: true } });
    if (!page?.ocrText) return NextResponse.json({ error: "This page has no OCR reading." }, { status: 404 });
    const lines = Array.isArray(page.ocrLines) ? (page.ocrLines as { text?: string; score?: number; reread?: { firstText?: string; firstScore?: number } }[]) : [];
    const uncertain = lines
      .filter((l) => typeof l.score === "number" && l.score < 0.9)
      .map((l) => `${Math.round((l.score ?? 0) * 100)}%  ${l.text ?? ""}${l.reread?.firstText !== undefined ? `   (first reading: ${l.reread.firstText})` : ""}`);
    const body = `${page.ocrEngine ?? "OCR"} — original reading, never corrected\n\n${page.ocrText}${uncertain.length ? `\n\n--- Lines OCR is unsure of ---\n${uncertain.join("\n")}` : ""}\n`;
    return new NextResponse(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET ai-importer page OCR error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
}
