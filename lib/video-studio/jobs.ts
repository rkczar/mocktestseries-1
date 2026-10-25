import "server-only";
import { Prisma, type VideoJob, type VideoJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cancelQuote, consumeQuote, createQuote, type QuoteView } from "@/lib/ai-engine/quote";
import { getUsdInr } from "@/lib/ai-engine/fx";
import { usdToInr } from "@/lib/ai-engine/config";
import { autoConfigure } from "@/lib/video-studio/autoconfig";
import { DESIGN_MAP } from "@/lib/video-studio/designs";
import { normalizeSkillKeys, composeSkillInstructions } from "@/lib/video-studio/skills";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { deleteJobMedia, freeDiskBytes, jobBytes, listJobFolders, JOB_ID } from "@/lib/video-studio/storage";
import { getVoiceCatalog, speechCostUsd, voicesFor } from "@/lib/video-studio/voices";
import { PLANNING_WPM } from "@/lib/video-studio/text";
import { kickVideoWorker } from "@/lib/video-studio/kick";
import {
  ASPECT_KEYS,
  AUDIENCE_KEYS,
  CANCELLABLE,
  DURATION_LIMITS,
  EDITABLE,
  LANGUAGE_KEYS,
  MEDICAL_VIDEO_TYPES,
  READY_SOURCE_TYPES,
  VIDEO_TYPE_KEYS,
  VIDEO_TYPE_MAP,
  VOICE_STYLES,
  type VideoConfig,
  type VideoSource,
} from "@/lib/video-studio/types";

/**
 * AI Video Studio jobs — the state machine.
 *
 *   DRAFT ──Auto Configure──▶ CONFIGURING ──Review price──▶ AWAITING_CONFIRMATION
 *     ──Confirm & Generate (consumes the one-time quote)──▶ QUEUED ──worker──▶
 *     GENERATING_SCRIPT ─▶ REVIEW_REQUIRED / GENERATING_AUDIO ─▶ RENDERING ─▶ COMPLETED
 *   any unfinished state ──Cancel──▶ CANCELLED;  failures ──▶ FAILED
 *
 * No paid call can start without a consumed quote: confirmation is the only
 * way from AWAITING_CONFIRMATION to QUEUED, and the quote is bound to the
 * admin, the feature and the job id (a replay or a double click finds it USED).
 * Long work never runs inside an HTTP request: the worker picks QUEUED jobs.
 */

export class VideoStudioError extends Error {}

const TEXT_MAX = { title: 120, topic: 300, prompt: 4000, custom: 4000 } as const;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "";
}

export function parseSource(raw: unknown): VideoSource {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const videoType = VIDEO_TYPE_KEYS.find((k) => k === r.videoType);
  if (!videoType) throw new VideoStudioError("Choose a video type.");
  const type = READY_SOURCE_TYPES.find((t) => t === r.type);
  if (!type) throw new VideoStudioError("Unknown source type.");
  const audience = AUDIENCE_KEYS.find((a) => a === r.audience) ?? "mbbs";
  const language = LANGUAGE_KEYS.find((l) => l === r.language) ?? "hinglish";
  const aspect = ASPECT_KEYS.find((a) => a === r.aspect) ?? "9:16";
  const durationSec = typeof r.durationSec === "number" && Number.isFinite(r.durationSec) ? Math.min(DURATION_LIMITS.maxSec, Math.max(DURATION_LIMITS.minSec, Math.round(r.durationSec))) : 0;
  const topic = str(r.topic, TEXT_MAX.topic);
  const prompt = str(r.prompt, TEXT_MAX.prompt);
  const questionIds = Array.isArray(r.questionIds) ? [...new Set(r.questionIds.filter((q): q is string => typeof q === "string" && /^[a-z0-9]{20,40}$/.test(q)))].slice(0, 10) : [];
  const examId = typeof r.examId === "string" && /^[a-z0-9]{20,40}$/.test(r.examId) ? r.examId : null;
  if (type === "topic" && !topic) throw new VideoStudioError("Enter a topic.");
  if (type === "prompt" && !prompt) throw new VideoStudioError("Enter a prompt.");
  if (type === "questions" && !questionIds.length) throw new VideoStudioError("Select at least one question.");
  if (VIDEO_TYPE_MAP[videoType].needs === "pdf" && type !== "pdf") throw new VideoStudioError("PDF to Video needs a PDF as the source.");
  if (VIDEO_TYPE_MAP[videoType].needs === "image" && type !== "image") throw new VideoStudioError("Image to Video needs images as the source.");
  if (VIDEO_TYPE_MAP[videoType].needs === "questions" && type !== "questions") throw new VideoStudioError(`${VIDEO_TYPE_MAP[videoType].label} needs Question Bank questions as the source.`);
  return { type, videoType, audience, language, topic, prompt, questionIds: type === "questions" ? questionIds : [], examId, aspect, durationSec };
}

