import "server-only";
import crypto from "node:crypto";
import { Prisma, QuestionStatus, type VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cancelQuote, consumeQuote, createQuote, type QuoteView } from "@/lib/ai-engine/quote";
import { usdToInr } from "@/lib/ai-engine/config";
import { getEngineConfig, resolveOpenRouterKey } from "@/lib/ai-engine/settings";
import { budgetUsage } from "@/lib/ai-engine/budget";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { addEvent, assertDiskHeadroom, VideoStudioError } from "@/lib/video-studio/jobs";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { getVoiceCatalog, speechCostUsd, voicesFor } from "@/lib/video-studio/voices";
import { motionSkillKeys } from "@/lib/video-studio/skills";
import { kickVideoWorker } from "@/lib/video-studio/kick";
import { audioHash } from "@/lib/video-studio/pipeline";
import { plainQuestionText } from "@/lib/video-studio/script";
import { unsupportedVideoChars } from "@/lib/video-studio/glyphs";
import { estimateSpeechSec } from "@/lib/video-studio/text";
import { ASPECT_KEYS, AUDIENCE_KEYS, LANGUAGE_KEYS, type AspectRatio } from "@/lib/video-studio/types";
import { MOTION_STYLE_MAP } from "@/lib/video-studio/motion/styles";
import {
  DEFAULT_STYLE,
  MOTION_LIMITS,
  MOTION_VIDEO_TYPES,
  MOTION_VIDEO_TYPE_MAP,
  parseFrame,
  pickMotion,
  planStoryboard,
  type MotionConfig,
  type MotionFrameDraft,
  type MotionQuestion,
  type MotionVideoType,
  type MotionVisual,
} from "@/lib/video-studio/motion/storyboard";
import { storyboardChecks, type QaCheck } from "@/lib/video-studio/motion/quality";
import { saveFrames, scriptText, type MotionTake, type MotionVoiceConfirmation } from "@/lib/video-studio/motion/pipeline";

/**
 * Motion Workflow Studio — job service (called by the Server Actions in
 * app/admin/(dashboard)/video-studio/motion/actions.ts after the permission
 * check). MOTION jobs reuse the VideoJob / VideoScene tables, the cost
 * ledger, the uploads, the worker and the render container; their flow and
 * pages are separate from the Generator and the Editor.
 *
 * Paid steps (each shows its price and needs an explicit confirmation):
 *   1. script + storyboard   — one OpenRouter text call (AiCostQuote, consumed once)
 *   2. narration             — one OpenRouter speech call for the whole script
 *   3. precise word sync     — optional OpenRouter transcription of that narration
 * Everything else (your own script, re-planning, QA, rendering) is free.
 */

const PENDING_TTL_MS = 30 * 60_000;
const ID = /^[a-z0-9]{20,40}$/;
const RUNNING = ["QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING"];
const REVIEWABLE = ["REVIEW_REQUIRED", "COMPLETED", "FAILED"];

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

export async function loadMotionJob(id: unknown): Promise<VideoJob> {
  if (typeof id !== "string" || !ID.test(id)) throw new VideoStudioError("Video job not found.");
  const job = await prisma.videoJob.findUnique({ where: { id } });
  if (!job || job.kind !== "MOTION") throw new VideoStudioError("Motion video not found.");
  return job;
}

function cfgOf(job: VideoJob): MotionConfig & { take?: MotionTake | null } {
  return job.config as unknown as MotionConfig & { take?: MotionTake | null };
}

type MotionEstimate = Record<string, unknown> & { quoteId?: string | null; motionVoice?: MotionVoiceConfirmation; motionVoicePending?: MotionVoicePending };
const estOf = (job: VideoJob): MotionEstimate => ((job.estimate as MotionEstimate | null) ?? {}) as MotionEstimate;

async function dropOpenQuote(job: VideoJob, actorId: string) {
  const q = estOf(job).quoteId;
  if (q && job.status === "AWAITING_CONFIRMATION") await cancelQuote(q, actorId).catch(() => undefined);
}

