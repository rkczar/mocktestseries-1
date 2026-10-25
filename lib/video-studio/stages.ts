import "server-only";
import crypto from "node:crypto";
import { Prisma, type VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { usdToInr } from "@/lib/ai-engine/config";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { budgetUsage } from "@/lib/ai-engine/budget";
import { getEngineConfig, resolveOpenRouterKey } from "@/lib/ai-engine/settings";
import { cancelQuote, consumeQuote, createQuote, type QuoteView } from "@/lib/ai-engine/quote";
import { synthesizeSpeech } from "@/lib/ai-engine/speech";
import { addEvent, assertDiskHeadroom, VideoStudioError } from "@/lib/video-studio/jobs";
import { getVoiceCatalog, speechCostUsd, voicesFor } from "@/lib/video-studio/voices";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { readAssets, type JobAsset } from "@/lib/video-studio/assets";
import { audioHash, type TranscribeConfirmation, type VoiceConfirmation } from "@/lib/video-studio/pipeline";
import { defaultProject, parseEditProject, EditValidationError, type EditAsset, type EditProject } from "@/lib/video-studio/editor-model";
import { kickVideoWorker } from "@/lib/video-studio/kick";
import { JOB_ID } from "@/lib/video-studio/storage";
import { parseScene, type ScriptMaterial } from "@/lib/video-studio/script";
import type { VideoConfig } from "@/lib/video-studio/types";

/**
 * AI Video Studio — what the admin's buttons do after the first confirmation
 * (called from Server Actions; RBAC is checked there). Every PAID step has
 * its own estimate → explicit confirmation:
 *   - narration:      exact character count × the approved model's catalog price,
 *                     bound to the job and the scenes' text (a pending estimate expires in 10 min);
 *   - scene regenerate: a one-time AI Engine quote (video_script, context = job + scene);
 *   - transcription:  recording length × the model's per-second price.
 * Rendering, export and silent renders are local (no provider charge) and
 * start directly. The worker is kicked; nothing long runs in the request.
 */

const PENDING_TTL_MS = 10 * 60_000;

function checkId(id: unknown): string {
  if (typeof id !== "string" || !JOB_ID.test(id)) throw new VideoStudioError("Invalid job id.");
  return id;
}

export async function loadJob(id: unknown): Promise<VideoJob> {
  const job = await prisma.videoJob.findUnique({ where: { id: checkId(id) } });
  if (!job) throw new VideoStudioError("Video job not found.");
  return job;
}

type Estimate = Record<string, unknown> & { voice?: VoiceConfirmation; voicePending?: VoicePending; transcribe?: TranscribeConfirmation; transcribePending?: TranscribePending };

function est(job: VideoJob): Estimate {
  return ((job.estimate as Estimate | null) ?? {}) as Estimate;
}

async function saveEstimate(jobId: string, e: Estimate, extra: Prisma.VideoJobUpdateInput = {}) {
  await prisma.videoJob.update({ where: { id: jobId }, data: { estimate: e as unknown as Prisma.InputJsonValue, lastActivityAt: new Date(), ...extra } });
}

/** Statuses where scenes may be reviewed and edited (nothing is running). */
const SCENE_EDITABLE = ["REVIEW_REQUIRED", "COMPLETED", "FAILED"];

function assertSceneEditable(job: VideoJob) {
  if (job.kind !== "GENERATE") throw new VideoStudioError("Not a generated video.");
  if (!SCENE_EDITABLE.includes(job.status)) throw new VideoStudioError("The script can be changed only while the job is waiting for review (not while something is running).");
  if (job.mediaDeletedAt) throw new VideoStudioError("This job's media were deleted by the retention policy.");
}

// ---- scenes ----------------------------------------------------------------------------------

export async function updateScene(jobId: unknown, sceneId: unknown, patch: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  assertSceneEditable(job);
  const scene = await prisma.videoScene.findFirst({ where: { id: typeof sceneId === "string" ? sceneId : "", jobId: job.id } });
  if (!scene) throw new VideoStudioError("Scene not found.");
  const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  const cfg = job.config as unknown as VideoConfig;
  const material: ScriptMaterial = { topic: "", prompt: "", customInstructions: "", questions: [], documentText: "", assets: readAssets(job).filter((a) => a.kind === "image").map((a) => ({ key: a.key, label: a.name })), attachedImages: 0 };
  const data: Prisma.VideoSceneUpdateInput = {};
  if (typeof p.narration === "string" || typeof p.onScreenText === "string") {
    const d = parseScene({ narration: typeof p.narration === "string" ? p.narration : scene.narration, onScreenText: typeof p.onScreenText === "string" ? p.onScreenText : scene.onScreenText }, cfg, material, [], scene.index + 1);
    if (typeof p.narration === "string") {
      if (!d.narration) throw new VideoStudioError("Narration cannot be empty.");
      if (d.narration !== scene.narration) Object.assign(data, { narration: d.narration, audioKey: null, audioHash: null, audioSec: null, durationSec: d.durationSec });
    }
    if (typeof p.onScreenText === "string") data.onScreenText = d.onScreenText;
  }
  // Visual text edits keep the visual's kind; question scenes keep the Question Bank's stem / options / answer.
  const v = scene.visual as Record<string, unknown> | null;
  if (p.visual && typeof p.visual === "object" && v) {
    const pv = p.visual as Record<string, unknown>;
    if (v.kind === "question") {
      if (typeof pv.revealAtSec === "number" && Number.isFinite(pv.revealAtSec)) v.revealAtSec = Math.min(30, Math.max(0, pv.revealAtSec));
      if (pv.confirmAnswer === true && v.correctLabel) v.revealAtSec = Math.max(1, Number(v.revealAtSec) || 3);
    } else {
      const d = parseScene({ narration: "x", visual: { ...v, ...pv, kind: v.kind } }, cfg, material, [], scene.index + 1);
      if (d.visual) Object.assign(v, d.visual);
    }
    data.visual = v as Prisma.InputJsonValue;
  }
  if (p.reviewed === true) Object.assign(data, { needsReview: false, reviewNote: null });
  await prisma.videoScene.update({ where: { id: scene.id }, data });
  await prisma.videoJob.update({ where: { id: job.id }, data: { status: "REVIEW_REQUIRED", lastActivityAt: new Date() } });
  await addEvent(job.id, actorId, "scene_edited", `Scene ${scene.index + 1} edited${p.reviewed === true ? " and marked as reviewed" : ""}.`);
}

export async function quoteSceneRegen(jobId: unknown, sceneId: unknown, actorId: string): Promise<QuoteView> {
  const job = await loadJob(jobId);
  assertSceneEditable(job);
  const scene = await prisma.videoScene.findFirst({ where: { id: typeof sceneId === "string" ? sceneId : "", jobId: job.id } });
  if (!scene) throw new VideoStudioError("Scene not found.");
  return createQuote({ feature: "video_script", action: "video_scene", context: { jobId: job.id, sceneId: scene.id }, actorId });
}

export async function confirmSceneRegen(jobId: unknown, sceneId: unknown, quoteId: unknown, note: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  assertSceneEditable(job);
  const scene = await prisma.videoScene.findFirst({ where: { id: typeof sceneId === "string" ? sceneId : "", jobId: job.id } });
  if (!scene) throw new VideoStudioError("Scene not found.");
  if (typeof quoteId !== "string") throw new VideoStudioError("Review the price first.");
  await consumeQuote({ quoteId, actorId, feature: "video_script", action: "video_scene", context: { jobId: job.id, sceneId: scene.id } });
  await prisma.$transaction([
    prisma.videoScene.update({ where: { id: scene.id }, data: { regenQuoteId: quoteId, regenNote: typeof note === "string" ? note.trim().slice(0, 500) : null } }),
    prisma.videoJob.update({ where: { id: job.id }, data: { status: "REVIEW_REQUIRED", quoteIds: { push: quoteId }, lastActivityAt: new Date() } }),
  ]);
  await addEvent(job.id, actorId, "regen_confirmed", `Scene ${scene.index + 1}: regeneration confirmed.`);
  kickVideoWorker();
}

export async function cancelSceneRegenQuote(quoteId: unknown, actorId: string): Promise<void> {
  if (typeof quoteId === "string") await cancelQuote(quoteId, actorId);
}

// ---- narration ------------------------------------------------------------------------------

export interface VoicePending {
  nonce: string;
  model: string;
  voice: string;
  chars: number;
  scenes: number;
  estInr: number;
  maxInr: number;
  expiresAt: string;
  textHash: string;
  notes: string[];
  runnable: boolean;
  blockReason: string | null;
}

async function scenesNeedingAudio(jobId: string, model: string, voice: string) {
  const scenes = await prisma.videoScene.findMany({ where: { jobId }, orderBy: { index: "asc" } });
  const need = scenes.filter((s) => s.narration.trim() && !(s.audioKey && s.audioHash === audioHash(model, voice, s.narration)));
  const textHash = crypto.createHash("sha256").update(scenes.map((s) => `${s.id}:${s.narration}`).join("\n")).digest("hex");
  return { scenes, need, textHash };
}

/** Exact narration estimate for the scenes that still need audio (cached audio of unchanged scenes is reused). */
export async function estimateVoice(jobId: unknown, actorId: string, choice: { model?: unknown; voice?: unknown } = {}): Promise<VoicePending> {
  const job = await loadJob(jobId);
  assertSceneEditable(job);
  const cfg = job.config as unknown as VideoConfig;
  const catalog = await getVoiceCatalog();
  const modelId = typeof choice.model === "string" ? choice.model : cfg.speechModel;
  const m = catalog.models.find((x) => x.id === modelId && catalog.approvedModels.includes(x.id));
  if (!m) throw new VideoStudioError("Approve a speech model in Voice Studio first (or render without narration).");
  const voice = typeof choice.voice === "string" ? choice.voice : cfg.voiceId;
  if (!voice || !voicesFor(m, cfg.language).includes(voice)) throw new VideoStudioError("Choose a voice of this model for the video's language.");
  const { need, scenes, textHash } = await scenesNeedingAudio(job.id, m.id, voice);
  if (scenes.some((s) => s.regenQuoteId)) throw new VideoStudioError("A scene regeneration is still waiting for the worker.");
  const chars = need.reduce((a, s) => a + [...s.narration].length, 0);
  const fx = await getUsdInr();
  const notes: string[] = [];
  let usd = 0;
  for (const s of need) {
    const c = speechCostUsd(m, [...s.narration].length, s.durationSec);
    if (c.usd === null) throw new VideoStudioError(`${m.name}: no usable price in the catalog — the cost cannot be estimated.`);
    usd += c.usd;
    if (c.note && !notes.includes(c.note)) notes.push(c.note);
  }
  const estInr = usdToInr(usd, fx.rate);
  if (estInr === null) throw new VideoStudioError(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate."}`);
  const maxInr = Math.round(estInr * 1.1 * 10000) / 10000;
  const engine = await getEngineConfig();
  const usage = await budgetUsage();
  let blockReason: string | null = null;
  if (!(await resolveOpenRouterKey())) blockReason = "OpenRouter is not configured or is disabled (AI → Providers).";
  else if (engine.budgets.emergencyStop) blockReason = "AI generation is stopped by the AI emergency stop.";
  else if (maxInr > engine.budgets.dailyInr - usage.dayInr) blockReason = `The narration may cost up to ₹${maxInr.toFixed(2)}, more than today's remaining AI budget (₹${Math.max(0, engine.budgets.dailyInr - usage.dayInr).toFixed(2)}).`;
  notes.push("OpenRouter does not report the cost of speech requests: the estimate (catalog price × characters) is recorded and counted against the AI budgets.");
  if (need.length < scenes.filter((s) => s.narration.trim()).length) notes.push(`${scenes.filter((s) => s.narration.trim()).length - need.length} scene(s) keep their existing narration (text unchanged).`);
  const pending: VoicePending = { nonce: crypto.randomBytes(12).toString("hex"), model: m.id, voice, chars, scenes: need.length, estInr, maxInr, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(), textHash, notes, runnable: blockReason === null, blockReason };
  await saveEstimate(job.id, { ...est(job), voicePending: pending });
  await addEvent(job.id, actorId, "voice_estimated", `Narration estimate: ${chars} characters in ${need.length} scene(s), ₹${estInr.toFixed(2)} (max ₹${maxInr.toFixed(2)}).`);
  return pending;
}

/** Confirm & Generate narration + render. Bound to the estimate's nonce and the exact scene text it was computed from. */
export async function confirmVoice(jobId: unknown, nonce: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  assertSceneEditable(job);
  const e = est(job);
  const p = e.voicePending;
  if (!p || p.nonce !== nonce) throw new VideoStudioError("The confirmed estimate does not match the latest estimate. Review the price again.");
  if (new Date(p.expiresAt) < new Date()) throw new VideoStudioError("The estimate expired. Review the price again.");
  if (!p.runnable) throw new VideoStudioError(p.blockReason ?? "Cannot run.");
  const { textHash } = await scenesNeedingAudio(job.id, p.model, p.voice);
  if (textHash !== p.textHash) throw new VideoStudioError("The script changed after the estimate. Review the price again.");
  await assertDiskHeadroom();
  const conf: VoiceConfirmation = { mode: "voice", model: p.model, voice: p.voice, chars: p.chars, estInr: p.estInr, maxInr: p.maxInr, confirmedAt: new Date().toISOString(), confirmedById: actorId };
  const cfg = { ...(job.config as unknown as VideoConfig), speechModel: p.model, voiceId: p.voice };
  const r = await prisma.videoJob.updateMany({
    where: { id: job.id, status: job.status, updatedAt: job.updatedAt },
    data: { status: "GENERATING_AUDIO", stage: "voice", progressPct: 0, failedStage: null, errorMessage: null, estimate: { ...e, voicePending: undefined, voice: conf } as unknown as Prisma.InputJsonValue, config: cfg as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() },
  });
  if (r.count !== 1) throw new VideoStudioError("The job changed while you were confirming. Nothing was started twice.");
  await addEvent(job.id, actorId, "voice_confirmed", `Narration confirmed (₹${p.estInr.toFixed(2)}, max ₹${p.maxInr.toFixed(2)}) — queued with the render.`);
  kickVideoWorker();
}

/** Render without narration (subtitles + optional music): local, no provider charge. */
export async function renderSilent(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  assertSceneEditable(job);
  const scenes = await prisma.videoScene.count({ where: { jobId: job.id } });
  if (!scenes) throw new VideoStudioError("No script yet.");
  await assertDiskHeadroom();
  const e = est(job);
  const conf: VoiceConfirmation = { mode: "silent", model: null, voice: null, chars: 0, estInr: 0, maxInr: 0, confirmedAt: new Date().toISOString(), confirmedById: actorId };
  const r = await prisma.videoJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: job.updatedAt }, data: { status: "GENERATING_AUDIO", stage: "render", progressPct: 0, failedStage: null, errorMessage: null, estimate: { ...e, voicePending: undefined, voice: conf } as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() } });
  if (r.count !== 1) throw new VideoStudioError("The job changed meanwhile. Try again.");
  await addEvent(job.id, actorId, "render_queued", "Render without narration queued (no provider charge).");
  kickVideoWorker();
}