export async function addEvent(jobId: string, actorId: string | null, type: string, message: string, data?: Prisma.InputJsonValue) {
  await prisma.videoJobEvent.create({ data: { jobId, actorId, type, message: message.slice(0, 500), data } });
}

function checkJobId(id: unknown): string {
  if (typeof id !== "string" || !JOB_ID.test(id)) throw new VideoStudioError("Invalid job id.");
  return id;
}

async function loadJob(id: unknown): Promise<VideoJob> {
  const job = await prisma.videoJob.findUnique({ where: { id: checkJobId(id) } });
  if (!job) throw new VideoStudioError("Video job not found.");
  return job;
}

/** Refuse new work when the disk is below the configured floor (disk exhaustion must never break the site). */
export async function assertDiskHeadroom(): Promise<void> {
  const settings = await getVideoSettings();
  const free = await freeDiskBytes();
  if (free < settings.minFreeDiskGb * 1024 ** 3) {
    throw new VideoStudioError(`Not enough free disk space (${(free / 1024 ** 3).toFixed(1)} GB free, minimum ${settings.minFreeDiskGb} GB). Clean up old video jobs first.`);
  }
}

function defaultTitle(s: VideoSource): string {
  const what = s.type === "questions" ? `${s.questionIds.length} question${s.questionIds.length > 1 ? "s" : ""}` : s.topic || s.prompt;
  return `${VIDEO_TYPE_MAP[s.videoType].label}: ${what}`.slice(0, TEXT_MAX.title);
}

export async function createJob(input: { source: unknown; customPrompt?: unknown; title?: unknown }, actorId: string): Promise<VideoJob> {
  const source = parseSource(input.source);
  await assertDiskHeadroom();
  const job = await prisma.videoJob.create({
    data: {
      kind: "GENERATE",
      title: str(input.title, TEXT_MAX.title) || defaultTitle(source),
      source: source as unknown as Prisma.InputJsonValue,
      customPrompt: str(input.customPrompt, TEXT_MAX.custom) || null,
      examId: source.examId,
      createdById: actorId,
    },
  });
  await addEvent(job.id, actorId, "created", "Job created.");
  return job;
}

function assertEditable(job: VideoJob) {
  if (!(EDITABLE as readonly string[]).includes(job.status)) throw new VideoStudioError("This job can no longer be changed (generation has started or finished).");
}

async function dropOpenEstimate(job: VideoJob, actorId: string) {
  const est = job.estimate as { quoteId?: string } | null;
  if (est?.quoteId) await cancelQuote(est.quoteId, actorId);
}

