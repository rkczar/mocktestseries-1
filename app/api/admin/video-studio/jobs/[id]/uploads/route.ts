import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { startUpload } from "@/lib/video-studio/assets";
import { videoRouteError } from "@/lib/video-studio/route-errors";
import { loadJob } from "@/lib/video-studio/stages";

/** Starts one upload (PDF / image / recorded video / music) of a video job. Returns the chunk plan. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.VIDEO_STUDIO_USE);
    const { id } = await params;
    const job = await loadJob(id);
    if (["GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING", "CANCELLED"].includes(job.status) || job.mediaDeletedAt) return NextResponse.json({ error: "Files cannot be added to this job now." }, { status: 409 });
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; size?: unknown };
    return NextResponse.json(await startUpload({ job, actorId: session.user.id!, name: body.name, size: body.size }));
  } catch (error) {
    return videoRouteError(error, "Upload failed.");
  }
}