/** Re-render with the narration that already exists (after visual-only edits): local, free. */
export async function rerender(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  assertSceneEditable(job);
  const conf = est(job).voice;
  if (!conf) throw new VideoStudioError("Generate the narration (or choose a silent render) first.");
  if (conf.mode === "voice") {
    const { need } = await scenesNeedingAudio(job.id, conf.model!, conf.voice!);
    if (need.length) throw new VideoStudioError(`${need.length} scene(s) changed narration — generate the narration for them first (a new estimate is shown).`);
  }
  await assertDiskHeadroom();
  const r = await prisma.videoJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: job.updatedAt }, data: { status: "RENDERING", stage: "render", progressPct: 0, failedStage: null, errorMessage: null, lastActivityAt: new Date() } });
  if (r.count !== 1) throw new VideoStudioError("The job changed meanwhile. Try again.");
  await addEvent(job.id, actorId, "render_queued", "Re-render queued (no provider charge).");
  kickVideoWorker();
}

export async function setMusic(jobId: unknown, key: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  if (!["DRAFT", "CONFIGURING", "AWAITING_CONFIRMATION", ...SCENE_EDITABLE].includes(job.status)) throw new VideoStudioError("Music can be changed only while nothing is running.");
  const cfg = job.config as unknown as VideoConfig & { musicKey?: string | null };
  if (!cfg) throw new VideoStudioError("Run Auto Configure first.");
  if (key === null) Object.assign(cfg, { music: false, musicKey: null });
  else {
    const a = readAssets(job).find((x) => x.key === key && x.kind === "music" && x.state === "ready");
    if (!a) throw new VideoStudioError("Upload a music file you are licensed to use first.");
    Object.assign(cfg, { music: true, musicKey: a.key });
  }
  await prisma.videoJob.update({ where: { id: job.id }, data: { config: cfg as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() } });
  await addEvent(job.id, actorId, "music", key === null ? "Background music removed." : "Background music set.");
}