/** Auto Configure AI: free, deterministic, overwrites the proposal (the admin's custom prompt is kept). */
export async function runAutoConfigure(jobId: unknown, actorId: string, opts: { skillKeys?: unknown; designKey?: unknown; source?: unknown; customPrompt?: unknown } = {}): Promise<VideoJob> {
  const job = await loadJob(jobId);
  assertEditable(job);
  const source = opts.source !== undefined ? parseSource(opts.source) : (job.source as unknown as VideoSource);
  const customPrompt = opts.customPrompt !== undefined ? str(opts.customPrompt, TEXT_MAX.custom) : (job.customPrompt ?? "");
  if (source.type === "pdf" || source.type === "image") {
    const ready = (Array.isArray(job.assets) ? (job.assets as { kind?: string; state?: string }[]) : []).filter((a) => a.kind === source.type && a.state === "ready");
    if (!ready.length) throw new VideoStudioError(source.type === "pdf" ? "Upload the PDF first." : "Upload at least one image or screenshot first.");
  }
  const config = await autoConfigure({
    source,
    customPrompt,
    skillKeys: Array.isArray(opts.skillKeys) ? (opts.skillKeys as string[]) : undefined,
    designKey: typeof opts.designKey === "string" ? opts.designKey : null,
  });
  await dropOpenEstimate(job, actorId);
  const updated = await prisma.videoJob.update({
    where: { id: job.id },
    data: {
      status: "CONFIGURING",
      source: source as unknown as Prisma.InputJsonValue,
      customPrompt: customPrompt || null,
      config: config as unknown as Prisma.InputJsonValue,
      skills: composeSkillInstructions(config.skillKeys).versions,
      examLabel: config.examLabel,
      examId: source.examId,
      estimate: Prisma.DbNull,
      estTotalInr: null,
      lastActivityAt: new Date(),
    },
  });
  await addEvent(job.id, actorId, "configured", `Auto Configure: ${config.runnable ? "ready" : `blocked — ${config.blockers.join(" ")}`}`);
  return updated;
}

/** The admin's edits to the proposal. Unknown fields are ignored; every value is validated. */
export async function updateConfig(jobId: unknown, patch: unknown, actorId: string): Promise<VideoJob> {
  const job = await loadJob(jobId);
  assertEditable(job);
  const cfg = job.config as unknown as VideoConfig | null;
  if (!cfg) throw new VideoStudioError("Run Auto Configure first.");
  const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
  const next: VideoConfig = { ...cfg };
  const medical = MEDICAL_VIDEO_TYPES.includes(cfg.videoType);
  if (p.skillKeys !== undefined) next.skillKeys = normalizeSkillKeys(p.skillKeys, medical);
  if (typeof p.designKey === "string") {
    const d = DESIGN_MAP[p.designKey];
    if (!d || d.status !== "ready") throw new VideoStudioError("That design is not available yet.");
    if (!d.aspects.includes(next.aspect)) throw new VideoStudioError(`${d.name} does not support ${next.aspect}.`);
    next.designKey = d.key;
  }
  if (typeof p.aspect === "string") {
    const a = ASPECT_KEYS.find((k) => k === p.aspect);
    if (!a) throw new VideoStudioError("Unsupported aspect ratio.");
    if (!DESIGN_MAP[next.designKey].aspects.includes(a)) throw new VideoStudioError(`The selected design does not support ${a}.`);
    next.aspect = a;
  }
  if (typeof p.durationSec === "number" && Number.isFinite(p.durationSec)) {
    next.durationSec = Math.min(DURATION_LIMITS.maxSec, Math.max(DURATION_LIMITS.minSec, Math.round(p.durationSec)));
    next.sceneCount = Math.min(12, Math.max(4, Math.round(next.durationSec / 7)));
  }
  if (typeof p.language === "string") {
    const l = LANGUAGE_KEYS.find((k) => k === p.language);
    if (!l) throw new VideoStudioError("Unsupported language.");
    next.language = l;
  }
  if (typeof p.voiceStyle === "string") {
    if (!VOICE_STYLES.some((v) => v.key === p.voiceStyle)) throw new VideoStudioError("Unknown voice style.");
    next.voiceStyle = p.voiceStyle as VideoConfig["voiceStyle"];
  }
  if (p.voiceId !== undefined || p.speechModel !== undefined) {
    const catalog = await getVoiceCatalog();
    const model = typeof p.speechModel === "string" ? p.speechModel : next.speechModel;
    const m = catalog.models.find((x) => x.id === model && catalog.approvedModels.includes(x.id));
    if (!m) throw new VideoStudioError("That speech model is not approved in Voice Studio.");
    const voice = typeof p.voiceId === "string" ? p.voiceId : next.voiceId;
    if (!voice || !voicesFor(m, next.language).includes(voice)) throw new VideoStudioError("That voice is not available for this model and language.");
    next.speechModel = m.id;
    next.voiceId = voice;
  }
  for (const k of ["subtitles", "branding"] as const) if (typeof p[k] === "boolean") next[k] = p[k] as boolean;
  if (p.music === false) Object.assign(next, { music: false, musicKey: null });
  if (p.subtitleStyle === "clean" || p.subtitleStyle === "highlight" || p.subtitleStyle === "boxed") next.subtitleStyle = p.subtitleStyle;
  if (typeof p.cta === "string") next.cta = str(p.cta, 80);
  if (p.examLabel === null) next.examLabel = null;
  else if (typeof p.examLabel === "string") {
    // Only a real exam name may be used as the label (never free text that could mislabel content).
    const exam = await prisma.exam.findFirst({ where: { name: p.examLabel }, select: { name: true } });
    if (!exam) throw new VideoStudioError("The exam label must be the name of a configured exam.");
    next.examLabel = exam.name;
  }
  let customPrompt = job.customPrompt;
  if (typeof p.customPrompt === "string") customPrompt = str(p.customPrompt, TEXT_MAX.custom) || null;
  await dropOpenEstimate(job, actorId);
  const updated = await prisma.videoJob.update({
    where: { id: job.id },
    data: {
      status: "CONFIGURING",
      config: next as unknown as Prisma.InputJsonValue,
      skills: composeSkillInstructions(next.skillKeys).versions,
      examLabel: next.examLabel,
      customPrompt,
      estimate: Prisma.DbNull,
      estTotalInr: null,
      lastActivityAt: new Date(),
    },
  });
  await addEvent(job.id, actorId, "config_edited", "Configuration edited.");
  return updated;
}

