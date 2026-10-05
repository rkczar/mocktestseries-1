import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { BundleError, CHUNK_BYTES, putChunk } from "@/lib/rich-import/bundle";

/** Receives one ≤ 8 MB part of an image bundle. Idempotent per index (safe to retry). */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ bundleId: string; index: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { bundleId, index } = await params;
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > CHUNK_BYTES) return NextResponse.json({ error: "Chunk too large." }, { status: 413 });
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length > CHUNK_BYTES) return NextResponse.json({ error: "Chunk too large." }, { status: 413 });
    const result = await putChunk({ bundleId, actorId: session.user.id!, index: Number(index), bytes });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof BundleError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("PUT bundle chunk error:", error);
    return NextResponse.json({ error: "Failed to store the chunk" }, { status: 500 });
  }
}