export async function setPdfPages(jobId: unknown, key: unknown, pages: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  if (!["DRAFT", "CONFIGURING", "AWAITING_CONFIRMATION"].includes(job.status)) throw new VideoStudioError("Pages can be chosen only before the script is confirmed.");
  const list = readAssets(job);
  const a = list.find((x) => x.key === key && x.kind === "pdf");
  if (!a) throw new VideoStudioError("PDF not found.");
  const sel = Array.isArray(pages) ? [...new Set(pages.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= (a.pages ?? 0)))].sort((x, y) => x - y).slice(0, 20) : [];
  a.selectedPages = sel;
  await prisma.videoJob.update({ where: { id: job.id }, data: { assets: list as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() } });
  await addEvent(job.id, actorId, "pdf_pages", sel.length ? `PDF pages selected: ${sel.join(", ")}.` : "All PDF pages (up to 20) will be used.");
}

/** A short paid voice sample, only on an explicit click (the price is shown first). Returns a data: URL. */
export async function previewVoice(input: { model: unknown; voice: unknown; text: unknown }, actorId: string): Promise<{ audio: string; estInr: number }> {
  const catalog = await getVoiceCatalog();
  const m = catalog.models.find((x) => x.id === input.model);
  if (!m) throw new VideoStudioError("Unknown speech model (sync the catalog).");
  if (typeof input.voice !== "string" || !m.voices.includes(input.voice)) throw new VideoStudioError("Unknown voice for this model.");
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim().slice(0, 220) : "";
  if (!text) throw new VideoStudioError("Enter a sample sentence.");
  const c = speechCostUsd(m, [...text].length, 12);
  if (c.usd === null) throw new VideoStudioError(`${m.name} has no usable price — a preview cannot be estimated.`);
  const r = await synthesizeSpeech({ model: m.id, voice: input.voice, text, estUsd: c.usd, actorId, ref: "video:preview", timeoutMs: 45_000 });
  return { audio: `data:audio/mpeg;base64,${r.audio.toString("base64")}`, estInr: r.estInr };
}