export interface EstimateLine {
  key: "script" | "voice" | "images" | "transcription" | "render";
  label: string;
  /** included = part of this confirmation; later = runs as a later stage with its own estimate; none = no provider charge; unavailable = capability missing. */
  state: "included" | "later" | "none" | "unavailable";
  inr: number | null;
  maxInr: number | null;
  detail: string;
}

export interface JobEstimate {
  quoteId: string | null;
  lines: EstimateLine[];
  totalInr: number | null;
  totalMaxInr: number | null;
  runnable: boolean;
  blockReason: string | null;
  notes: string[];
  model: string | null;
  createdAt: string;
  expiresAt: string | null;
  fxRate: number | null;
}

/** Average characters per spoken word, used to turn the planned duration into billable characters. */
const CHARS_PER_WORD = { en: 6, hi: 5.5, hinglish: 5.8 } as const;

export async function requestEstimate(jobId: unknown, actorId: string): Promise<VideoJob> {
  const job = await loadJob(jobId);
  assertEditable(job);
  const cfg = job.config as unknown as VideoConfig | null;
  if (!cfg) throw new VideoStudioError("Run Auto Configure first.");
  await dropOpenEstimate(job, actorId);
  const lines: EstimateLine[] = [];
  const notes: string[] = [];

  let quote: QuoteView | null = null;
  try {
    quote = await createQuote({ feature: "video_script", action: "video_script", context: { jobId: job.id }, actorId });
  } catch (error) {
    notes.push(error instanceof Error ? error.message : "The script cost could not be estimated.");
  }
  lines.push({
    key: "script",
    label: "Script (text AI)",
    state: quote?.runnable ? "included" : "unavailable",
    inr: quote?.totalInr ?? null,
    maxInr: quote?.totalMaxInr ?? null,
    detail: quote ? (quote.runnable ? `${quote.model} · ~${quote.estInputTokens} input / up to ${quote.maxOutputTokens} output tokens` : (quote.blockReason ?? "Not runnable.")) : "No estimate.",
  });
  if (quote) notes.push(...quote.notes);

  // Voice: estimated from the planned narration length; generated as the next stage after the script is reviewed.
  const catalog = await getVoiceCatalog();
  const m = cfg.speechModel ? catalog.models.find((x) => x.id === cfg.speechModel && catalog.approvedModels.includes(x.id)) : undefined;
  if (m) {
    const words = (cfg.durationSec / 60) * PLANNING_WPM[cfg.language];
    const chars = Math.ceil(words * CHARS_PER_WORD[cfg.language]);
    const { usd, note } = speechCostUsd(m, chars, cfg.durationSec);
    const fx = await getUsdInr();
    const inr = usd === null ? null : usdToInr(usd, fx.rate);
    lines.push({ key: "voice", label: "Voice narration", state: "later", inr, maxInr: inr === null ? null : inr * 1.5, detail: `${m.name} · ~${chars} characters for ${cfg.durationSec}s. Generated after you approve the script (one more confirmation with the exact character count).` });
    if (note) notes.push(note);
  } else {
    lines.push({ key: "voice", label: "Voice narration", state: "unavailable", inr: null, maxInr: null, detail: "No approved speech model yet (Voice Studio). The script can still be written and reviewed." });
  }
  lines.push({ key: "images", label: "AI images", state: "none", inr: 0, maxInr: 0, detail: "Not used — diagrams are drawn from text; uploaded images / PDF pages are shown as they are." });
  lines.push({ key: "transcription", label: "Transcription / alignment", state: "none", inr: 0, maxInr: 0, detail: "Not needed for generated videos (subtitles come from the script)." });
  lines.push({ key: "render", label: "Rendering (local worker)", state: "none", inr: 0, maxInr: 0, detail: "No provider charge; uses this server's CPU. Render time is shown after the first measured render." });

  const included = lines.filter((l) => l.state === "included");
  const unknown = included.some((l) => l.inr === null);
  const totalInr = included.length && !unknown ? included.reduce((a, l) => a + (l.inr ?? 0), 0) : null;
  const totalMaxInr = included.length && included.every((l) => l.maxInr !== null) ? included.reduce((a, l) => a + (l.maxInr ?? 0), 0) : null;
  if (unknown && quote?.provider === "legacy") notes.push("The script uses the legacy provider route, which reports no cost: the total cannot be estimated (it is not ₹0).");
  const runnable = Boolean(quote?.runnable) && cfg.runnable;
  const blockReason = runnable ? null : (quote?.blockReason ?? cfg.blockers[0] ?? "The configuration is not ready.");

  const estimate: JobEstimate = {
    quoteId: quote?.runnable ? quote.id : null,
    lines,
    totalInr,
    totalMaxInr,
    runnable,
    blockReason,
    notes: [...new Set(notes)],
    model: quote?.model ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: quote?.expiresAt ?? null,
    fxRate: quote?.fxRate ?? null,
  };
  const updated = await prisma.videoJob.update({
    where: { id: job.id },
    data: { status: "AWAITING_CONFIRMATION", estimate: estimate as unknown as Prisma.InputJsonValue, estTotalInr: totalInr, lastActivityAt: new Date() },
  });
  await addEvent(job.id, actorId, "estimated", totalInr === null ? "Estimate shown (total unknown)." : `Estimate shown: ₹${totalInr.toFixed(2)} (max ₹${(totalMaxInr ?? totalInr).toFixed(2)}).`);
  return updated;
}

