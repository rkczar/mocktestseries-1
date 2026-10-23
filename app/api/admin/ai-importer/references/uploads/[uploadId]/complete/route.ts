import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { ImportJobError } from "@/lib/ai-import/jobs";
import { completeReferenceUpload } from "@/lib/ai-import/reference";

/** Joins the parts and adds the reference (type detected by content, read locally, never sent to AI). */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ uploadId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const { uploadId } = await params;
    const ref = await completeReferenceUpload({ uploadId, actorId: session.user.id! });
    return NextResponse.json({ ok: true, refId: ref.refId, name: ref.name, kind: ref.kind, pageCount: ref.pageCount, questions: ref.questions.length, key: ref.key.length, note: ref.note });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message, stage: "validation" }, { status: 403 });
    // Refusals here come from the content checks (type, encryption, pages) of the assembled file.
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message, stage: "reading" }, { status: error.status });
    console.error("POST ai-importer reference complete error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "The reference could not be checked or stored on the server.", stage: "reading" }, { status: 500 });
  }
}