function assertReviewable(job: VideoJob) {
  if (!REVIEWABLE.includes(job.status)) throw new VideoStudioError(RUNNING.includes(job.status) ? "Wait until the current step finishes." : "Write or generate the storyboard first.");
  if (job.mediaDeletedAt) throw new VideoStudioError("This video's media were deleted by the retention policy — start a new one.");
}

// ---- create / configure ---------------------------------------------------------------------

export interface MotionInput {
  title?: unknown;
  videoType?: unknown;
  styleKey?: unknown;
  aspect?: unknown;
  language?: unknown;
  audience?: unknown;
  targetSec?: unknown;
  topic?: unknown;
  brief?: unknown;
  questionIds?: unknown;
  examId?: unknown;
  cta?: unknown;
  skillKeys?: unknown;
  subtitles?: unknown;
  branding?: unknown;
}

async function questionIdsOf(v: unknown): Promise<string[]> {
  const ids = (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && ID.test(x)).slice(0, 3);
  if (!ids.length) return [];
  const found = await prisma.question.findMany({ where: { id: { in: ids }, status: QuestionStatus.PUBLISHED, parentQuestionId: null }, select: { id: true } });
  if (found.length !== ids.length) throw new VideoStudioError("Only published Question Bank questions can be used.");
  return ids;
}

export async function createMotionJob(input: MotionInput, actorId: string): Promise<VideoJob> {
  await assertDiskHeadroom();
  const videoType = (MOTION_VIDEO_TYPES.find((t) => t.key === input.videoType)?.key ?? "medical_explainer") as MotionVideoType;
  const styleKey = typeof input.styleKey === "string" && MOTION_STYLE_MAP[input.styleKey] ? input.styleKey : DEFAULT_STYLE[videoType];
  const aspect = (ASPECT_KEYS.find((a) => a === input.aspect) ?? "9:16") as AspectRatio;
  const language = LANGUAGE_KEYS.find((l) => l === input.language) ?? "hinglish";
  const audience = AUDIENCE_KEYS.find((a) => a === input.audience) ?? "neet_pg";
  const targetSec = Math.round(Math.min(MOTION_LIMITS.maxSec, Math.max(MOTION_LIMITS.minSec, Number(input.targetSec) || 40)));
  const topic = str(input.topic, 200);
  const brief = typeof input.brief === "string" ? input.brief.trim().slice(0, 2000) : "";
  const questionIds = await questionIdsOf(input.questionIds);
  if (videoType === "mcq_explainer" && !questionIds.length) throw new VideoStudioError("An MCQ explainer needs a Question Bank question.");
  if (!topic && !brief && !questionIds.length) throw new VideoStudioError("Give a topic, a brief or a Question Bank question.");
  let examLabel: string | null = null;
  if (typeof input.examId === "string" && ID.test(input.examId)) examLabel = (await prisma.exam.findUnique({ where: { id: input.examId }, select: { name: true } }))?.name ?? null;
  const settings = await getVideoSettings();
  const medical = MOTION_VIDEO_TYPE_MAP[videoType].medical;
  const config: MotionConfig = {
    version: 1,
    module: "motion",
    videoType,
    styleKey,
    aspect,
    language,
    audience,
    targetSec,
    frameCount: Math.min(MOTION_LIMITS.maxFrames, Math.max(MOTION_LIMITS.minFrames, Math.round(targetSec / 6))),
    examLabel,
    cta: str(input.cta, 80) || settings.brand.cta,
    branding: input.branding !== false,
    subtitles: input.subtitles !== false,
    questionIds,
    skillKeys: motionSkillKeys(input.skillKeys ?? (medical ? ["medical_fact_checker", "medical_teacher", "hook_writer", "voice_director"] : ["hook_writer", "promo_creator"]), medical),
    topic,
    brief,
    title: str(input.title, 120) || topic || "Motion video",
    timing: null,
  };
  const job = await prisma.videoJob.create({
    data: { kind: "MOTION", title: config.title!, status: "DRAFT", source: { type: "motion", topic, questionIds } as Prisma.InputJsonValue, config: config as unknown as Prisma.InputJsonValue, examLabel, createdById: actorId },
  });
  await addEvent(job.id, actorId, "created", `Motion video created (${MOTION_STYLE_MAP[styleKey].name}, ${aspect}, ${targetSec} s).`);
  return job;
}

