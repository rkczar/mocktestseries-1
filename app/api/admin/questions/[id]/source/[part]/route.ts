import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { readVault } from "@/lib/ai-import/vault";

/**
 * Stored source evidence of a Question Bank question (QuestionSourceEvidence): `q0` / `q1` = original question crop(s),
 * `key` = original answer-key crop. Question Bank editors only; the bytes are the stored genuine crops.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; part: string }> }) {
  try {
    await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { id, part } = await params;
    const src = await prisma.questionSourceEvidence.findUnique({ where: { questionId: id }, select: { questionCrops: true, keyCrop: true } });
    if (!src) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const crops = (Array.isArray(src.questionCrops) ? src.questionCrops : []) as { key?: string }[];
    const key = part === "key" ? (src.keyCrop as { key?: string } | null)?.key : /^q\d$/.test(part) ? crops[Number(part.slice(1))]?.key : undefined;
    if (!key || !key.startsWith("figures/")) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const png = await readVault(key);
    return new NextResponse(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    console.error("GET question source image error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
}
