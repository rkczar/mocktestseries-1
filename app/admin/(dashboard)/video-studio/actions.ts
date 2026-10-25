"use server";

import { revalidatePath } from "next/cache";
import { QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS, type PermissionKey } from "@/lib/permissions";
import { AiNotConfiguredError } from "@/lib/ai-provider";
import { QuoteError } from "@/lib/ai-engine/quote";
import { cancelJob, confirmJob, createJob, requestEstimate, runAutoConfigure, runCleanup, updateConfig, VideoStudioError, type CleanupReport } from "@/lib/video-studio/jobs";
import { saveVideoSettings, type VideoStudioSettings } from "@/lib/video-studio/settings";
import { setApprovedSpeechModels, syncVoiceCatalog, type VoiceCatalog } from "@/lib/video-studio/voices";
import { normalizeSkillKeys } from "@/lib/video-studio/skills";
import { StorageError } from "@/lib/video-studio/storage";
import { AssetError, removeAsset } from "@/lib/video-studio/assets";
import {
  confirmSceneRegen,
  confirmTranscription,
  confirmVoice,
  createEditJob,
  estimateTranscription,
  estimateVoice,
  exportEdit,
  loadJob,
  previewPrice,
  previewVoice,
  processUploads,
  quoteSceneRegen,
  cancelSceneRegenQuote,
  renderSilent,
  rerender,
  resetEdit,
  retryJob,
  saveEdit,
  setMusic,
  setPdfPages,
  updateScene,
  type TranscribePending,
  type VoicePending,
} from "@/lib/video-studio/stages";
import type { QuoteView } from "@/lib/ai-engine/quote";
import type { EditProject } from "@/lib/video-studio/editor-model";

/**
 * Admin → AI Video Studio — Server Actions. Every action re-checks its key
 * server-side: VIDEO_STUDIO_USE (create / configure / confirm / cancel /
 * presets) or VIDEO_STUDIO_MANAGE (settings, voice approvals, cleanup), both
 * MASTER_ADMIN-only. FULL_ADMIN holds only VIDEO_STUDIO_VIEW (read pages).
 * Nothing here starts paid work except confirmVideoJobAction, which consumes
 * the job's one-time cost quote.
 */

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const NOT_ALLOWED = "Only a Master Admin can do this in the AI Video Studio.";

async function guard(permission: PermissionKey): Promise<string | null> {
  try {
    const session = await requirePermission(permission);
    return session.user.id ?? null;
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

async function run<T>(actorId: string | null, fn: (actorId: string) => Promise<T>): Promise<Result<T>> {
  if (!actorId) return { ok: false, error: NOT_ALLOWED };
  try {
    return { ok: true, data: await fn(actorId) };
  } catch (error) {
    if (error instanceof VideoStudioError || error instanceof QuoteError || error instanceof StorageError || error instanceof AssetError) return { ok: false, error: error.message };
    if (error instanceof Error && /^OpenRouter (speech|transcription) failed/.test(error.message)) return { ok: false, error: error.message };
    if (error instanceof AiNotConfiguredError) return { ok: false, error: error.message || "AI is not configured or is paused." };
    console.error("[video-studio]", error instanceof Error ? error.message.slice(0, 200) : "error");
    return { ok: false, error: "Something went wrong. Nothing was changed — try again." };
  }
}

const refresh = (jobId?: string) => {
  revalidatePath("/admin/video-studio");
  if (jobId) revalidatePath(`/admin/video-studio/jobs/${jobId}`);
};

/** `configure: false` = create only (PDF / image sources upload their files first, then Auto Configure). */
export async function createVideoJobAction(input: { source: unknown; customPrompt?: unknown; title?: unknown; designKey?: unknown; configure?: boolean }): Promise<Result<{ id: string }>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    const job = await createJob(input, actorId);
    if (input.configure !== false) await runAutoConfigure(job.id, actorId, { designKey: input.designKey });
    refresh(job.id);
    return { id: job.id };
  });
}

export async function autoConfigureVideoAction(jobId: string, opts: { skillKeys?: unknown; designKey?: unknown; source?: unknown; customPrompt?: unknown } = {}): Promise<Result<null>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    await runAutoConfigure(jobId, actorId, opts);
    refresh(jobId);
    return null;
  });
}

export async function updateVideoConfigAction(jobId: string, patch: unknown): Promise<Result<null>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    await updateConfig(jobId, patch, actorId);
    refresh(jobId);
    return null;
  });
}

export async function requestVideoEstimateAction(jobId: string): Promise<Result<null>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    await requestEstimate(jobId, actorId);
    refresh(jobId);
    return null;
  });
}