/** Settings the admin may change. The style can be changed until the video is rendered; the frames keep their content and get the new style's motions. */
export async function updateMotionConfig(jobId: unknown, patch: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  if (RUNNING.includes(job.status) || job.status === "CANCELLED") throw new VideoStudioError("Wait until the current step finishes.");
  const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  const cfg = { ...cfgOf(job) };
  const before = job.status === "DRAFT" || job.status === "AWAITING_CONFIRMATION" || job.status === "CONFIGURING";
  if (typeof p.styleKey === "string") {
    if (!MOTION_STYLE_MAP[p.styleKey]) throw new VideoStudioError("Unknown style.");
    cfg.styleKey = p.styleKey;
  }
  if (typeof p.aspect === "string") {
    const a = ASPECT_KEYS.find((x) => x === p.aspect);
    if (!a) throw new VideoStudioError("Unknown aspect ratio.");
    cfg.aspect = a;
  }
  if (typeof p.cta === "string") cfg.cta = str(p.cta, 80) || cfg.cta;
  if (typeof p.subtitles === "boolean") cfg.subtitles = p.subtitles;
  if (typeof p.branding === "boolean") cfg.branding = p.branding;
  if (before) {
    if (typeof p.targetSec === "number") cfg.targetSec = Math.round(Math.min(MOTION_LIMITS.maxSec, Math.max(MOTION_LIMITS.minSec, p.targetSec)));
    if (typeof p.topic === "string") cfg.topic = str(p.topic, 200);
    if (typeof p.brief === "string") cfg.brief = p.brief.trim().slice(0, 2000);
    cfg.frameCount = Math.min(MOTION_LIMITS.maxFrames, Math.max(MOTION_LIMITS.minFrames, Math.round(cfg.targetSec / 6)));
  }
  await dropOpenQuote(job, actorId);
  // A new style re-locks every frame's motion to the new style's set.
  if (cfg.styleKey !== cfgOf(job).styleKey) {
    const style = MOTION_STYLE_MAP[cfg.styleKey];
    const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
    let prev: MotionVisual["motion"] | null = null;
    for (const [i, s] of scenes.entries()) {
      const v = s.visual as unknown as MotionVisual;
      const motion = pickMotion(style, v.motion, prev, i, v.type);
      prev = motion;
      await prisma.videoScene.update({ where: { id: s.id }, data: { visual: { ...v, motion, tag: style.tagHint ? v.tag : null } as unknown as Prisma.InputJsonValue } });
    }
  }
  await prisma.videoJob.update({
    where: { id: job.id },
    data: { config: cfg as unknown as Prisma.InputJsonValue, ...(job.status === "AWAITING_CONFIRMATION" ? { status: "DRAFT", estimate: Prisma.DbNull, estTotalInr: null } : {}), lastActivityAt: new Date() },
  });
  await addEvent(job.id, actorId, "configured", `Settings changed: ${Object.keys(p).join(", ") || "none"}.`);
}

// ---- step 1: script + storyboard (paid, or your own script for free) ------------------------

export async function requestMotionEstimate(jobId: unknown, actorId: string): Promise<QuoteView> {
  const job = await loadMotionJob(jobId);
  if (!["DRAFT", "AWAITING_CONFIRMATION", "CONFIGURING"].includes(job.status)) throw new VideoStudioError("The storyboard already exists — edit it, or start a new video.");
  await dropOpenQuote(job, actorId);
  const quote = await createQuote({ feature: "video_script", action: "motion_script", context: { jobId: job.id }, actorId });
  await prisma.videoJob.update({
    where: { id: job.id },
    data: { status: "AWAITING_CONFIRMATION", estimate: { quoteId: quote.runnable ? quote.id : null, totalInr: quote.totalInr, totalMaxInr: quote.totalMaxInr, model: quote.model, runnable: quote.runnable, blockReason: quote.blockReason, notes: quote.notes, createdAt: new Date().toISOString(), expiresAt: quote.expiresAt } as unknown as Prisma.InputJsonValue, estTotalInr: quote.totalInr, lastActivityAt: new Date() },
  });
  await addEvent(job.id, actorId, "estimated", quote.totalInr === null ? "Script estimate shown (cost unknown)." : `Script + storyboard estimate: ₹${quote.totalInr.toFixed(2)}.`);
  return quote;
}