/** Confirm & Generate: the ONLY way to QUEUED. Consumes the job's one-time quote atomically. */
export async function confirmJob(jobId: unknown, actorId: string, quoteId: unknown): Promise<VideoJob> {
  const job = await loadJob(jobId);
  if (job.status !== "AWAITING_CONFIRMATION") throw new VideoStudioError(job.status === "QUEUED" ? "This job is already confirmed." : "Review the estimated price first.");
  const est = job.estimate as unknown as JobEstimate | null;
  if (!est?.runnable || !est.quoteId) throw new VideoStudioError(est?.blockReason ?? "This configuration cannot run yet.");
  if (quoteId !== est.quoteId) throw new VideoStudioError("The confirmed estimate does not match the latest estimate. Review the price again.");
  await assertDiskHeadroom();
  await consumeQuote({ quoteId, actorId, feature: "video_script", action: "video_script", context: { jobId: job.id } });
  const claimed = await prisma.videoJob.updateMany({
    where: { id: job.id, status: "AWAITING_CONFIRMATION" },
    data: { status: "QUEUED", confirmedAt: new Date(), confirmedById: actorId, quoteIds: { push: est.quoteId }, lastActivityAt: new Date() },
  });
  if (claimed.count !== 1) throw new VideoStudioError("This job changed while you were confirming. Nothing was started twice.");
  await addEvent(job.id, actorId, "confirmed", "Cost confirmed — queued for script generation.");
  kickVideoWorker();
  return prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
}

