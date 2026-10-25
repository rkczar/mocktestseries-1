import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { CHUNK_BYTES, putChunk } from "@/lib/video-studio/assets";
import { loadJob } from "@/lib/video-studio/stages";
import { videoRouteError } from "@/lib/video-studio/route-errors";

/** Receives one ≤ 8 MB part of an upload. Idempotent per index (safe to retry). */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; uploadId: string; index: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.VIDEO_STUDIO_USE);
    const { id, uploadId, index } = await params;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > CHUNK_BYTES) return NextResponse.json({ error: "Chunk too large." }, { status: 413 });
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length > CHUNK_BYTES) return NextResponse.json({ error: "Chunk too large." }, { status: 413 });
    const job = await loadJob(id);
    await putChunk({ jobId: job.id, uploadId, actorId: session.user.id!, index: Number(index), bytes });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return videoRouteError(error, "Upload failed.");
  }
}
