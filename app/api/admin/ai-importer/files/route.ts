import { NextRequest, NextResponse } from "next/server";
import { AiImportFileRole } from "@prisma/client";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { addFile, ImportJobError } from "@/lib/ai-import/jobs";

/** Starts one upload (question paper or answer key) of an AI import job. Returns the chunk plan. */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const body = (await request.json().catch(() => ({}))) as { jobId?: string; name?: string; size?: number; role?: string; paperFileId?: string | null };
    if (!body.jobId || !body.name || typeof body.size !== "number") return NextResponse.json({ error: "jobId, name and size are required." }, { status: 400 });
    const result = await addFile({ jobId: body.jobId, actorId: session.user.id!, name: body.name, size: body.size, role: body.role === "ANSWER_KEY" ? AiImportFileRole.ANSWER_KEY : AiImportFileRole.PAPER, paperFileId: body.paperFileId || null });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST ai-importer file error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not start the upload." }, { status: 500 });
  }
}