export async function cancelJob(jobId: unknown, actorId: string): Promise<VideoJob> {
  const job = await loadJob(jobId);
  if (!(CANCELLABLE as readonly string[]).includes(job.status)) throw new VideoStudioError("This job has already finished.");
  await dropOpenEstimate(job, actorId);
  const claimed = await prisma.videoJob.updateMany({
    where: { id: job.id, status: { in: [...CANCELLABLE] as VideoJobStatus[] } },
    data: { status: "CANCELLED", cancelledAt: new Date(), lastActivityAt: new Date() },
  });
  if (claimed.count !== 1) throw new VideoStudioError("This job finished while you were cancelling it.");
  await addEvent(job.id, actorId, "cancelled", "Cancelled by admin. Media are removed by cleanup once no worker holds the job.");
  // Nothing holds the job → delete its media now (a running worker re-checks the status and stops).
  if (!job.leaseUntil || job.leaseUntil < new Date()) await purgeMedia(job.id, "cancelled");
  return prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function purgeMedia(jobId: string, reason: string): Promise<number> {
  const bytes = await deleteJobMedia(jobId);
  await prisma.videoJob.update({ where: { id: jobId }, data: { mediaDeletedAt: new Date(), storageBytes: 0 } });
  await addEvent(jobId, null, "media_deleted", `Media deleted (${reason}).`, { bytes });
  return bytes;
}

export async function markDelivered(jobId: string, actorId: string, how: "download" | "publish"): Promise<void> {
  const res = await prisma.videoJob.updateMany({ where: { id: jobId, deliveredAt: null }, data: { deliveredAt: new Date(), lastActivityAt: new Date() } });
  if (res.count) await addEvent(jobId, actorId, "delivered", how === "download" ? "First download completed." : "Published.");
}

// ---- Cleanup policy ---------------------------------------------------------------------------

export interface CleanupCandidate {
  jobId: string;
  reason: string;
  /** true = also mark the job CANCELLED (abandoned before confirmation). */
  abandon: boolean;
}

/**
 * Pure decision: which jobs' media may be deleted now (never while a worker
 * holds the job). Retention policy (docs/ai-video-studio/RETENTION.md):
 *   - every job: at most `maxRetentionDays` after creation, whatever its state;
 *   - cancelled: at once;
 *   - failed: `failedRetentionHours` after the failure (time to Retry);
 *   - completed: `deliveredRetentionHours` after the first download, else `undeliveredRetentionHours` after finishing;
 *   - waiting for review (script / storyboard / edit) with no activity: `undeliveredRetentionHours`;
 *   - drafts never confirmed: abandoned (cancelled) after `abandonedAfterHours` without activity.
 */
export function decideCleanup(
  jobs: Pick<VideoJob, "id" | "status" | "leaseUntil" | "deliveredAt" | "finishedAt" | "lastActivityAt" | "expiresAt" | "mediaDeletedAt" | "createdAt">[],
  s: { deliveredRetentionHours: number; undeliveredRetentionHours: number; abandonedAfterHours: number; failedRetentionHours: number; maxRetentionDays: number },
  now = new Date()
): CleanupCandidate[] {
  const h = (n: number) => n * 3600_000;
  const out: CleanupCandidate[] = [];
  for (const j of jobs) {
    if (j.mediaDeletedAt) continue;
    if (j.leaseUntil && j.leaseUntil > now) continue;
    const t = now.getTime();
    if (j.createdAt.getTime() + h(s.maxRetentionDays * 24) <= t) out.push({ jobId: j.id, reason: `maximum retention (${s.maxRetentionDays} days) reached`, abandon: (EDITABLE as readonly string[]).includes(j.status) });
    else if (j.expiresAt && j.expiresAt.getTime() <= t) out.push({ jobId: j.id, reason: "retention period expired", abandon: (EDITABLE as readonly string[]).includes(j.status) });
    else if (j.status === "CANCELLED") out.push({ jobId: j.id, reason: "cancelled", abandon: false });
    // Failed: kept for the undelivered window so Retry can resume from the failed step (finished steps are not paid twice).
    else if (j.status === "FAILED" && (j.finishedAt ?? j.lastActivityAt).getTime() + h(s.failedRetentionHours) <= t) out.push({ jobId: j.id, reason: "failed and not retried within the retention period", abandon: false });
    else if (j.status === "COMPLETED" && j.deliveredAt && j.deliveredAt.getTime() + h(s.deliveredRetentionHours) <= t) out.push({ jobId: j.id, reason: "delivered and retention passed", abandon: false });
    else if (j.status === "COMPLETED" && !j.deliveredAt && (j.finishedAt?.getTime() ?? t) + h(s.undeliveredRetentionHours) <= t) out.push({ jobId: j.id, reason: "not downloaded within the retention period", abandon: false });
    else if (j.status === "REVIEW_REQUIRED" && j.lastActivityAt.getTime() + h(s.undeliveredRetentionHours) <= t) out.push({ jobId: j.id, reason: "no activity while waiting for review", abandon: false });
    else if ((EDITABLE as readonly string[]).includes(j.status) && j.lastActivityAt.getTime() + h(s.abandonedAfterHours) <= t) out.push({ jobId: j.id, reason: "abandoned before confirmation", abandon: true });
  }
  return out;
}

export interface CleanupReport {
  deletedJobs: number;
  abandoned: number;
  orphanFolders: number;
  bytesFreed: number;
}

/** Runs the policy + orphan sweep. Called by the worker cron and by the admin's "Run cleanup now". */
export async function runCleanup(actorId: string | null): Promise<CleanupReport> {
  const settings = await getVideoSettings();
  const jobs = await prisma.videoJob.findMany({
    where: { mediaDeletedAt: null },
    select: { id: true, status: true, leaseUntil: true, deliveredAt: true, finishedAt: true, lastActivityAt: true, expiresAt: true, mediaDeletedAt: true, createdAt: true },
  });
  const report: CleanupReport = { deletedJobs: 0, abandoned: 0, orphanFolders: 0, bytesFreed: 0 };
  for (const c of decideCleanup(jobs, settings)) {
    if (c.abandon) {
      const r = await prisma.videoJob.updateMany({ where: { id: c.jobId, status: { in: [...EDITABLE] as VideoJobStatus[] } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      if (r.count) {
        report.abandoned++;
        const j = await prisma.videoJob.findUnique({ where: { id: c.jobId }, select: { estimate: true } });
        const q = (j?.estimate as { quoteId?: string } | null)?.quoteId;
        if (q) await prisma.aiCostQuote.updateMany({ where: { id: q, status: "OPEN" }, data: { status: "CANCELLED" } });
        await addEvent(c.jobId, actorId, "abandoned", "Marked abandoned (no activity before confirmation).");
      }
    }
    // A job still queued or running when the hard cap hits cannot continue without its files.
    const stuck = await prisma.videoJob.updateMany({ where: { id: c.jobId, status: { in: ["QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { status: "FAILED", failedStage: "retention", errorMessage: `Files deleted: ${c.reason}.`, finishedAt: new Date() } });
    if (stuck.count) await addEvent(c.jobId, actorId, "failed", `Stopped: ${c.reason}.`);
    report.bytesFreed += await purgeMedia(c.jobId, c.reason);
    report.deletedJobs++;
  }
  // Orphans: folders with no job row, or whose job's media were already deleted. Non-job entries are reported, not touched.
  const folders = await listJobFolders();
  const valid = folders.filter((f) => f.valid).map((f) => f.name);
  if (valid.length) {
    const known = new Map((await prisma.videoJob.findMany({ where: { id: { in: valid } }, select: { id: true, mediaDeletedAt: true } })).map((j) => [j.id, j]));
    for (const name of valid) {
      const j = known.get(name);
      if (!j || j.mediaDeletedAt) {
        report.bytesFreed += await deleteJobMedia(name);
        report.orphanFolders++;
      }
    }
  }
  return report;
}

export async function refreshStorageBytes(jobId: string): Promise<number> {
  const bytes = await jobBytes(jobId);
  await prisma.videoJob.update({ where: { id: jobId }, data: { storageBytes: BigInt(bytes) } });
  return bytes;
}

/** Skill instructions + versions for a job (used by the script stage). */
export function jobSkillPrompt(cfg: VideoConfig): string {
  return composeSkillInstructions(cfg.skillKeys).text;
}
