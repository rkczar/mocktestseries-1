import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { ImportJobError } from "@/lib/ai-import/jobs";
import { startReferenceUpload } from "@/lib/ai-import/reference";

/** Starts a chunked reference upload: JSON { jobId, name, size } → { uploadId, chunks, chunkBytes }. */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const body = (await request.json().catch(() => null)) as { jobId?: unknown; name?: unknown; size?: unknown } | null;
    if (!body || typeof body.jobId !== "string" || typeof body.name !== "string" || typeof body.size !== "number") return NextResponse.json({ error: "Send the import, file name and size.", stage: "validation" }, { status: 400 });
    return NextResponse.json(await startReferenceUpload({ jobId: body.jobId, actorId: session.user.id!, name: body.name, size: body.size }));
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message, stage: "validation" }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message, stage: "validation" }, { status: error.status });
    console.error("POST ai-importer reference upload error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not start the reference upload.", stage: "upload" }, { status: 500 });
  }
}
