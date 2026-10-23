import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { CHUNK_BYTES } from "@/lib/ai-import/config";
import { ImportJobError } from "@/lib/ai-import/jobs";
import { putReferenceChunk } from "@/lib/ai-import/reference";

/** Receives one ≤ 8 MB part of a reference upload. Idempotent per index (safe to retry). */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ uploadId: string; index: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const { uploadId, index } = await params;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > CHUNK_BYTES) return NextResponse.json({ error: "Part too large.", stage: "upload" }, { status: 413 });
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length > CHUNK_BYTES) return NextResponse.json({ error: "Part too large.", stage: "upload" }, { status: 413 });
    await putReferenceChunk({ uploadId, actorId: session.user.id!, index: Number(index), bytes });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message, stage: "upload" }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message, stage: "upload" }, { status: error.status });
    console.error("PUT ai-importer reference chunk error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to store the part.", stage: "upload" }, { status: 500 });
  }
}
