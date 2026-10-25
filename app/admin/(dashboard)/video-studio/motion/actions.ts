"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import { QuoteError, type QuoteView } from "@/lib/ai-engine/quote";
import { cancelJob, VideoStudioError } from "@/lib/video-studio/jobs";
import { AssetError } from "@/lib/video-studio/assets";
import {
  confirmMotionScript,
  confirmMotionVoice,
  createMotionJob,
  estimateMotionVoice,
  loadMotionJob,
  moveMotionFrame,
  renderMotionSilent,
  requestMotionEstimate,
  rerenderMotion,
  retryMotion,
  updateMotionConfig,
  updateMotionFrame,
  planFromScript,
  type MotionInput,
  type MotionVoicePending,
} from "@/lib/video-studio/motion/jobs";

/**
 * Admin → AI Video Studio → Motion Workflow Studio — Server Actions. Every
 * action re-checks VIDEO_STUDIO_USE (MASTER_ADMIN) server-side. Paid work
 * starts only in confirmMotionScriptAction (consumes the one-time quote) and
 * confirmMotionVoiceAction (bound to the shown narration estimate).
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(fn: (actorId: string) => Promise<T>, jobId?: string): Promise<Result<T>> {
  let actorId: string | null = null;
  try {
    actorId = (await requirePermission(PERMISSIONS.VIDEO_STUDIO_USE)).user.id ?? null;
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
  }
  if (!actorId) return { ok: false, error: "Only a Master Admin can do this in the AI Video Studio." };
  try {
    const data = await fn(actorId);
    revalidatePath("/admin/video-studio/motion");
    if (jobId) revalidatePath(`/admin/video-studio/motion/${jobId}`);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof VideoStudioError || error instanceof QuoteError || error instanceof AssetError) return { ok: false, error: error.message };
    if (error instanceof AiNotConfiguredError) return { ok: false, error: error.message || "AI is not configured or is paused." };
    console.error("[motion-studio]", error instanceof Error ? error.message.slice(0, 200) : "error");
    return { ok: false, error: "Something went wrong. Nothing was changed — try again." };
  }
}

const nil = async (p: Promise<void>): Promise<null> => {
  await p;
  return null;
};

export async function createMotionJobAction(input: MotionInput): Promise<Result<{ id: string }>> {
  return run(async (actorId) => ({ id: (await createMotionJob(input, actorId)).id }));
}

export async function updateMotionConfigAction(jobId: string, patch: unknown): Promise<Result<null>> {
  return run((actorId) => nil(updateMotionConfig(jobId, patch, actorId)), jobId);
}

export async function requestMotionEstimateAction(jobId: string): Promise<Result<QuoteView>> {
  return run((actorId) => requestMotionEstimate(jobId, actorId), jobId);
}

export async function confirmMotionScriptAction(jobId: string, quoteId: string): Promise<Result<null>> {
  return run((actorId) => nil(confirmMotionScript(jobId, quoteId, actorId)), jobId);
}

export async function planFromScriptAction(jobId: string, script: string): Promise<Result<null>> {
  return run((actorId) => nil(planFromScript(jobId, script, actorId)), jobId);
}

export async function updateMotionFrameAction(jobId: string, sceneId: string, patch: unknown): Promise<Result<null>> {
  return run((actorId) => nil(updateMotionFrame(jobId, sceneId, patch, actorId)), jobId);
}

export async function moveMotionFrameAction(jobId: string, sceneId: string, dir: "up" | "down" | "delete"): Promise<Result<null>> {
  return run((actorId) => nil(moveMotionFrame(jobId, sceneId, dir, actorId)), jobId);
}

export async function estimateMotionVoiceAction(jobId: string, choice: { model: string; voice: string; sync: "precise" | "estimated" }): Promise<Result<MotionVoicePending>> {
  return run((actorId) => estimateMotionVoice(jobId, choice, actorId), jobId);
}

export async function confirmMotionVoiceAction(jobId: string, nonce: string): Promise<Result<null>> {
  return run((actorId) => nil(confirmMotionVoice(jobId, nonce, actorId)), jobId);
}

export async function renderMotionSilentAction(jobId: string): Promise<Result<null>> {
  return run((actorId) => nil(renderMotionSilent(jobId, actorId)), jobId);
}

export async function rerenderMotionAction(jobId: string): Promise<Result<null>> {
  return run((actorId) => nil(rerenderMotion(jobId, actorId)), jobId);
}

export async function retryMotionAction(jobId: string): Promise<Result<null>> {
  return run((actorId) => nil(retryMotion(jobId, actorId)), jobId);
}

export async function cancelMotionAction(jobId: string): Promise<Result<null>> {
  return run(async (actorId) => {
    await loadMotionJob(jobId);
    await cancelJob(jobId, actorId);
    return null;
  }, jobId);
}