export async function confirmMotionScript(jobId: unknown, quoteId: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  if (job.status !== "AWAITING_CONFIRMATION") throw new VideoStudioError("Review the estimated price first.");
  const e = estOf(job);
  if (!e.quoteId || e.quoteId !== quoteId) throw new VideoStudioError("The confirmed estimate does not match the latest estimate. Review the price again.");
  await assertDiskHeadroom();
  await consumeQuote({ quoteId, actorId, feature: "video_script", action: "motion_script", context: { jobId: job.id } });
  const r = await prisma.videoJob.updateMany({ where: { id: job.id, status: "AWAITING_CONFIRMATION" }, data: { status: "QUEUED", confirmedAt: new Date(), confirmedById: actorId, quoteIds: { push: e.quoteId }, lastActivityAt: new Date() } });
  if (r.count !== 1) throw new VideoStudioError("This video changed while you were confirming. Nothing was started twice.");
  await addEvent(job.id, actorId, "confirmed", "Cost confirmed — queued for the script and storyboard.");
  kickVideoWorker();
}

/** Free: the admin's own script → a storyboard (one frame per sentence), no AI. Also used to re-plan after editing the script. */
export async function planFromScript(jobId: unknown, script: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  if (RUNNING.includes(job.status) || job.status === "CANCELLED") throw new VideoStudioError("Wait until the current step finishes.");
  if (job.mediaDeletedAt) throw new VideoStudioError("This video's media were deleted by the retention policy.");
  const text = typeof script === "string" ? script.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 3000) : "";
  const cfg = cfgOf(job);
  const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  const existing: MotionFrameDraft[] = scenes.map((s) => ({ sentence: s.narration, onScreen: s.onScreenText, visual: s.visual as unknown as MotionVisual, durationSec: s.durationSec, needsReview: s.needsReview, reviewNote: s.reviewNote }));
  const frames = planStoryboard(text, cfg, existing);
  if (frames.length < 2) throw new VideoStudioError("Write at least two sentences (one sentence becomes one frame).");
  const bad = unsupportedVideoChars(text);
  if (bad.length) throw new VideoStudioError(`These characters cannot be drawn by the video fonts: ${bad.slice(0, 8).join(" ")}`);
  if (frames[frames.length - 1].visual.type !== "cta") frames[frames.length - 1].visual.type = "cta";
  await dropOpenQuote(job, actorId);
  await saveFrames(job.id, frames);
  await prisma.videoJob.update({
    where: { id: job.id },
    data: { status: "REVIEW_REQUIRED", config: { ...cfg, timing: null } as unknown as Prisma.InputJsonValue, ...(job.status === "AWAITING_CONFIRMATION" ? { estimate: Prisma.DbNull, estTotalInr: null } : {}), lastActivityAt: new Date() },
  });
  await addEvent(job.id, actorId, "storyboard_planned", `Storyboard planned from ${existing.length ? "the edited" : "your"} script: ${frames.length} frames (free, no AI).`);
}

// ---- frames --------------------------------------------------------------------------------

async function questionsOf(cfg: MotionConfig): Promise<MotionQuestion[]> {
  if (!cfg.questionIds.length) return [];
  const rows = await prisma.question.findMany({ where: { id: { in: cfg.questionIds } }, select: { id: true, code: true, text: true, explanation: true, options: { select: { label: true, text: true, isCorrect: true }, orderBy: { order: "asc" } } } });
  return rows.map((r) => {
    const c = r.options.filter((o) => o.isCorrect);
    return { id: r.id, code: r.code, stem: plainQuestionText(r.text), options: r.options.map((o) => ({ label: o.label.trim().slice(0, 3) || "?", text: plainQuestionText(o.text) })), correctLabel: c.length === 1 ? c[0].label.trim().slice(0, 3) : null, explanation: r.explanation ? plainQuestionText(r.explanation).slice(0, 600) : null };
  });
}

