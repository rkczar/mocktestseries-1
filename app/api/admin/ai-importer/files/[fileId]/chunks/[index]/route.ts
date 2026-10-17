import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { CHUNK_BYTES } from "@/lib/ai-import/config";
import { putChunk, ImportJobError } from "@/lib/ai-import/jobs";

/** Receives one ≤ 8 MB part of an upload. Idempotent per index (safe to retry). */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ fileId: string; index: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const { fileId, index } = await params;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > CHUNK_BYTES) return NextResponse.json({ error: "Chunk too large." }, { status: 413 });
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length > CHUNK_BYTES) return NextResponse.json({ error: "Chunk too large." }, { status: 413 });
    await putChunk({ fileId, actorId: session.user.id!, index: Number(index), bytes });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("PUT ai-importer chunk error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Failed to store the chunk." }, { status: 500 });
  }
}