/** Price of a preview before the click (free). */
export async function previewPrice(input: { model: unknown; voice: unknown; text: unknown }): Promise<{ inr: number | null }> {
  const catalog = await getVoiceCatalog();
  const m = catalog.models.find((x) => x.id === input.model);
  if (!m) return { inr: null };
  const text = typeof input.text === "string" ? input.text.trim().slice(0, 220) : "";
  const c = speechCostUsd(m, [...text].length, 12);
  const fx = await getUsdInr();
  return { inr: c.usd === null ? null : usdToInr(c.usd, fx.rate) };
}

// ---- retry -------------------------------------------------------------------------------------

export async function retryJob(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  if (job.status !== "FAILED") throw new VideoStudioError("Only a failed job can be retried.");
  if (job.mediaDeletedAt) throw new VideoStudioError("This job's media were deleted by the retention policy — start a new job.");
  const stage = job.failedStage ?? "script";
  const to =
    job.kind === "EDIT"
      ? stage === "ingest"
        ? "QUEUED"
        : "RENDERING"
      : stage === "script"
        ? "CONFIGURING"
        : stage === "voice"
          ? "GENERATING_AUDIO"
          : "RENDERING";
  if (to === "GENERATING_AUDIO" && !est(job).voice) throw new VideoStudioError("No confirmed narration estimate — review the script and confirm the narration again.");
  if (to === "RENDERING" && job.kind === "GENERATE" && !est(job).voice) throw new VideoStudioError("Confirm the narration (or a silent render) first.");
  await prisma.videoJob.update({ where: { id: job.id }, data: { status: to, failedStage: null, errorMessage: null, stage: null, progressPct: 0, finishedAt: null, lastActivityAt: new Date(), ...(to === "CONFIGURING" ? { estimate: Prisma.DbNull, estTotalInr: null } : {}) } });
  await addEvent(job.id, actorId, "retry", to === "CONFIGURING" ? "Retry: the script step needs a new price confirmation." : `Retry from the ${stage} step (finished steps are kept; no repeated charges for narration that already exists).`);
  if (to !== "CONFIGURING") kickVideoWorker();
}