/** Edits one frame. Question frames keep the Question Bank's stem, options and answer (never taken from the browser). */
export async function updateMotionFrame(jobId: unknown, sceneId: unknown, patch: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  assertReviewable(job);
  const scene = await prisma.videoScene.findFirst({ where: { id: typeof sceneId === "string" ? sceneId : "", jobId: job.id } });
  if (!scene) throw new VideoStudioError("Frame not found.");
  const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  const cfg = cfgOf(job);
  const v = scene.visual as unknown as MotionVisual;
  const prev = scene.index > 0 ? ((await prisma.videoScene.findFirst({ where: { jobId: job.id, index: scene.index - 1 } }))?.visual as unknown as MotionVisual | null)?.motion ?? null : null;
  const pv = (p.visual && typeof p.visual === "object" ? p.visual : {}) as Record<string, unknown>;
  const questions = await questionsOf(cfg);
  const raw = {
    sentence: typeof p.sentence === "string" ? p.sentence : scene.narration,
    onScreen: typeof p.onScreen === "string" ? p.onScreen : scene.onScreenText,
    highlight: typeof p.highlight === "string" ? p.highlight : v.highlight,
    motion: typeof p.motion === "string" ? p.motion : v.motion,
    tag: typeof p.tag === "string" ? p.tag : v.tag,
    visual: v.type === "question" ? { type: "question", questionId: v.questionId, revealAtSec: typeof pv.revealAtSec === "number" ? pv.revealAtSec : v.revealAtSec } : { ...v, ...pv, type: typeof pv.type === "string" && pv.type !== "question" ? pv.type : v.type },
  };
  const images = (Array.isArray(job.assets) ? (job.assets as { key: string; kind: string; state: string }[]) : []).filter((a) => a.kind === "image" && a.state === "ready");
  const d = parseFrame(raw, cfg, questions, images, prev, scene.index, []);
  if (!d.sentence) throw new VideoStudioError("The spoken sentence cannot be empty.");
  const bad = unsupportedVideoChars(`${d.sentence} ${d.onScreen}`);
  if (bad.length) throw new VideoStudioError(`These characters cannot be drawn by the video fonts: ${bad.slice(0, 8).join(" ")}`);
  const reviewed = p.reviewed === true;
  await prisma.videoScene.update({
    where: { id: scene.id },
    data: { narration: d.sentence, onScreenText: d.onScreen, visual: d.visual as unknown as Prisma.InputJsonValue, ...(d.sentence !== scene.narration ? { durationSec: d.durationSec } : {}), ...(reviewed ? { needsReview: false, reviewNote: null } : {}) },
  });
  // A changed sentence invalidates the narration timing (the take is re-recorded only after a new confirmation).
  if (d.sentence !== scene.narration) await prisma.videoJob.update({ where: { id: job.id }, data: { config: { ...cfg, timing: null } as unknown as Prisma.InputJsonValue } });
  await prisma.videoJob.update({ where: { id: job.id }, data: { status: "REVIEW_REQUIRED", lastActivityAt: new Date() } });
  await addEvent(job.id, actorId, "frame_edited", `Frame ${scene.index + 1} edited${reviewed ? " and marked as reviewed" : ""}.`);
}

export async function moveMotionFrame(jobId: unknown, sceneId: unknown, dir: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  assertReviewable(job);
  const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  const i = scenes.findIndex((s) => s.id === sceneId);
  if (i < 0) throw new VideoStudioError("Frame not found.");
  const order = scenes.map((s) => s.id);
  if (dir === "delete") {
    if (scenes.length <= 2) throw new VideoStudioError("Keep at least two frames.");
    order.splice(i, 1);
  } else {
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= scenes.length) return;
    [order[i], order[j]] = [order[j], order[i]];
  }
  await prisma.$transaction([
    ...(dir === "delete" ? [prisma.videoScene.delete({ where: { id: scenes[i].id } })] : []),
    ...order.map((id, k) => prisma.videoScene.update({ where: { id }, data: { index: k + 1000 } })),
    ...order.map((id, k) => prisma.videoScene.update({ where: { id }, data: { index: k } })),
  ]);
  await prisma.videoJob.update({ where: { id: job.id }, data: { config: { ...cfgOf(job), timing: null } as unknown as Prisma.InputJsonValue, status: "REVIEW_REQUIRED" } });
  await addEvent(job.id, actorId, "frame_moved", dir === "delete" ? `Frame ${i + 1} deleted.` : `Frame ${i + 1} moved ${dir}.`);
}

