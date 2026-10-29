import "server-only";
import crypto from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { Prisma, type VideoJob, type VideoJobStatus, type VideoScene } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AiEngineFailure, generateTextViaOpenRouter } from "@/lib/ai-engine/engine";
import { aiErrorCode } from "@/lib/ai-engine/errors";
import { ENGINE_FEATURE_MAP } from "@/lib/ai-engine/config";
import { textCandidates } from "@/lib/ai-engine/router";
import { synthesizeSpeech, transcribeAudio } from "@/lib/ai-engine/speech";
import type { ChatContentPart } from "@/lib/ai-engine/openrouter";
import { pageText, renderPage } from "@/lib/ai-import/pdf";
import { DESIGN_MAP } from "@/lib/video-studio/designs";
import { composeSkillInstructions } from "@/lib/video-studio/skills";
import { getVideoSettings, type VideoStudioSettings } from "@/lib/video-studio/settings";
import { getVoiceCatalog, speechCostUsd } from "@/lib/video-studio/voices";
import { unsupportedVideoChars } from "@/lib/video-studio/glyphs";
import { sceneDocument, type SceneVisual } from "@/lib/video-studio/template";
import { overlayDocument, subtitleDocument } from "@/lib/video-studio/editor-docs";
import { cuesFromSegments, cuesFromWords, defaultProject, outputCues, outputDuration, parseEditProject, sfxRenderList, type EditAsset, type EditProject } from "@/lib/video-studio/editor-model";
import { buildScriptPrompt, extractJson, parseScene, parseScript, plainQuestionText, throwingCheck, type ScriptMaterial, type SourceQuestion } from "@/lib/video-studio/script";
import { RENDER_FONT_BASE, RENDER_FONT_ORIGIN } from "@/lib/video-studio/render-manifest";
import { RenderError, killStrayContainers, renderImageId, renderToolchain, runRenderTask } from "@/lib/video-studio/render-runner";
import { addAsset, imageDataUri, patchAsset, readAssets, staleUploadParts, type JobAsset } from "@/lib/video-studio/assets";
import { resolveJobPath, ensureJobDir } from "@/lib/video-studio/storage";
import { WORKER_STATUS_KEY } from "@/lib/video-studio/worker-status";
import { addEvent, refreshStorageBytes, runCleanup } from "@/lib/video-studio/jobs";
import { graphemes } from "@/lib/video-studio/text";
import { ASPECT_MAP, type VideoConfig, type VideoSource } from "@/lib/video-studio/types";

/**
 * AI Video Studio worker — every long or paid step runs HERE, in the
 * separate low-priority worker process (scripts/video-worker.ts), never in a
 * web request. One worker at a time (flock), one job at a time, leased.
 *
 * GENERATE jobs
 *   QUEUED            → script (paid, consumes the confirmed quote) → REVIEW_REQUIRED
 *   REVIEW_REQUIRED   + a scene with a confirmed regeneration → that scene rewritten
 *   GENERATING_AUDIO  → narration per scene (paid, confirmed voice estimate) → RENDERING
 *   RENDERING         → isolated render container → validated MP4 → COMPLETED
 * EDIT jobs
 *   QUEUED            → probe + preview proxy + thumbnails of uploads → REVIEW_REQUIRED (ready to edit)
 *   GENERATING_AUDIO  → transcription (paid, confirmed) → subtitles → REVIEW_REQUIRED
 *   RENDERING         → export in the render container → COMPLETED
 * MOTION jobs (Motion Workflow Studio — lib/video-studio/motion/pipeline.ts)
 *   QUEUED            → script + storyboard (paid, confirmed quote) → REVIEW_REQUIRED
 *   GENERATING_AUDIO  → one narration take (+ optional word timestamps) → RENDERING
 *   RENDERING         → word-timed motion frames in the render container → COMPLETED
 *
 * Live CBT protection: nothing starts while a Live CBT is running or starts
 * within 15 minutes, and a running render is stopped and re-queued if one
 * begins. Cancellation is checked between steps and every 2 s during renders.
 * A crash leaves a lease that expires; the next run resumes (voice skips
 * scenes that already have matching audio; a script call that was in flight
 * is NOT repeated — it needs a new confirmation).
 */

const LEASE_MS = 10 * 60_000;
const WORKER_ID = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

class Paused extends Error {}
class StageFailure extends Error {
  constructor(
    message: string,
    readonly stage: string
  ) {
    super(message);
  }
}

export async function liveCbtRunning(): Promise<boolean> {
  const now = new Date();
  const n = await prisma.liveTest.count({ where: { OR: [{ status: "LIVE" }, { status: "SCHEDULED", startAt: { lte: new Date(now.getTime() + 15 * 60_000) }, endAt: { gte: now } }] } });
  return n > 0;
}

async function lease(jobId: string): Promise<boolean> {
  const r = await prisma.videoJob.updateMany({
    where: { id: jobId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }, { leaseOwner: WORKER_ID }] },
    data: { leaseOwner: WORKER_ID, leaseUntil: new Date(Date.now() + LEASE_MS), heartbeatAt: new Date() },
  });
  return r.count === 1;
}

async function release(jobId: string) {
  await prisma.videoJob.updateMany({ where: { id: jobId, leaseOwner: WORKER_ID }, data: { leaseOwner: null, leaseUntil: null } });
}

/** Status change only while this worker leases the job and it is still in an expected state (a cancel is never overwritten). */
async function transition(jobId: string, from: VideoJobStatus[], data: Prisma.VideoJobUpdateManyMutationInput): Promise<boolean> {
  const r = await prisma.videoJob.updateMany({ where: { id: jobId, status: { in: from }, leaseOwner: WORKER_ID }, data: { ...data, lastActivityAt: new Date() } });
  return r.count === 1;
}