export async function confirmVideoJobAction(jobId: string, quoteId: string): Promise<Result<null>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    await confirmJob(jobId, actorId, quoteId);
    refresh(jobId);
    return null;
  });
}

export async function cancelVideoJobAction(jobId: string): Promise<Result<null>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    await cancelJob(jobId, actorId);
    refresh(jobId);
    return null;
  });
}

export interface QuestionHit {
  id: string;
  code: string;
  text: string;
  exam: string;
  subject: string;
  hasAnswer: boolean;
}

/** Published Question Bank search for the Generator's question source (read only, but part of creating a job). */
export async function searchVideoQuestionsAction(input: { examId?: string | null; q?: string }): Promise<Result<QuestionHit[]>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async () => {
    const q = typeof input.q === "string" ? input.q.trim().slice(0, 100) : "";
    const examId = typeof input.examId === "string" && /^[a-z0-9]{20,40}$/.test(input.examId) ? input.examId : undefined;
    const rows = await prisma.question.findMany({
      where: {
        status: QuestionStatus.PUBLISHED,
        parentQuestionId: null,
        ...(examId ? { examId } : {}),
        ...(q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { text: { contains: q, mode: "insensitive" } }] } : {}),
      },
      select: { id: true, code: true, text: true, exam: { select: { name: true } }, subject: { select: { name: true } }, options: { select: { isCorrect: true } } },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    return rows.map((r) => ({ id: r.id, code: r.code, text: r.text.slice(0, 220), exam: r.exam.name, subject: r.subject.name, hasAnswer: r.options.some((o) => o.isCorrect) }));
  });
}

export async function saveSkillPresetAction(input: { id?: string; name: string; skillKeys: string[]; instructions?: string; favorite?: boolean }): Promise<Result<{ id: string }>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 60) : "";
    if (!name) throw new VideoStudioError("Give the preset a name.");
    const skillKeys = normalizeSkillKeys(input.skillKeys, false);
    if (!skillKeys.length) throw new VideoStudioError("Select at least one Skill.");
    const instructions = typeof input.instructions === "string" ? input.instructions.trim().slice(0, 2000) : "";
    const favorite = input.favorite === true;
    if (input.id) {
      const r = await prisma.videoSkillPreset.updateMany({ where: { id: input.id, createdById: actorId }, data: { name, skillKeys, instructions, favorite } });
      if (!r.count) throw new VideoStudioError("Preset not found.");
      refresh();
      return { id: input.id };
    }
    if ((await prisma.videoSkillPreset.count({ where: { createdById: actorId } })) >= 50) throw new VideoStudioError("You already have 50 presets — delete one first.");
    const p = await prisma.videoSkillPreset.create({ data: { name, skillKeys, instructions, favorite, createdById: actorId } });
    revalidatePath("/admin/video-studio/skills");
    return { id: p.id };
  });
}

export async function deleteSkillPresetAction(id: string): Promise<Result<null>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    await prisma.videoSkillPreset.deleteMany({ where: { id, createdById: actorId } });
    revalidatePath("/admin/video-studio/skills");
    return null;
  });
}

export async function syncVoiceCatalogAction(): Promise<Result<VoiceCatalog>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_MANAGE), async () => {
    const c = await syncVoiceCatalog();
    revalidatePath("/admin/video-studio/voices");
    return c;
  });
}

export async function setApprovedSpeechModelsAction(ids: string[]): Promise<Result<VoiceCatalog>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_MANAGE), async () => {
    const c = await setApprovedSpeechModels(Array.isArray(ids) ? ids.filter((i) => typeof i === "string").slice(0, 50) : []);
    revalidatePath("/admin/video-studio/voices");
    return c;
  });
}

export async function saveVideoSettingsAction(input: unknown): Promise<Result<VideoStudioSettings>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_MANAGE), async () => {
    const s = await saveVideoSettings(input);
    revalidatePath("/admin/video-studio/settings");
    return s;
  });
}

export async function runVideoCleanupAction(): Promise<Result<CleanupReport>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_MANAGE), async (actorId) => {
    const r = await runCleanup(actorId);
    refresh();
    return r;
  });
}

// ---- After the script: review, narration, render, retry ----------------------------------------

const act = <A extends unknown[]>(perm: PermissionKey, fn: (actorId: string, ...a: A) => Promise<void>, jobOf: (...a: A) => unknown) =>
  async (...a: A): Promise<Result<null>> =>
    run(await guard(perm), async (actorId) => {
      await fn(actorId, ...a);
      const id = jobOf(...a);
      refresh(typeof id === "string" ? id : undefined);
      return null;
    });