/** The storyboard's QA checks (free; computed on every load). */
export async function motionChecks(job: VideoJob): Promise<QaCheck[]> {
  const cfg = cfgOf(job);
  const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  const frames = scenes.map((s) => ({ sentence: s.narration, onScreen: s.onScreenText, visual: s.visual as unknown as MotionVisual, durationSec: s.durationSec, needsReview: s.needsReview, reviewNote: s.reviewNote }));
  return storyboardChecks(cfg, frames, cfg.timing ?? null, unsupportedVideoChars);
}

// ---- step 2: narration (one take) + word sync ------------------------------------------------

export interface MotionVoicePending {
  nonce: string;
  model: string;
  voice: string;
  chars: number;
  estSec: number;
  estInr: number;
  maxInr: number;
  sync: "precise" | "estimated";
  stt: { model: string; perSecondUsd: number; estInr: number; maxInr: number; language: string | null } | null;
  totalInr: number;
  totalMaxInr: number;
  textHash: string;
  expiresAt: string;
  notes: string[];
  runnable: boolean;
  blockReason: string | null;
}

async function textOf(jobId: string) {
  const scenes = await prisma.videoScene.findMany({ where: { jobId }, orderBy: { index: "asc" } });
  const text = scriptText(scenes.map((s) => s.narration));
  return { scenes, text, textHash: crypto.createHash("sha256").update(scenes.map((s) => `${s.id}:${s.narration}`).join("\n")).digest("hex") };
}

export async function estimateMotionVoice(jobId: unknown, choice: { model?: unknown; voice?: unknown; sync?: unknown }, actorId: string): Promise<MotionVoicePending> {
  const job = await loadMotionJob(jobId);
  assertReviewable(job);
  const cfg = cfgOf(job);
  const catalog = await getVoiceCatalog();
  const m = catalog.models.find((x) => x.id === choice.model && catalog.approvedModels.includes(x.id));
  if (!m) throw new VideoStudioError("Approve a speech model in Voice Studio first (or render without narration).");
  const voice = typeof choice.voice === "string" ? choice.voice : "";
  if (!voicesFor(m, cfg.language).includes(voice)) throw new VideoStudioError("Choose a voice of this model for the video's language.");
  const { text, textHash, scenes } = await textOf(job.id);
  if (!scenes.length) throw new VideoStudioError("The storyboard has no frames.");
  const chars = [...text].length;
  if (chars > 3000) throw new VideoStudioError("The script is longer than one narration take allows (3 000 characters).");
  const estSec = Math.max(5, estimateSpeechSec(text, cfg.language));
  const fx = await getUsdInr();
  const notes: string[] = ["One narration take for the whole script keeps the tone steady from the first frame to the last.", "OpenRouter does not report the cost of speech requests: the estimate (catalog price × characters) is recorded and counted against the AI budgets."];
  const take = cfg.take && cfg.take.hash === audioHash(m.id, voice, text) ? cfg.take : null;
  const c = speechCostUsd(m, chars, estSec);
  if (c.usd === null) throw new VideoStudioError(`${m.name}: no usable price in the catalog — the cost cannot be estimated.`);
  if (c.note) notes.push(c.note);
  const estInr = take ? 0 : usdToInr(c.usd, fx.rate);
  if (estInr === null) throw new VideoStudioError(`AI cost cannot be calculated: ${fx.unavailableReason ?? "no USD→INR rate."}`);
  if (take) notes.push("The narration for this exact script and voice already exists — it is reused (no new speech charge).");
  let stt: MotionVoicePending["stt"] = null;
  const settings = await getVideoSettings();
  const sync = choice.sync === "estimated" ? "estimated" : "precise";
  if (sync === "precise") {
    const sm = catalog.sttModels.find((x) => x.id === settings.transcriptionModel);
    if (!sm || sm.perSecondUsd === null) throw new VideoStudioError("Precise sync needs a per-second transcription model (Settings → Transcription model). Choose estimated sync instead, or set one.");
    const sec = take?.sec ?? estSec * 1.3;
    const e = usdToInr(sm.perSecondUsd * sec, fx.rate) ?? 0;
    stt = { model: sm.id, perSecondUsd: sm.perSecondUsd, estInr: e, maxInr: Math.round(e * 1.4 * 10000) / 10000, language: cfg.language === "en" ? "en" : "hi" };
    notes.push(`Precise sync transcribes the narration once (${sm.id}) to get the exact second of every word.`);
  } else notes.push("Estimated sync: words are spread over the measured narration length (free; close, not exact).");
  const maxInr = Math.round(estInr * 1.1 * 10000) / 10000;
  const totalInr = estInr + (stt?.estInr ?? 0);
  const totalMaxInr = maxInr + (stt?.maxInr ?? 0);
  const engine = await getEngineConfig();
  const usage = await budgetUsage();
  let blockReason: string | null = null;
  const fails = (await motionChecks(job)).filter((x) => x.status === "fail");
  if (!(await resolveOpenRouterKey())) blockReason = "OpenRouter is not configured or is disabled (AI → Providers).";
  else if (engine.budgets.emergencyStop) blockReason = "AI generation is stopped by the AI emergency stop.";
  else if (totalMaxInr > engine.budgets.dailyInr - usage.dayInr) blockReason = `This may cost up to ₹${totalMaxInr.toFixed(2)}, more than today's remaining AI budget (₹${Math.max(0, engine.budgets.dailyInr - usage.dayInr).toFixed(2)}).`;
  else if (fails.length) blockReason = `Fix the failed quality checks first: ${fails.map((f) => f.label).join(", ")}.`;
  const pending: MotionVoicePending = { nonce: crypto.randomBytes(12).toString("hex"), model: m.id, voice, chars, estSec, estInr, maxInr, sync, stt, totalInr, totalMaxInr, textHash, expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(), notes, runnable: !blockReason, blockReason };
  await prisma.videoJob.update({ where: { id: job.id }, data: { estimate: { ...estOf(job), motionVoicePending: pending } as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() } });
  await addEvent(job.id, actorId, "voice_estimated", `Narration estimate: ${chars} characters, ₹${totalInr.toFixed(2)} (max ₹${totalMaxInr.toFixed(2)}), ${sync} sync.`);
  return pending;
}