async function progress(jobId: string, stage: string, pct: number) {
  await prisma.videoJob.updateMany({ where: { id: jobId, leaseOwner: WORKER_ID }, data: { stage, progressPct: Math.max(0, Math.min(100, Math.round(pct))), heartbeatAt: new Date(), leaseUntil: new Date(Date.now() + LEASE_MS) } });
}

async function cancelled(jobId: string): Promise<boolean> {
  const j = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { status: true } });
  return !j || j.status === "CANCELLED";
}

/** Live CBT check between paid / heavy steps: stop here and resume later. */
async function checkpoint(jobId: string) {
  if (await cancelled(jobId)) throw new Paused("cancelled");
  if (await liveCbtRunning()) throw new Paused("live");
}

/** Sum of the job's own ledger rows (script quotes + "video:<id>" voice / transcription rows). */
export async function recomputeJobCost(jobId: string): Promise<void> {
  const job = await prisma.videoJob.findUnique({ where: { id: jobId }, select: { quoteIds: true } });
  if (!job) return;
  const rows = await prisma.aiGatewayCall.findMany({ where: { quoteId: { in: [...job.quoteIds, `video:${jobId}`] } }, select: { actualCostInr: true, costStatus: true } });
  const actual = rows.reduce((a, r) => a + (r.actualCostInr ?? 0), 0);
  const unknown = rows.filter((r) => r.costStatus === "unknown" || r.costStatus === "pending").length;
  await prisma.videoJob.update({ where: { id: jobId }, data: { actualInr: Math.round(actual * 10000) / 10000, unknownCostCalls: unknown } });
}

function strip(text: string): string {
  const bad = unsupportedVideoChars(text);
  if (!bad.length) return text;
  const set = new Set(bad);
  return graphemes(text)
    .filter((g) => !set.has(g))
    .join("")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function renderLimits(s: VideoStudioSettings) {
  return { cpus: s.renderCpus, memoryMb: s.renderMemoryMb };
}

// ---- material for the script --------------------------------------------------------------

async function loadQuestions(ids: string[]): Promise<SourceQuestion[]> {
  if (!ids.length) return [];
  const rows = await prisma.question.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, text: true, explanation: true, options: { select: { label: true, text: true, isCorrect: true, order: true }, orderBy: { order: "asc" } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => {
      const correct = r.options.filter((o) => o.isCorrect);
      return {
        id: r.id,
        code: r.code,
        stem: plainQuestionText(r.text),
        options: r.options.map((o) => ({ label: o.label.trim().slice(0, 3) || "?", text: plainQuestionText(o.text) })),
        // Exactly one stored correct option = an answer we can show; none or several = never revealed.
        correctLabel: correct.length === 1 ? correct[0].label.trim().slice(0, 3) : null,
        explanation: r.explanation ? plainQuestionText(r.explanation).slice(0, 1200) : null,
      };
    });
}

async function gatherMaterial(job: VideoJob, source: VideoSource): Promise<{ material: ScriptMaterial; content: ChatContentPart[] | null }> {
  const assets = readAssets(job).filter((a) => a.state === "ready");
  const material: ScriptMaterial = { topic: source.topic, prompt: source.prompt, customInstructions: job.customPrompt ?? "", questions: await loadQuestions(source.questionIds), documentText: "", assets: [], attachedImages: 0 };
  // PDFs: text of the selected pages (≤ 20 pages, ≤ 14 000 characters) + page images the script may show.
  let budget = 14_000;
  const docs: string[] = [];
  for (const a of assets.filter((x) => x.kind === "pdf")) {
    const file = await resolveJobPath(job.id, a.key, true);
    const pages = (a.selectedPages?.length ? a.selectedPages : Array.from({ length: Math.min(a.pages ?? 1, 20) }, (_, i) => i + 1)).filter((p) => p >= 1 && p <= (a.pages ?? 1)).slice(0, 20);
    for (const p of pages) {
      if (budget <= 0) break;
      const t = (await pageText(file, p).catch(() => "")).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (!t) continue;
      const piece = `[${a.name} — page ${p}]\n${t}`.slice(0, budget);
      docs.push(piece);
      budget -= piece.length;
    }
    // Page images (selected pages, at most 6) become assets the script may put on screen.
    for (const p of pages.slice(0, 6)) {
      const key = `inputs/pdfpage-${a.key.split("-").pop()!.split(".")[0]}-p${p}.jpg`;
      const existing = readAssets(await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id }, select: { assets: true } })).find((x) => x.key === key);
      if (!existing) {
        try {
          const png = await renderPage(file, p, 110);
          const { default: sharp } = await import("sharp");
          const jpg = await sharp(png).resize({ width: 1600, height: 1600, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
          await writeFile(await resolveJobPath(job.id, key), jpg);
          await addAsset(job.id, { key, kind: "image", name: `${a.name} — page ${p}`, bytes: jpg.length, state: "ready", addedAt: new Date().toISOString() });
        } catch {
          continue;
        }
      }
      material.assets.push({ key, label: `${a.name} — page ${p}` });
    }
  }
  if (!docs.length && assets.some((a) => a.kind === "pdf")) throw new StageFailure("The PDF has no extractable text on the selected pages (it may be scanned). Upload page screenshots as images instead.", "script");
  material.documentText = docs.join("\n\n");
  // Images / screenshots: shown to the model (vision) and available on screen.
  const images = assets.filter((a) => a.kind === "image" && !a.key.startsWith("inputs/pdfpage-"));
  const content: ChatContentPart[] = [];
  for (const img of images.slice(0, 6)) {
    material.assets.push({ key: img.key, label: img.name });
    const uri = await imageDataUri(job.id, img.key, 1280);
    if (uri) content.push({ type: "image_url", image_url: { url: uri, detail: "high" } });
  }
  material.attachedImages = content.length;
  return { material, content: content.length ? content : null };
}

