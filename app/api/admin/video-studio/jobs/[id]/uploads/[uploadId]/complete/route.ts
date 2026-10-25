import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { completeUpload } from "@/lib/video-studio/assets";
import { loadJob } from "@/lib/video-studio/stages";
import { addEvent } from "@/lib/video-studio/jobs";
import { videoRouteError } from "@/lib/video-studio/route-errors";

/** Validates the assembled upload (signature, size, image re-encode, PDF page count) and registers it. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; uploadId: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.VIDEO_STUDIO_USE);
    const { id, uploadId } = await params;
    const job = await loadJob(id);
    const asset = await completeUpload({ job, uploadId, actorId: session.user.id! });
    await addEvent(job.id, session.user.id!, "uploaded", `Uploaded ${asset.kind}: ${asset.name} (${(asset.bytes / 1024 / 1024).toFixed(1)} MB).`);
    revalidatePath(`/admin/video-studio/jobs/${job.id}`);
    return NextResponse.json({ ok: true, asset });
  } catch (error) {
    return videoRouteError(error, "Upload failed.");
  }
}
