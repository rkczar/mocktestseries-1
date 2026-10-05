import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { BundleError, CHUNK_BYTES, createBundle } from "@/lib/rich-import/bundle";

/** Starts a chunked image-bundle (ZIP) upload for a RICH bulk import (NEET Phase 3). */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const body = (await request.json()) as { filename?: unknown; size?: unknown };
    const bundle = await createBundle({ actorId: session.user.id!, filename: String(body.filename ?? ""), declaredBytes: Number(body.size) });
    return NextResponse.json({ bundleId: bundle.id, chunkBytes: CHUNK_BYTES, chunkCount: bundle.chunkCount });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof BundleError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST /api/admin/questions/bulk-import/bundles error:", error);
    return NextResponse.json({ error: "Failed to start the image bundle upload" }, { status: 500 });
  }
}
