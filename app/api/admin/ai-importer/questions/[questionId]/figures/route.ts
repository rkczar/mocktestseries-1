import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ImportJobError } from "@/lib/ai-import/jobs";
import { attachUploadedFigure, revalidateQuestions } from "@/lib/ai-import/review";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * An administrator's image for an extracted question (multipart: file, owner STEM|OPTION, optionLabel,
 * replaceFigureId). Replaces a cropped / wrong / missing figure, or adds one the extraction missed. The
 * replaced figure and every original stay in the private vault.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ questionId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const { questionId } = await params;
    const len = Number(request.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES + 64 * 1024) return NextResponse.json({ error: "The image is larger than 10 MB." }, { status: 413 });
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) return NextResponse.json({ error: "Choose an image file." }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "The image is larger than 10 MB." }, { status: 413 });
    const owner = form.get("owner") === "OPTION" ? "OPTION" : "STEM";
    const optionLabel = typeof form.get("optionLabel") === "string" ? String(form.get("optionLabel")).toUpperCase() || null : null;
    const replace = typeof form.get("replaceFigureId") === "string" ? String(form.get("replaceFigureId")) || null : null;
    await attachUploadedFigure({ questionId, actorId: session.user.id!, bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, owner, optionLabel, replaceFigureId: replace });
    const q = await prisma.aiImportQuestion.findUnique({ where: { id: questionId }, select: { jobId: true } });
    if (q) await revalidateQuestions(q.jobId, [questionId]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST ai-importer figure upload error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The image could not be saved. Nothing was changed." }, { status: 500 });
  }
}