/** The cheapest approved model for the script that ALSO accepts images (only needed for image sources). */
async function visionModel(medical: boolean): Promise<string> {
  const def = ENGINE_FEATURE_MAP.video_script;
  const cands = await textCandidates("video_script", def.typicalInputTokens + 3000, def.defaultMaxOutputTokens, 2000);
  const v = cands.find((c) => c.model.inputModalities.includes("image"));
  if (!v) throw new StageFailure(`No approved${medical ? ", medically approved" : ""} text model accepts images. Approve one with image input in AI → Models, or use a PDF / topic source.`, "script");
  return v.model.id;
}

// ---- GENERATE: script ------------------------------------------------------------------------

async function runScript(job: VideoJob) {
  if (!(await transition(job.id, ["QUEUED"], { status: "GENERATING_SCRIPT", stage: "script", progressPct: 5, failedStage: null, errorMessage: null }))) return;
  const cfg = job.config as unknown as VideoConfig;
  const source = job.source as unknown as VideoSource;
  const settings = await getVideoSettings();
  const { material, content } = await gatherMaterial(job, source);
  await progress(job.id, "script", 15);
  const prompt = buildScriptPrompt(cfg, material, composeSkillInstructions(cfg.skillKeys).text, { brandCta: settings.brand.cta, designName: DESIGN_MAP[cfg.designKey]?.name ?? cfg.designKey });
  const quoteId = job.quoteIds[job.quoteIds.length - 1] ?? null;
  const modelOverride = content ? await visionModel(true) : null;
  await addEvent(job.id, null, "script_started", `Writing the script${modelOverride ? ` (image source → ${modelOverride})` : ""}.`);
  const r = await generateTextViaOpenRouter(
    "video_script",
    prompt,
    // Checked inside the engine: an unusable script (verdict, prose, cut off, no scenes) moves to the next model.
    { temperature: 0.5, maxOutputTokens: ENGINE_FEATURE_MAP.video_script.defaultMaxOutputTokens, json: true, check: throwingCheck((t) => parseScript(t, cfg, material, strip)) },
    { actorId: job.confirmedById, quoteId, modelOverride },
    content ? { content: [{ type: "text", text: prompt }, ...content] } : {}
  );
  await recomputeJobCost(job.id);
  let parsed;
  try {
    parsed = parseScript(r.text, cfg, material, strip);
  } catch (e) {
    throw new StageFailure(`The model's script could not be used: ${e instanceof Error ? e.message : "invalid answer"}. Retry needs a new price confirmation.`, "script");
  }
  if (await cancelled(job.id)) return;
  await prisma.$transaction([
    prisma.videoScene.deleteMany({ where: { jobId: job.id } }),
    prisma.videoScene.createMany({
      data: parsed.scenes.map((s, i) => ({ jobId: job.id, index: i, narration: s.narration, onScreenText: s.onScreenText, visual: (s.visual ?? Prisma.DbNull) as Prisma.InputJsonValue, durationSec: s.durationSec, needsReview: s.needsReview, reviewNote: s.reviewNote, assetKey: s.assetKey })),
    }),
  ]);
  const nextCfg = { ...cfg, caption: parsed.caption, scriptModel: r.model } as VideoConfig & { caption: string; scriptModel: string };
  await transition(job.id, ["GENERATING_SCRIPT"], { status: "REVIEW_REQUIRED", stage: null, progressPct: 100, config: nextCfg as unknown as Prisma.InputJsonValue });
  const flagged = parsed.scenes.filter((s) => s.needsReview).length;
  await addEvent(job.id, null, "script_ready", `Script ready: ${parsed.scenes.length} scenes by ${r.model}${flagged ? `, ${flagged} flagged for review` : ""}.${parsed.warnings.length ? ` ${parsed.warnings.join(" ")}` : ""}`);
}

async function runSceneRegen(job: VideoJob, scene: VideoScene) {
  const cfg = job.config as unknown as VideoConfig;
  const source = job.source as unknown as VideoSource;
  const quoteId = scene.regenQuoteId!;
  await progress(job.id, "regen", 20);
  const { material } = await gatherMaterial(job, source);
  const all = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  const settings = await getVideoSettings();
  const base = buildScriptPrompt(cfg, material, composeSkillInstructions(cfg.skillKeys).text, { brandCta: settings.brand.cta, designName: DESIGN_MAP[cfg.designKey]?.name ?? cfg.designKey });
  const prompt = `${base}\n\nThe script already exists. Rewrite ONLY scene ${scene.index + 1} of ${all.length}.\nCurrent scenes:\n${all.map((s) => `${s.index + 1}. ${s.narration}`).join("\n")}\nAdmin's note for scene ${scene.index + 1}: ${scene.regenNote || "(improve it)"}\nAnswer with ONE JSON object: {"scenes":[{…the rewritten scene…}]}`;
  const r = await generateTextViaOpenRouter("video_script", prompt, { temperature: 0.5, maxOutputTokens: 1200, json: true, check: throwingCheck((t) => { const root = extractJson(t) as { scenes?: unknown[] }; if (!Array.isArray(root.scenes) || !root.scenes.length) throw new Error('No "scenes" array.'); }) }, { actorId: job.confirmedById, quoteId });
  await recomputeJobCost(job.id);
  const root = extractJson(r.text) as { scenes?: unknown[] };
  const warnings: string[] = [];
  const s = parseScene(Array.isArray(root.scenes) ? root.scenes[0] : null, cfg, material, warnings, scene.index + 1, strip);
  if (!s.narration) throw new StageFailure("The regenerated scene has no narration.", "regen");
  await prisma.videoScene.update({
    where: { id: scene.id },
    data: { narration: s.narration, onScreenText: s.onScreenText, visual: (s.visual ?? Prisma.DbNull) as Prisma.InputJsonValue, durationSec: s.durationSec, needsReview: s.needsReview, reviewNote: s.reviewNote, assetKey: s.assetKey, audioKey: null, audioHash: null, audioSec: null, regenQuoteId: null, regenNote: null },
  });
  await progress(job.id, "regen", 100);
  await addEvent(job.id, null, "scene_regenerated", `Scene ${scene.index + 1} regenerated.${warnings.length ? ` ${warnings.join(" ")}` : ""}`);
}

