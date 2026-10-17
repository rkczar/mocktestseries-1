import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { completeFile, ImportJobError } from "@/lib/ai-import/jobs";

/** Assembles the chunks, checks the real file type / pages / size, and stores the file in the private vault. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.AI_IMPORTER_USE);
    const { fileId } = await params;
    const result = await completeFile({ fileId, actorId: session.user.id! });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ImportJobError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST ai-importer complete error:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Could not finish the upload." }, { status: 500 });
  }
}
