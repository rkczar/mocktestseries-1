import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { BundleError, processBundleSlice } from "@/lib/rich-import/bundle";
import { referencedFilenames } from "@/lib/rich-import/validate";

/**
 * Processes the next time-bounded slice of a RICH run's referenced bundle
 * images through the media engine. The workspace calls it repeatedly until
 * `done`; any call can be retried (finished images are skipped).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { runId } = await params;
    const run = await prisma.bulkImportRun.findUnique({ where: { id: runId }, select: { importMode: true, bundleId: true, bundle: { select: { createdById: true } } } });
    if (!run) return NextResponse.json({ error: "Import run not found" }, { status: 404 });
    if (run.importMode !== "RICH" || !run.bundleId || !run.bundle) return NextResponse.json({ done: true, pending: 0, processedNow: 0, ready: 0, invalid: 0, status: "NONE" });
    const wanted = await referencedFilenames(runId);
    const result = await processBundleSlice({ bundleId: run.bundleId, actorId: session.user.id!, wanted });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof BundleError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST process-images error:", error);
    return NextResponse.json({ error: "Image processing failed" }, { status: 500 });
  }
}