// ---- AI Video Editor ------------------------------------------------------------------------

export async function createEditJob(title: unknown, actorId: string): Promise<VideoJob> {
  await assertDiskHeadroom();
  const t = typeof title === "string" && title.trim() ? title.trim().slice(0, 120) : "Edited video";
  const job = await prisma.videoJob.create({ data: { kind: "EDIT", title: t, status: "DRAFT", source: { type: "upload" } as Prisma.InputJsonValue, createdById: actorId } });
  await addEvent(job.id, actorId, "created", "Editor project created. Upload a recording.");
  return job;
}

/** After uploads: probe + preview proxies in the render container (local, free). */
export async function processUploads(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  if (job.kind !== "EDIT") throw new VideoStudioError("Not an editor project.");
  if (!["DRAFT", "REVIEW_REQUIRED", "COMPLETED", "FAILED"].includes(job.status)) throw new VideoStudioError("Wait until the current step finishes.");
  const pending = readAssets(job).filter((a) => a.state === "processing");
  if (!pending.length) throw new VideoStudioError("No new upload to process.");
  await prisma.videoJob.update({ where: { id: job.id }, data: { status: "QUEUED", stage: "ingest", progressPct: 0, failedStage: null, errorMessage: null, lastActivityAt: new Date() } });
  await addEvent(job.id, actorId, "ingest_queued", `${pending.length} upload(s) queued for checking and preview.`);
  kickVideoWorker();
}

