import { NextResponse } from "next/server";
import { UnauthorizedError } from "@/lib/rbac";
import { AssetError } from "@/lib/video-studio/assets";
import { VideoStudioError } from "@/lib/video-studio/jobs";
import { StorageError } from "@/lib/video-studio/storage";

/** Error → JSON response for the Video Studio API routes (no internal detail leaks). */
export function videoRouteError(error: unknown, what = "Request failed.") {
  if (error instanceof UnauthorizedError) return NextResponse.json({ error: error.message }, { status: 403 });
  if (error instanceof AssetError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof VideoStudioError || error instanceof StorageError) return NextResponse.json({ error: error.message }, { status: 400 });
  console.error("[video-studio api]", error instanceof Error ? error.message.slice(0, 200) : error);
  return NextResponse.json({ error: what }, { status: 500 });
}
