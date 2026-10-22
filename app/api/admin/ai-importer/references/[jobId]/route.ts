import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { ImportJobError } from "@/lib/ai-import/jobs";
import { addReference, REFERENCE_MAX_BYTES } from "@/lib/ai-import/reference";

/** Adds one optional reference paper to an import (multipart field "file"). Read locally; never sent to AI. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const { jobId } = await params;
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > REFERENCE_MAX_BYTES + 64 * 1024) return NextResponse.json({ error: `A reference paper can be at most ${REFERENCE_MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ error: "Choose a reference file." }, { status: 400 });
    const ref = await addReference({ jobId, actorId: session.user.id!, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
    return NextResponse.json({ refId: ref.refId, name: ref.name, questions: ref.questions.length, key: ref.key.length, note: ref.note });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST ai-importer reference error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not add the reference paper." }, { status: 500 });
  }
}