// ---- GENERATE: voice ---------------------------------------------------------------------

export function audioHash(model: string, voice: string, narration: string): string {
  return crypto.createHash("sha256").update(`${model}\u0000${voice}\u0000${narration}`).digest("hex");
}

export interface VoiceConfirmation {
  mode: "voice" | "silent";
  model: string | null;
  voice: string | null;
  chars: number;
  estInr: number;
  maxInr: number;
  confirmedAt: string;
  confirmedById: string;
}

async function runVoice(job: VideoJob) {
  const conf = (job.estimate as { voice?: VoiceConfirmation } | null)?.voice;
  if (!conf) throw new StageFailure("No confirmed voice estimate.", "voice");
  const settings = await getVideoSettings();
  const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  if (conf.mode === "voice") {
    const catalog = await getVoiceCatalog();
    const m = catalog.models.find((x) => x.id === conf.model && catalog.approvedModels.includes(x.id));
    if (!m || !conf.voice) throw new StageFailure("The confirmed speech model is no longer approved in Voice Studio.", "voice");
    await ensureJobDir(job.id);
    await mkdir(await resolveJobPath(job.id, "audio"), { recursive: true });
    const { getUsdInr } = await import("@/lib/ai-engine/fx");
    const fx = await getUsdInr();
    let spentInr = 0;
    const todo = scenes.filter((s) => s.narration.trim());
    for (const [i, s] of todo.entries()) {
      await checkpoint(job.id);
      const hash = audioHash(m.id, conf.voice, s.narration);
      if (s.audioKey && s.audioHash === hash) {
        const exists = await resolveJobPath(job.id, s.audioKey, true).then(() => true, () => false);
        if (exists) continue;
      }
      const chars = [...s.narration].length;
      const { usd } = speechCostUsd(m, chars, s.durationSec);
      if (usd === null) throw new StageFailure(`${m.name} has no usable price.`, "voice");
      const inr = fx.rate ? usd * fx.rate : 0;
      // Never spend beyond what the admin confirmed.
      if (spentInr + inr > conf.maxInr + 0.005) throw new StageFailure(`Stopped before exceeding the confirmed voice cost (₹${conf.maxInr.toFixed(2)}). Review the scenes and confirm again.`, "voice");
      const r = await synthesizeSpeech({ model: m.id, voice: conf.voice, text: s.narration, estUsd: usd, actorId: conf.confirmedById, ref: `video:${job.id}` });
      spentInr += inr;
      const key = `audio/scene-${String(s.index).padStart(2, "0")}-${hash.slice(0, 8)}.mp3`;
      await writeFile(await resolveJobPath(job.id, key), r.audio);
      await prisma.videoScene.update({ where: { id: s.id }, data: { audioKey: key, audioHash: hash, audioSec: null } });
      await progress(job.id, "voice", 5 + ((i + 1) / todo.length) * 80);
    }
    await recomputeJobCost(job.id);
    // Measure every narration file in the render container (duration drives scene length and subtitle timing).
    const fresh = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
    const files = fresh.map((s) => s.audioKey).filter((k): k is string => Boolean(k));
    if (files.length) {
      const probe = await runRenderTask<{ files: Record<string, { durationSec?: number; audio?: unknown; error?: string }> }>(job.id, "probe", { type: "probe", files }, { limits: renderLimits(settings), timeoutSec: 300 });
      for (const s of fresh) {
        if (!s.audioKey) continue;
        const p = probe.files[s.audioKey];
        if (!p || p.error || !p.audio || !p.durationSec) throw new StageFailure(`Scene ${s.index + 1}: the narration audio is not valid${p?.error ? ` (${p.error})` : ""}.`, "voice");
        await prisma.videoScene.update({ where: { id: s.id }, data: { audioSec: p.durationSec, durationSec: Math.round((p.durationSec + 0.45) * 100) / 100 } });
      }
    }
    await addEvent(job.id, null, "voice_ready", `Narration ready for ${todo.length} scene(s) (${m.name}, ${conf.voice}).`);
  } else {
    // Silent render: planned durations, no narration files.
    await prisma.videoScene.updateMany({ where: { jobId: job.id }, data: { audioKey: null, audioHash: null, audioSec: null } });
  }
  await transition(job.id, ["GENERATING_AUDIO"], { status: "RENDERING", stage: "render", progressPct: 0 });
}

// ---- GENERATE: render ---------------------------------------------------------------------