export async function confirmMotionVoice(jobId: unknown, nonce: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  assertReviewable(job);
  const e = estOf(job);
  const p = e.motionVoicePending;
  if (!p || p.nonce !== nonce) throw new VideoStudioError("The confirmed estimate does not match the latest estimate. Review the price again.");
  if (new Date(p.expiresAt) < new Date()) throw new VideoStudioError("The estimate expired. Review the price again.");
  if (!p.runnable) throw new VideoStudioError(p.blockReason ?? "Cannot run.");
  if ((await textOf(job.id)).textHash !== p.textHash) throw new VideoStudioError("The script changed after the estimate. Review the price again.");
  await assertDiskHeadroom();
  const conf: MotionVoiceConfirmation = { mode: "voice", model: p.model, voice: p.voice, chars: p.chars, estInr: p.estInr, maxInr: p.maxInr, sync: p.sync, stt: p.stt ? { model: p.stt.model, perSecondUsd: p.stt.perSecondUsd, maxInr: p.stt.maxInr, language: p.stt.language } : null, textHash: p.textHash, confirmedAt: new Date().toISOString(), confirmedById: actorId };
  const r = await prisma.videoJob.updateMany({
    where: { id: job.id, status: job.status, updatedAt: job.updatedAt },
    data: { status: "GENERATING_AUDIO", stage: "voice", progressPct: 0, failedStage: null, errorMessage: null, confirmedAt: job.confirmedAt ?? new Date(), confirmedById: job.confirmedById ?? actorId, estimate: { ...e, motionVoicePending: undefined, motionVoice: conf } as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() },
  });
  if (r.count !== 1) throw new VideoStudioError("The video changed while you were confirming. Nothing was started twice.");
  await addEvent(job.id, actorId, "voice_confirmed", `Narration confirmed (₹${p.totalInr.toFixed(2)}, max ₹${p.totalMaxInr.toFixed(2)}) — queued with the render.`);
  kickVideoWorker();
}

