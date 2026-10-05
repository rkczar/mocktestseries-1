import { NextRequest, NextResponse } from "next/server";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { BundleError, bundleSummary, completeBundle } from "@/lib/rich-import/bundle";

/** Assembles the uploaded parts and inspects the archive (no extraction, nothing processed yet). */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ bundleId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.QUESTIONS_MANAGE);
    const { bundleId } = await params;
    const bundle = await completeBundle({ bundleId, actorId: session.user.id! });
    return NextResponse.json(bundleSummary(bundle));
  } catch (error) {
    if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof BundleError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("POST bundle complete error:", error);
    return NextResponse.json({ error: "Failed to finish the image bundle upload" }, { status: 500 });
  }
}
