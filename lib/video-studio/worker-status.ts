import "server-only";
import { prisma } from "@/lib/prisma";
import type { CapabilityCheck } from "@/lib/video-studio/types";

/**
 * Render worker heartbeat. The worker (ops/video-worker) writes
 * Setting "video.worker" = { at, version, ffmpeg, chromium } every run; the
 * app never talks to the worker over the network. No heartbeat in the last
 * 10 minutes = rendering is not available (nothing is promised).
 */

export const WORKER_STATUS_KEY = "video.worker";
const FRESH_MS = 10 * 60_000;

export interface WorkerStatus {
  at: string | null;
  version: string | null;
  ffmpeg: string | null;
  chromium: string | null;
  fresh: boolean;
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  const row = await prisma.setting.findUnique({ where: { key: WORKER_STATUS_KEY } });
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const at = typeof v.at === "string" ? v.at : null;
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string).slice(0, 80) : null);
  return { at, version: s("version"), ffmpeg: s("ffmpeg"), chromium: s("chromium"), fresh: at !== null && Date.now() - new Date(at).getTime() < FRESH_MS };
}

export async function renderCapability(): Promise<CapabilityCheck> {
  const w = await getWorkerStatus();
  const label = "Video rendering (MP4)";
  if (w.fresh) return { key: "render", label, status: "ready", provider: `Private render worker (FFmpeg ${w.ffmpeg ?? "?"}, Chromium ${w.chromium ?? "?"})`, detail: "Runs locally (no provider charge); pauses while a Live CBT is running." };
  return {
    key: "render",
    label,
    status: "pending_approval",
    provider: null,
    detail: "The private render worker (Docker: FFmpeg + Chromium, non-root, no network) is not installed yet — it needs the owner's approval of the exact commands. Script and voice can be prepared now; rendering starts once the worker is running.",
  };
}