async function runGenerateRender(job: VideoJob) {
  const cfg = job.config as unknown as VideoConfig & { musicKey?: string | null };
  const settings = await getVideoSettings();
  const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  if (!scenes.length) throw new StageFailure("The job has no scenes.", "render");
  const design = DESIGN_MAP[cfg.designKey] ?? DESIGN_MAP.minimal_professional;
  const theme = { ...design.theme, subtitleStyle: cfg.subtitleStyle };
  const { width, height } = ASPECT_MAP[cfg.aspect];
  await mkdir(await resolveJobPath(job.id, "scenes"), { recursive: true });
  const conf = (job.estimate as { voice?: VoiceConfirmation } | null)?.voice;
  const withVoice = conf?.mode === "voice";
  const list = [];
  for (const s of scenes) {
    let visual = s.visual as unknown as SceneVisual | null;
    if (visual?.kind === "image") visual = { ...visual, src: (await imageDataUri(job.id, visual.assetKey, Math.max(width, height))) ?? undefined };
    // A stored answer revealed after the scene would end is never seen: hold the question until 2.5 s after its reveal.
    if (visual?.kind === "question" && visual.correctLabel && visual.revealAtSec && s.durationSec < visual.revealAtSec + 2.5) {
      s.durationSec = Math.round((visual.revealAtSec + 2.5) * 100) / 100;
      await prisma.videoScene.update({ where: { id: s.id }, data: { durationSec: s.durationSec } });
    }
    const html = sceneDocument(
      { narration: s.narration, onScreenText: s.onScreenText, visual, durationSec: s.durationSec },
      { aspect: cfg.aspect, theme, brand: { wordmark: settings.brand.wordmark, examLabel: cfg.examLabel, showBranding: cfg.branding, cta: cfg.cta }, subtitles: cfg.subtitles, fontBase: RENDER_FONT_BASE, fontOrigin: RENDER_FONT_ORIGIN }
    );
    const key = `scenes/scene-${String(s.index).padStart(2, "0")}.html`;
    await writeFile(await resolveJobPath(job.id, key), html);
    list.push({ html: key, durationSec: s.durationSec, audio: withVoice && s.audioKey ? s.audioKey : null });
  }
  let music: { file: string; volume: number } | null = null;
  if (cfg.music && cfg.musicKey) {
    const a = readAssets(job).find((x) => x.key === cfg.musicKey && x.kind === "music" && x.state === "ready");
    if (a) music = { file: a.key, volume: settings.musicVolumePct / 100 };
  }
  await runInContainer(job, "render", { type: "generate", width, height, fps: 25, transition: "fade", transitionSec: 0.35, scenes: list, music, output: "out/video.mp4" }, settings);
}

/**
 * Measured by the render container after an editor export (ffmpeg ebur128 + stream durations). null =
 * not measured (never a stand-in 0); `silent` = measured, no signal (true peak −∞); `errors` = why a
 * measurement is missing. The export itself is valid either way.
 */
export interface AudioReport {
  lufs: number | null;
  truePeakDb: number | null;
  silent?: boolean;
  audioSec: number | null;
  videoSec: number | null;
  errors?: string[];
}

const sec = (n: number | null) => (n === null ? "not measured" : `${n.toFixed(2)} s`);

/** One line for the job log: the measurements, then any warning (loudness for phone playback, peak, A/V length). */
export function audioReportText(a: AudioReport): string {
  const peak = a.truePeakDb !== null ? `${a.truePeakDb.toFixed(1)} dBTP` : a.silent ? "−∞ (silent)" : "n/a";
  const parts = [`Audio: ${a.lufs === null ? "loudness not measured" : `${a.lufs.toFixed(1)} LUFS`}, true peak ${peak}, audio ${sec(a.audioSec)} / video ${sec(a.videoSec)}.`];
  if (a.truePeakDb !== null && a.truePeakDb > -0.5) parts.push("Warning: the peak is close to clipping.");
  if (a.lufs !== null && a.lufs < -24) parts.push("Warning: quiet for phone playback (aim for about −16 to −14 LUFS).");
  if (a.lufs !== null && a.lufs > -9) parts.push("Warning: very loud (aim for about −16 to −14 LUFS).");
  if (a.audioSec !== null && a.videoSec !== null && Math.abs(a.audioSec - a.videoSec) > 0.1) parts.push(`Warning: audio and video lengths differ by ${Math.abs(a.audioSec - a.videoSec).toFixed(2)} s.`);
  if (a.errors?.length) parts.push(`Measurement unavailable (the MP4 is fine): ${a.errors.join("; ")}.`);
  return parts.join(" ");
}