function editAssets(job: VideoJob): EditAsset[] {
  return readAssets(job)
    .filter((a) => a.state === "ready")
    .map((a: JobAsset) => ({ key: a.key, kind: a.kind, durationSec: a.durationSec, hasAudio: a.hasAudio }));
}

export async function saveEdit(jobId: unknown, project: unknown, actorId: string): Promise<EditProject> {
  const job = await loadJob(jobId);
  if (job.kind !== "EDIT") throw new VideoStudioError("Not an editor project.");
  if (!["REVIEW_REQUIRED", "COMPLETED", "FAILED"].includes(job.status)) throw new VideoStudioError("Wait until the current step finishes.");
  let p: EditProject;
  try {
    p = parseEditProject(project, editAssets(job));
  } catch (e) {
    throw new VideoStudioError(e instanceof EditValidationError ? e.message : "Invalid edit.");
  }
  await prisma.videoJob.update({ where: { id: job.id }, data: { edit: p as unknown as Prisma.InputJsonValue, status: "REVIEW_REQUIRED", lastActivityAt: new Date() } });
  await addEvent(job.id, actorId, "edit_saved", `Edit saved: ${p.segments.length} segment(s), ${p.overlays.length} overlay(s), ${p.subtitles.cues.length} subtitle cue(s).`);
  return p;
}

export async function resetEdit(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  if (job.kind !== "EDIT" || !["REVIEW_REQUIRED", "COMPLETED", "FAILED"].includes(job.status)) throw new VideoStudioError("Wait until the current step finishes.");
  const settings = await getVideoSettings();
  const primary = readAssets(job).find((a) => a.kind === "video" && a.state === "ready");
  if (!primary) throw new VideoStudioError("Upload a recording first.");
  const portrait = (primary.video?.height ?? 0) > (primary.video?.width ?? 0);
  const p = defaultProject({ key: primary.key, kind: "video", durationSec: primary.durationSec }, portrait ? "9:16" : "16:9", "minimal_professional", settings.musicVolumePct);
  await prisma.videoJob.update({ where: { id: job.id }, data: { edit: p as unknown as Prisma.InputJsonValue, status: "REVIEW_REQUIRED" } });
  await addEvent(job.id, actorId, "edit_reset", "Edit reset to the full recording.");
}

export async function exportEdit(jobId: unknown, project: unknown, actorId: string): Promise<void> {
  const p = await saveEdit(jobId, project, actorId);
  await assertDiskHeadroom();
  const job = await loadJob(jobId);
  const r = await prisma.videoJob.updateMany({ where: { id: job.id, status: "REVIEW_REQUIRED" }, data: { status: "RENDERING", stage: "export", progressPct: 0, confirmedAt: job.confirmedAt ?? new Date(), confirmedById: job.confirmedById ?? actorId } });
  if (r.count !== 1) throw new VideoStudioError("The job changed meanwhile. Try again.");
  await addEvent(job.id, actorId, "export_queued", `Export queued (${p.aspect}, local render — no provider charge).`);
  kickVideoWorker();
}

