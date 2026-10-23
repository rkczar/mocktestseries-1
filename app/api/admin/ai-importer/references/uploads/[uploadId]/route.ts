import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { ImportJobError } from "@/lib/ai-import/jobs";
import { cancelReferenceUpload } from "@/lib/ai-import/reference";

/** Cancels an unfinished reference upload (its parts are deleted; nothing was stored). */
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ uploadId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const { uploadId } = await params;
    await cancelReferenceUpload({ uploadId, actorId: session.user.id! });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("DELETE ai-importer reference upload error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not cancel the reference upload." }, { status: 500 });
  }
}