/** Runs a render/export task with progress, cancellation and the Live CBT stop; records the validated output. */
async function runInContainer(job: VideoJob, name: "render" | "export", task: Record<string, unknown>, settings: VideoStudioSettings) {
  let liveStop = false;
  const started = Date.now();
  try {
    const r = await runRenderTask<{ output: string; durationSec: number; sizeBytes: number; audioReport?: AudioReport }>(job.id, name, task, {
      limits: renderLimits(settings),
      timeoutSec: settings.renderTimeoutMin * 60,
      onProgress: (p) => progress(job.id, name, p.pct),
      shouldStop: async () => {
        if (await cancelled(job.id)) return "cancel";
        if (await liveCbtRunning()) {
          liveStop = true;
          return "cancel";
        }
        return null;
      },
    });
    const ok = await transition(job.id, ["RENDERING"], {
      status: "COMPLETED",
      stage: null,
      progressPct: 100,
      outputKey: r.output,
      outputBytes: BigInt(r.sizeBytes),
      outputSec: r.durationSec,
      renderMs: Date.now() - started,
      finishedAt: new Date(),
      failedStage: null,
      errorMessage: null,
    });
    if (ok) await addEvent(job.id, null, "completed", `MP4 ready: ${r.durationSec.toFixed(1)} s, ${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB, rendered in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (ok && r.audioReport) await addEvent(job.id, null, "audio_checked", audioReportText(r.audioReport), { ...r.audioReport });
    await refreshStorageBytes(job.id);
  } catch (e) {
    if (e instanceof RenderError && e.kind === "cancelled") throw new Paused(liveStop ? "live" : "cancelled");
    throw new StageFailure(e instanceof Error ? e.message : "Render failed.", name);
  }
}

// ---- EDIT: ingest / transcribe / export -----------------------------------------------------

async function runIngest(job: VideoJob) {
  const settings = await getVideoSettings();
  const pending = readAssets(job).filter((a) => a.state === "processing");
  for (const [i, a] of pending.entries()) {
    await checkpoint(job.id);
    await progress(job.id, "ingest", (i / Math.max(1, pending.length)) * 100);
    try {
      if (a.kind === "video") {
        const base = a.key.split("/").pop()!.replace(/\.[a-z0-9]+$/, "");
        const r = await runRenderTask<{ source: { durationSec: number; video: JobAsset["video"]; audio: unknown }; output: string; thumbs: JobAsset["thumbs"] & { output: string } }>(
          job.id,
          "proxy",
          { type: "proxy", input: a.key, output: `proxy/${base}.mp4`, maxHeight: 540, thumbs: { output: `proxy/${base}-thumbs.jpg`, everySec: 2, width: 160 } },
          { limits: renderLimits(settings), timeoutSec: settings.renderTimeoutMin * 60, onProgress: (p) => progress(job.id, "ingest", ((i + p.pct / 100) / pending.length) * 100) }
        );
        if (r.source.durationSec > settings.maxUploadMinutes * 60) {
          await patchAsset(job.id, a.key, { state: "failed", error: `Longer than ${settings.maxUploadMinutes} min (Settings).` });
          continue;
        }
        await patchAsset(job.id, a.key, { state: "ready", durationSec: r.source.durationSec, video: r.source.video, hasAudio: Boolean(r.source.audio), proxyKey: r.output, thumbsKey: r.thumbs.output, thumbs: { count: r.thumbs.count, everySec: r.thumbs.everySec, width: r.thumbs.width } });
      } else {
        const r = await runRenderTask<{ files: Record<string, { durationSec?: number; audio?: unknown; video?: unknown; error?: string }> }>(job.id, "probe", { type: "probe", files: [a.key] }, { limits: renderLimits(settings), timeoutSec: 120 });
        const p = r.files[a.key];
        if (!p || p.error || !p.audio) await patchAsset(job.id, a.key, { state: "failed", error: p?.error ?? "No audio stream." });
        else await patchAsset(job.id, a.key, { state: "ready", durationSec: p.durationSec, hasAudio: true });
      }
    } catch (e) {
      if (e instanceof RenderError && e.kind === "unavailable") throw new StageFailure(e.message, "ingest");
      await patchAsset(job.id, a.key, { state: "failed", error: e instanceof Error ? e.message.slice(0, 200) : "Could not read the file." });
    }
  }
  const fresh = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
  const assets = readAssets(fresh);
  if (!fresh.edit) {
    const primary = assets.find((a) => a.kind === "video" && a.state === "ready");
    if (primary) {
      const portrait = (primary.video?.height ?? 0) > (primary.video?.width ?? 0);
      const project = defaultProject(primary as EditAsset, portrait ? "9:16" : "16:9", "minimal_professional", settings.musicVolumePct);
      await prisma.videoJob.update({ where: { id: job.id }, data: { edit: project as unknown as Prisma.InputJsonValue } });
    }
  }
  const failed = assets.filter((a) => a.state === "failed");
  await transition(job.id, ["QUEUED"], { status: "REVIEW_REQUIRED", stage: null, progressPct: 100 });
  await addEvent(job.id, null, "ingested", `Uploads processed${failed.length ? ` — ${failed.length} file(s) could not be used: ${failed.map((f) => `${f.name}: ${f.error}`).join("; ")}` : ""}.`);
  await refreshStorageBytes(job.id);
}

export interface TranscribeConfirmation {
  model: string;
  language: string | null;
  seconds: number;
  estInr: number;
  maxInr: number;
  confirmedAt: string;
  confirmedById: string;
}

async function runTranscribe(job: VideoJob) {
  const conf = (job.estimate as { transcribe?: TranscribeConfirmation } | null)?.transcribe;
  if (!conf) throw new StageFailure("No confirmed transcription estimate.", "transcribe");
  const settings = await getVideoSettings();
  const project = job.edit as unknown as EditProject | null;
  if (!project) throw new StageFailure("No edit project.", "transcribe");
  await progress(job.id, "transcribe", 10);
  const out = await runRenderTask<{ output: string; durationSec: number; sizeBytes: number }>(job.id, "audio", { type: "audio", input: project.primary, output: "work/primary-audio.mp3" }, { limits: renderLimits(settings), timeoutSec: 900 });
  if (out.sizeBytes > 24 * 1024 * 1024) throw new StageFailure("The recording's audio is too long to transcribe in one request.", "transcribe");
  await checkpoint(job.id);
  await progress(job.id, "transcribe", 40);
  const audio = await readFile(await resolveJobPath(job.id, out.output, true));
  const { getUsdInr } = await import("@/lib/ai-engine/fx");
  const fx = await getUsdInr();
  const estUsd = fx.rate ? conf.estInr / fx.rate : 0;
  const r = await transcribeAudio({ model: conf.model, audio, format: "mp3", language: conf.language ?? undefined, estUsd, audioSec: out.durationSec, actorId: conf.confirmedById, ref: `video:${job.id}` });
  await recomputeJobCost(job.id);
  const cues = r.words.length ? cuesFromWords(r.words) : cuesFromSegments(r.segments.length ? r.segments : r.text ? [{ start: 0, end: out.durationSec, text: r.text }] : []);
  const next: EditProject = { ...project, subtitles: { ...project.subtitles, on: true, cues: cues.map((c) => ({ ...c, text: strip(c.text) })) } };
  const cfg = { ...((job.config as Record<string, unknown>) ?? {}), transcript: r.text.slice(0, 20000), transcriptModel: conf.model, transcriptWords: r.words.length };
  await rm(await resolveJobPath(job.id, out.output), { force: true });
  await transition(job.id, ["GENERATING_AUDIO"], { status: "REVIEW_REQUIRED", stage: null, progressPct: 100, edit: next as unknown as Prisma.InputJsonValue, config: cfg as Prisma.InputJsonValue });
  await addEvent(job.id, null, "transcribed", `Subtitles generated: ${cues.length} cue(s) from ${r.words.length ? "word timestamps" : "segment timestamps"} (${conf.model}).`);
}

async function runExport(job: VideoJob) {
  const settings = await getVideoSettings();
  const assets = readAssets(job).filter((a) => a.state === "ready");
  let p: EditProject;
  try {
    p = parseEditProject(job.edit, assets as EditAsset[]);
  } catch (e) {
    throw new StageFailure(e instanceof Error ? e.message : "Invalid edit.", "export");
  }
  const { width, height } = ASPECT_MAP[p.aspect];
  const theme = (DESIGN_MAP[p.designKey] ?? DESIGN_MAP.minimal_professional).theme;
  const docOpts = { aspect: p.aspect, theme, fontBase: RENDER_FONT_BASE, fontOrigin: RENDER_FONT_ORIGIN };
  await mkdir(await resolveJobPath(job.id, "edit"), { recursive: true });
  const overlays = [];
  for (const ov of p.overlays) {
    if (ov.kind === "text" || ov.kind === "diagram") {
      const key = `edit/ov-${ov.id}.html`;
      await writeFile(await resolveJobPath(job.id, key), overlayDocument(ov, docOpts));
      overlays.push({ html: key, start: ov.start, end: ov.end });
    } else {
      const a = assets.find((x) => x.key === ov.assetKey)!;
      overlays.push({ [a.kind === "video" ? "video" : "image"]: a.key, start: ov.start, end: ov.end, x: ov.x, y: ov.y, w: ov.w, h: ov.h, cover: ov.kind === "broll", srcIn: ov.srcIn ?? 0 });
    }
  }
  let subtitles: { html: string } | null = null;
  const cues = outputCues(p);
  const brand = p.branding ? settings.brand.wordmark : null;
  if (cues.length || brand) {
    const key = "edit/subtitles.html";
    await writeFile(await resolveJobPath(job.id, key), subtitleDocument(cues, p.subtitles.style, docOpts, brand));
    subtitles = { html: key };
  }
  const primary = assets.find((a) => a.key === p.primary);
  const fps = Math.min(30, Math.max(24, Math.round(primary?.video?.fps ?? 25)));
  const music = p.audio.musicKey ? { file: p.audio.musicKey, volume: p.audio.musicVolumePct / 100 } : null;
  // Optional sound effects: bundled WAVs (mounted read-only at /sfx), already resolved to output time.
  const sfx = sfxRenderList(p);
  await addEvent(job.id, null, "export_started", `Export: ${outputDuration(p).toFixed(1)} s, ${p.segments.length} segment(s), ${p.overlays.length} overlay(s), ${cues.length} subtitle cue(s)${sfx.length ? `, ${sfx.length} sound effect(s)` : ""}.`);
  await runInContainer(
    job,
    "export",
    { type: "edit", width, height, fps, fit: p.fit, transition: p.transition, segments: p.segments.map((s) => ({ src: s.src, in: s.in, out: s.out, volume: s.volume })), overlays, subtitles, audio: { volume: p.audio.volume, fadeInSec: p.audio.fadeInSec, fadeOutSec: p.audio.fadeOutSec, clean: p.audio.clean, music }, sfx, output: "out/edit.mp4" },
    settings
  );
}

// ---- the loop --------------------------------------------------------------------------------

/** Heartbeat for the admin's capability checks: the render image exists and its tool versions. */
export async function writeHeartbeat(): Promise<{ ok: boolean; error: string | null }> {
  const id = await renderImageId();
  const row = await prisma.setting.findUnique({ where: { key: WORKER_STATUS_KEY } });
  const prev = (row?.value ?? {}) as Record<string, unknown>;
  let ffmpeg = typeof prev.ffmpeg === "string" ? prev.ffmpeg : null;
  let chromium = typeof prev.chromium === "string" ? prev.chromium : null;
  if (!id) {
    await prisma.setting.upsert({ where: { key: WORKER_STATUS_KEY }, update: { value: { at: null, error: "Render image not built." } }, create: { key: WORKER_STATUS_KEY, value: { at: null, error: "Render image not built." } } });
    return { ok: false, error: "Render image not built." };
  }
  if (prev.imageId !== id || !ffmpeg || !chromium) {
    const t = await renderToolchain();
    if (!t.ok) {
      await prisma.setting.upsert({ where: { key: WORKER_STATUS_KEY }, update: { value: { at: null, error: t.error } }, create: { key: WORKER_STATUS_KEY, value: { at: null, error: t.error } } });
      return { ok: false, error: t.error };
    }
    ffmpeg = t.ffmpeg;
    chromium = t.chromium;
  }
  const value = { at: new Date().toISOString(), version: "1", imageId: id, ffmpeg, chromium, error: null };
  await prisma.setting.upsert({ where: { key: WORKER_STATUS_KEY }, update: { value }, create: { key: WORKER_STATUS_KEY, value } });
  return { ok: true, error: null };
}

const FAIL_BACK: Record<string, VideoJobStatus> = { script: "FAILED", regen: "REVIEW_REQUIRED", voice: "FAILED", render: "FAILED", ingest: "FAILED", transcribe: "REVIEW_REQUIRED", export: "FAILED" };

async function handle(job: VideoJob): Promise<void> {
  const stageOf = (): string =>
    job.kind === "MOTION"
      ? job.status === "GENERATING_AUDIO"
        ? "voice"
        : job.status === "RENDERING"
          ? "render"
          : "script"
      : job.kind === "EDIT"
      ? job.status === "QUEUED"
        ? "ingest"
        : job.status === "GENERATING_AUDIO"
          ? "transcribe"
          : "export"
      : job.status === "QUEUED" || job.status === "GENERATING_SCRIPT"
        ? "script"
        : job.status === "GENERATING_AUDIO"
          ? "voice"
          : job.status === "REVIEW_REQUIRED"
            ? "regen"
            : "render";
  const stage = stageOf();
  try {
    await addEvent(job.id, null, "worker", `Worker picked up the job (${stage}).`);
    if (job.kind === "MOTION") {
      // Motion Workflow Studio has its own stages (lib/video-studio/motion/pipeline.ts) on the shared worker.
      const { runMotionStage } = await import("@/lib/video-studio/motion/pipeline");
      await runMotionStage(job);
    } else if (job.kind === "EDIT") {
      if (job.status === "QUEUED") await runIngest(job);
      else if (job.status === "GENERATING_AUDIO") await runTranscribe(job);
      else if (job.status === "RENDERING") await runExport(job);
    } else if (job.status === "QUEUED") await runScript(job);
    else if (job.status === "GENERATING_SCRIPT") {
      // A script call was in flight when the previous worker stopped: never repeat a paid call silently.
      throw new StageFailure("The script step was interrupted. Retry needs a new price confirmation (the earlier call may have been billed).", "script");
    } else if (job.status === "GENERATING_AUDIO") {
      await runVoice(job);
      const fresh = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
      if (fresh.status === "RENDERING") await runGenerateRender(fresh);
    } else if (job.status === "RENDERING") await runGenerateRender(job);
    else if (job.status === "REVIEW_REQUIRED") {
      const scene = await prisma.videoScene.findFirst({ where: { jobId: job.id, regenQuoteId: { not: null } }, orderBy: { index: "asc" } });
      if (scene) await runSceneRegen(job, scene);
    }
  } catch (e) {
    if (e instanceof Paused) {
      if (e.message === "live") await addEvent(job.id, null, "paused", "Paused: a Live CBT is running or about to start. The job continues afterwards.");
      return;
    }
    const failedStage = e instanceof StageFailure ? e.stage : stage;
    // Normalized category in front of the message (lib/ai-engine/errors.ts): AI call vs voice/asset vs render.
    const code = e instanceof AiEngineFailure ? aiErrorCode(e.category) : failedStage === "render" || failedStage === "export" ? "RENDERING_FAILED" : failedStage === "voice" || failedStage === "transcribe" || failedStage === "ingest" ? "ASSET_GENERATION_FAILED" : null;
    const message = `${code ? `[${code}] ` : ""}${e instanceof Error ? e.message : "unexpected error"}`.slice(0, 500);
    const back = FAIL_BACK[failedStage] ?? "FAILED";
    if (failedStage === "regen") await prisma.videoScene.updateMany({ where: { jobId: job.id, regenQuoteId: { not: null } }, data: { regenQuoteId: null, regenNote: null } });
    const from: VideoJobStatus[] = ["QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING", "REVIEW_REQUIRED"];
    if (await transition(job.id, from, { status: back, failedStage, errorMessage: message, stage: null, progressPct: 0, ...(back === "FAILED" ? { finishedAt: new Date() } : {}) })) {
      await addEvent(job.id, null, "failed", `${failedStage} failed: ${message}`);
    }
    await recomputeJobCost(job.id).catch(() => undefined);
    console.error(`[video-worker] job ${job.id} ${failedStage} failed: ${message.slice(0, 200)}`);
  }
}

export async function runVideoWorker(budgetMs = 9 * 60_000): Promise<{ handled: number; paused: boolean; render: boolean }> {
  const started = Date.now();
  let handled = 0;
  await killStrayContainers().catch(() => 0);
  const hb = await writeHeartbeat().catch(() => ({ ok: false }));
  for (;;) {
    if (Date.now() - started > budgetMs) break;
    if (await liveCbtRunning()) return { handled, paused: true, render: hb.ok };
    const now = new Date();
    const free = { OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
    let job = await prisma.videoJob.findFirst({ where: { status: { in: ["QUEUED", "GENERATING_SCRIPT", "GENERATING_AUDIO", "RENDERING"] }, ...free }, orderBy: { updatedAt: "asc" } });
    if (!job) {
      const scene = await prisma.videoScene.findFirst({ where: { regenQuoteId: { not: null }, job: { status: "REVIEW_REQUIRED", ...free } }, select: { jobId: true } });
      if (scene) job = await prisma.videoJob.findUnique({ where: { id: scene.jobId } });
    }
    if (!job) break;
    if (!(await lease(job.id))) continue;
    handled++;
    try {
      await handle(job);
    } finally {
      await release(job.id);
    }
    if (handled >= 20) break;
  }
  // Housekeeping: retention policy, orphan folders, stale upload parts.
  await runCleanup(null).catch((e) => console.error(`[video-worker] cleanup skipped: ${e instanceof Error ? e.message : "error"}`));
  const active = await prisma.videoJob.findMany({ where: { mediaDeletedAt: null, updatedAt: { lt: new Date(Date.now() - 86_400_000) } }, select: { id: true }, take: 200 });
  for (const j of active) await staleUploadParts(j.id).catch(() => undefined);
  return { handled, paused: false, render: hb.ok };
}

// Exposed for tests.
export const __test = { gatherMaterial, loadQuestions, strip };

/** Shared worker plumbing for the Motion Workflow Studio stages (same lease, Live CBT stop, cancellation, container and ledger). */
export const workerKit = { transition, progress, checkpoint, cancelled, runInContainer, recomputeJobCost, loadQuestions, renderLimits, strip, StageFailure, Paused };