export interface TranscribePending {
  nonce: string;
  model: string;
  language: string | null;
  seconds: number;
  estInr: number;
  maxInr: number;
  expiresAt: string;
  runnable: boolean;
  blockReason: string | null;
}

export async function estimateTranscription(jobId: unknown, input: { model?: unknown; language?: unknown }, actorId: string): Promise<TranscribePending> {
  const job = await loadJob(jobId);
  if (job.kind !== "EDIT" || !["REVIEW_REQUIRED", "COMPLETED", "FAILED"].includes(job.status)) throw new VideoStudioError("Wait until the current step finishes.");
  const p = job.edit as unknown as EditProject | null;
  const primary = readAssets(job).find((a) => a.key === p?.primary);
  if (!p || !primary?.durationSec) throw new VideoStudioError("Upload and process a recording first.");
  if (!primary.hasAudio) throw new VideoStudioError("The recording has no audio track to transcribe.");
  const catalog = await getVoiceCatalog();
  const settings = await getVideoSettings();
  const modelId = typeof input.model === "string" ? input.model : settings.transcriptionModel;
  const m = catalog.sttModels.find((x) => x.id === modelId);
  if (!m) throw new VideoStudioError("Choose a transcription model (Voice Studio → sync, then Settings → Transcription model).");
  if (m.perSecondUsd === null) throw new VideoStudioError(`${m.name} is priced per token — its cost cannot be estimated before the request. Choose a per-second model.`);
  const language = input.language === "hi" || input.language === "en" ? input.language : null;
  const fx = await getUsdInr();
  const estInr = usdToInr(m.perSecondUsd * primary.durationSec, fx.rate);
  if (estInr === null) throw new VideoStudioError(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate."}`);
  const maxInr = Math.round(estInr * 1.2 * 10000) / 10000;
  const engine = await getEngineConfig();
  const usage = await budgetUsage();
  let blockReason: string | null = null;
  if (!(await resolveOpenRouterKey())) blockReason = "OpenRouter is not configured or is disabled (AI → Providers).";
  else if (engine.budgets.emergencyStop) blockReason = "AI generation is stopped by the AI emergency stop.";
  else if (maxInr > engine.budgets.dailyInr - usage.dayInr) blockReason = "More than today's remaining AI budget.";
  const pending: TranscribePending = { nonce: crypto.randomBytes(12).toString("hex"), model: m.id, language, seconds: primary.durationSec, estInr, maxInr, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(), runnable: !blockReason, blockReason };
  await saveEstimate(job.id, { ...est(job), transcribePending: pending });
  await addEvent(job.id, actorId, "transcribe_estimated", `Transcription estimate: ${Math.round(primary.durationSec)} s with ${m.id}, ₹${estInr.toFixed(2)}.`);
  return pending;
}

export async function confirmTranscription(jobId: unknown, nonce: unknown, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  const e = est(job);
  const p = e.transcribePending;
  if (!p || p.nonce !== nonce) throw new VideoStudioError("Review the price again.");
  if (new Date(p.expiresAt) < new Date()) throw new VideoStudioError("The estimate expired. Review the price again.");
  if (!p.runnable) throw new VideoStudioError(p.blockReason ?? "Cannot run.");
  const conf: TranscribeConfirmation = { model: p.model, language: p.language, seconds: p.seconds, estInr: p.estInr, maxInr: p.maxInr, confirmedAt: new Date().toISOString(), confirmedById: actorId };
  const r = await prisma.videoJob.updateMany({ where: { id: job.id, status: { in: ["REVIEW_REQUIRED", "COMPLETED", "FAILED"] }, updatedAt: job.updatedAt }, data: { status: "GENERATING_AUDIO", stage: "transcribe", progressPct: 0, estimate: { ...e, transcribePending: undefined, transcribe: conf } as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() } });
  if (r.count !== 1) throw new VideoStudioError("The job changed meanwhile. Nothing was started twice.");
  await addEvent(job.id, actorId, "transcribe_confirmed", `Transcription confirmed (₹${p.estInr.toFixed(2)}).`);
  kickVideoWorker();
}
