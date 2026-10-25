import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { readAssets } from "@/lib/video-studio/assets";
import { loadJob } from "@/lib/video-studio/stages";
import { markDelivered } from "@/lib/video-studio/jobs";
import { resolveJobPath } from "@/lib/video-studio/storage";
import { videoRouteError } from "@/lib/video-studio/route-errors";

const TYPES: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", jpg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };

/**
 * Serves one media file of a video job to an admin (VIDEO_STUDIO_VIEW):
 * only keys the job itself recorded (uploads, previews, thumbnails, narration,
 * the final MP4) — never an arbitrary path. Supports Range requests (video
 * seeking). `?download=1` on the final MP4 marks the job delivered.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requirePermission(PERMISSIONS.VIDEO_STUDIO_VIEW);
    const { id } = await params;
    const job = await loadJob(id);
    if (job.mediaDeletedAt) return NextResponse.json({ error: "Media deleted by the retention policy." }, { status: 410 });
    const key = request.nextUrl.searchParams.get("key") ?? "";
    const allowed = new Set<string>();
    for (const a of readAssets(job)) for (const k of [a.key, a.proxyKey, a.thumbsKey]) if (k) allowed.add(k);
    if (job.outputKey) allowed.add(job.outputKey);
    // Motion Workflow Studio: the one narration take.
    const take = job.kind === "MOTION" ? (job.config as { take?: { key?: unknown } } | null)?.take?.key : null;
    if (typeof take === "string") allowed.add(take);
    for (const s of await prisma.videoScene.findMany({ where: { jobId: job.id, audioKey: { not: null } }, select: { audioKey: true } })) allowed.add(s.audioKey!);
    if (!allowed.has(key)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const file = await resolveJobPath(job.id, key, true);
    const st = await stat(file);
    const ext = key.split(".").pop() ?? "";
    const type = TYPES[ext] ?? "application/octet-stream";
    const download = request.nextUrl.searchParams.get("download") === "1";
    const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
    if (download) {
      const safe = job.title.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "video";
      headers["content-disposition"] = `attachment; filename="video.${ext}"; filename*=UTF-8''${encodeURIComponent(`${safe}.${ext}`)}`;
      if (key === job.outputKey) await markDelivered(job.id, session.user.id!, "download");
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (range && !download) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      if (!range[1]) end = st.size - 1;
      start = Math.max(0, start);
      end = Math.min(st.size - 1, end);
      if (start > end) return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${st.size}` } });
      const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new NextResponse(body, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": String(end - start + 1) } });
    }
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new NextResponse(body, { status: 200, headers: { ...headers, "content-length": String(st.size) } });
  } catch (error) {
    return videoRouteError(error, "Could not read the file.");
  }
}