export async function updateSceneAction(jobId: string, sceneId: string, patch: unknown) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string, s: string, p: unknown) => updateScene(j, s, p, actorId), (j) => j)(jobId, sceneId, patch);
}

export async function quoteSceneRegenAction(jobId: string, sceneId: string): Promise<Result<QuoteView>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), (actorId) => quoteSceneRegen(jobId, sceneId, actorId));
}

export async function confirmSceneRegenAction(jobId: string, sceneId: string, quoteId: string, note: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string, s: string, q: string, n: string) => confirmSceneRegen(j, s, q, n, actorId), (j) => j)(jobId, sceneId, quoteId, note);
}

export async function cancelSceneRegenQuoteAction(quoteId: string) {
  return act<[string]>(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, q) => cancelSceneRegenQuote(q, actorId), () => null)(quoteId);
}

export async function estimateVoiceAction(jobId: string, choice: { model?: string; voice?: string } = {}): Promise<Result<VoicePending>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    const r = await estimateVoice(jobId, actorId, choice);
    refresh(jobId);
    return r;
  });
}

export async function confirmVoiceAction(jobId: string, nonce: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string, n: string) => confirmVoice(j, n, actorId), (j) => j)(jobId, nonce);
}

export async function renderSilentAction(jobId: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string) => renderSilent(j, actorId), (j) => j)(jobId);
}

export async function rerenderAction(jobId: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string) => rerender(j, actorId), (j) => j)(jobId);
}

export async function retryVideoJobAction(jobId: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string) => retryJob(j, actorId), (j) => j)(jobId);
}

export async function setMusicAction(jobId: string, key: string | null) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string, k: string | null) => setMusic(j, k, actorId), (j) => j)(jobId, key);
}

export async function setPdfPagesAction(jobId: string, key: string, pages: number[]) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string, k: string, p: number[]) => setPdfPages(j, k, p, actorId), (j) => j)(jobId, key, pages);
}

export async function removeAssetAction(jobId: string, key: string) {
  return act(
    PERMISSIONS.VIDEO_STUDIO_USE,
    async (_actorId, j: string, k: string) => {
      const job = await loadJob(j);
      if (["GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING", "QUEUED"].includes(job.status)) throw new VideoStudioError("Wait until the current step finishes.");
      const project = job.edit as { segments?: { src: string }[]; overlays?: { assetKey?: string }[]; audio?: { musicKey?: string | null }; primary?: string } | null;
      if (project && (project.primary === k || project.segments?.some((s) => s.src === k) || project.overlays?.some((o) => o.assetKey === k) || project.audio?.musicKey === k)) throw new VideoStudioError("This file is used in the edit — remove it from the timeline first.");
      await removeAsset(job.id, k);
    },
    (j) => j
  )(jobId, key);
}

export async function previewPriceAction(input: { model: string; voice: string; text: string }): Promise<Result<{ inr: number | null }>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), () => previewPrice(input));
}

/** Paid (a few paise): only on the admin's explicit click after the price is shown. */
export async function previewVoiceAction(input: { model: string; voice: string; text: string }): Promise<Result<{ audio: string; estInr: number }>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), (actorId) => previewVoice(input, actorId));
}

// ---- AI Video Editor ----------------------------------------------------------------------------

export async function createEditJobAction(title: string): Promise<Result<{ id: string }>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    const job = await createEditJob(title, actorId);
    refresh(job.id);
    return { id: job.id };
  });
}

export async function processUploadsAction(jobId: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string) => processUploads(j, actorId), (j) => j)(jobId);
}

export async function saveEditAction(jobId: string, project: unknown): Promise<Result<EditProject>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    const p = await saveEdit(jobId, project, actorId);
    refresh(jobId);
    return p;
  });
}

export async function resetEditAction(jobId: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string) => resetEdit(j, actorId), (j) => j)(jobId);
}

export async function exportEditAction(jobId: string, project: unknown) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string, p: unknown) => exportEdit(j, p, actorId), (j) => j)(jobId, project);
}

export async function estimateTranscriptionAction(jobId: string, input: { model?: string; language?: string }): Promise<Result<TranscribePending>> {
  return run(await guard(PERMISSIONS.VIDEO_STUDIO_USE), async (actorId) => {
    const r = await estimateTranscription(jobId, input, actorId);
    refresh(jobId);
    return r;
  });
}

export async function confirmTranscriptionAction(jobId: string, nonce: string) {
  return act(PERMISSIONS.VIDEO_STUDIO_USE, (actorId, j: string, n: string) => confirmTranscription(j, n, actorId), (j) => j)(jobId, nonce);
}