/** Free: no narration — words follow reading speed. */
export async function renderMotionSilent(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  assertReviewable(job);
  const fails = (await motionChecks(job)).filter((x) => x.status === "fail");
  if (fails.length) throw new VideoStudioError(`Fix the failed quality checks first: ${fails.map((f) => f.label).join(", ")}.`);
  await assertDiskHeadroom();
  const { textHash } = await textOf(job.id);
  const conf: MotionVoiceConfirmation = { mode: "silent", model: null, voice: null, chars: 0, estInr: 0, maxInr: 0, sync: "reading", stt: null, textHash, confirmedAt: new Date().toISOString(), confirmedById: actorId };
  const r = await prisma.videoJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: job.updatedAt }, data: { status: "GENERATING_AUDIO", stage: "voice", progressPct: 0, failedStage: null, errorMessage: null, confirmedAt: job.confirmedAt ?? new Date(), confirmedById: job.confirmedById ?? actorId, estimate: { ...estOf(job), motionVoicePending: undefined, motionVoice: conf } as unknown as Prisma.InputJsonValue } });
  if (r.count !== 1) throw new VideoStudioError("The video changed meanwhile. Try again.");
  await addEvent(job.id, actorId, "render_queued", "Silent render queued (local, no provider charge).");
  kickVideoWorker();
}

/** Free: render again with the existing narration and timing (style / aspect / frame text changes that keep the sentences). */
export async function rerenderMotion(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  assertReviewable(job);
  const conf = estOf(job).motionVoice;
  if (!conf) throw new VideoStudioError("Confirm the narration (or a silent render) first.");
  const { textHash } = await textOf(job.id);
  if (conf.mode === "voice" && conf.textHash !== textHash) throw new VideoStudioError("The spoken sentences changed — review the narration price again.");
  if (conf.mode === "voice" && !cfgOf(job).take) throw new VideoStudioError("No narration recorded yet.");
  const timed = Boolean(cfgOf(job).timing);
  // A free re-render never makes a paid call: without saved word timing it falls back to estimated sync (the take itself is reused).
  const free: MotionVoiceConfirmation = { ...conf, sync: conf.mode === "voice" ? (timed ? conf.sync : "estimated") : "reading", stt: timed ? conf.stt : null, reuseOnly: true };
  const r = await prisma.videoJob.updateMany({ where: { id: job.id, status: job.status, updatedAt: job.updatedAt }, data: { status: conf.mode === "voice" && timed ? "RENDERING" : "GENERATING_AUDIO", stage: "render", progressPct: 0, failedStage: null, errorMessage: null, estimate: { ...estOf(job), motionVoice: free } as unknown as Prisma.InputJsonValue } });
  if (r.count !== 1) throw new VideoStudioError("The video changed meanwhile. Try again.");
  await addEvent(job.id, actorId, "render_queued", "Re-render queued with the existing narration (free).");
  kickVideoWorker();
}

export async function retryMotion(jobId: unknown, actorId: string): Promise<void> {
  const job = await loadMotionJob(jobId);
  if (job.status !== "FAILED") throw new VideoStudioError("Only a failed video can be retried.");
  if (job.mediaDeletedAt) throw new VideoStudioError("This video's media were deleted by the retention policy — start a new one.");
  const stage = job.failedStage ?? "script";
  if (stage === "script") {
    await prisma.videoJob.update({ where: { id: job.id }, data: { status: "DRAFT", failedStage: null, errorMessage: null, stage: null, estimate: Prisma.DbNull, estTotalInr: null } });
    await addEvent(job.id, actorId, "retry", "Retry: the script step needs a new price confirmation.");
    return;
  }
  if (!estOf(job).motionVoice) throw new VideoStudioError("Confirm the narration (or a silent render) again.");
  await prisma.videoJob.update({ where: { id: job.id }, data: { status: stage === "voice" ? "GENERATING_AUDIO" : "RENDERING", failedStage: null, errorMessage: null, stage: null, progressPct: 0, finishedAt: null } });
  await addEvent(job.id, actorId, "retry", `Retry from the ${stage} step (an existing narration take is reused — no repeated speech charge).`);
  kickVideoWorker();
}
