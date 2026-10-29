import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Prisma, type VideoJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateTextViaOpenRouter } from "@/lib/ai-engine/engine";
import { ENGINE_FEATURE_MAP } from "@/lib/ai-engine/config";
import { synthesizeSpeech, transcribeAudio } from "@/lib/ai-engine/speech";
import { audioHash, workerKit } from "@/lib/video-studio/pipeline";
import { composeSkillInstructions } from "@/lib/video-studio/skills";
import { getVideoSettings } from "@/lib/video-studio/settings";
import { extractJson, throwingCheck } from "@/lib/video-studio/script";
import { RENDER_FONT_BASE, RENDER_FONT_ORIGIN } from "@/lib/video-studio/render-manifest";
import { runRenderTask } from "@/lib/video-studio/render-runner";
import { imageDataUri, readAssets } from "@/lib/video-studio/assets";
import { ensureJobDir, resolveJobPath } from "@/lib/video-studio/storage";
import { addEvent } from "@/lib/video-studio/jobs";
import { ASPECT_MAP } from "@/lib/video-studio/types";
import { MOTION_STYLE_MAP } from "@/lib/video-studio/motion/styles";
import { alignTiming, buildMotionPrompt, estimateTiming, parseMotionAnswer, type MotionConfig, type MotionTiming, type MotionVisual } from "@/lib/video-studio/motion/storyboard";
import { motionFrameDocument } from "@/lib/video-studio/motion/template";
import { renderChecks } from "@/lib/video-studio/motion/quality";

/**
 * Motion Workflow Studio — worker stages (run by the shared video worker,
 * scripts/video-worker.ts, never in a web request). Same lease, Live CBT
 * stop, cancellation checks, render container and cost ledger as the
 * Generator (workerKit from lib/video-studio/pipeline.ts).
 *
 *   QUEUED            → script + storyboard (ONE paid text call, the confirmed quote)
 *   GENERATING_AUDIO  → ONE narration take for the whole script (paid, confirmed)
 *                       → precise sync: word timestamps by transcribing that take (paid, confirmed)
 *                         estimated sync: words spread over the measured take (free)
 *                       → RENDERING
 *   RENDERING         → every frame as a word-timed HTML document → MP4 with the
 *                       single narration track → COMPLETED
 */

const { transition, progress, checkpoint, cancelled, runInContainer, recomputeJobCost, loadQuestions, renderLimits, strip, StageFailure } = workerKit;

export interface MotionVoiceConfirmation {
  mode: "voice" | "silent";
  model: string | null;
  voice: string | null;
  chars: number;
  estInr: number;
  maxInr: number;
  sync: "precise" | "estimated" | "reading";
  stt: { model: string; perSecondUsd: number; maxInr: number; language: string | null } | null;
  textHash: string;
  /** Set by the free re-render: the existing take must be reused; nothing paid may run. */
  reuseOnly?: boolean;
  confirmedAt: string;
  confirmedById: string;
}

/** The one narration take of a motion video (cached while the script text and voice are unchanged). */
export interface MotionTake {
  key: string;
  hash: string;
  sec: number;
}

export function scriptText(sentences: string[]): string {
  return sentences.join(" ").replace(/\s+/g, " ").trim();
}

export async function runMotionStage(job: VideoJob): Promise<void> {
  if (job.status === "QUEUED") return runMotionScript(job);
  if (job.status === "GENERATING_SCRIPT") throw new StageFailure("The script step was interrupted. Retry needs a new price confirmation (the earlier call may have been billed).", "script");
  if (job.status === "GENERATING_AUDIO") {
    await runMotionVoice(job);
    const fresh = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
    if (fresh.status === "RENDERING") await runMotionRender(fresh);
    return;
  }
  if (job.status === "RENDERING") return runMotionRender(job);
}

async function runMotionScript(job: VideoJob) {
  if (!(await transition(job.id, ["QUEUED"], { status: "GENERATING_SCRIPT", stage: "script", progressPct: 5, failedStage: null, errorMessage: null }))) return;
  const cfg = job.config as unknown as MotionConfig;
  const style = MOTION_STYLE_MAP[cfg.styleKey];
  if (!style) throw new StageFailure("Unknown motion style.", "script");
  const settings = await getVideoSettings();
  const questions = (await loadQuestions(cfg.questionIds)).map((q) => ({ ...q }));
  const prompt = buildMotionPrompt(cfg, style, questions, composeSkillInstructions(cfg.skillKeys).text, settings.brand.cta);
  const quoteId = job.quoteIds[job.quoteIds.length - 1] ?? null;
  await addEvent(job.id, null, "script_started", `Writing the script and storyboard (${style.name}).`);
  const imageAssets = readAssets(job).filter((a) => a.kind === "image" && a.state === "ready");
  const r = await generateTextViaOpenRouter("video_script", prompt, { temperature: 0.5, maxOutputTokens: ENGINE_FEATURE_MAP.video_script.defaultMaxOutputTokens, json: true, check: throwingCheck((t) => parseMotionAnswer(extractJson(t), cfg, questions, imageAssets, strip)) }, { actorId: job.confirmedById, quoteId });
  await recomputeJobCost(job.id);
  let parsed;
  try {
    parsed = parseMotionAnswer(extractJson(r.text), cfg, questions, readAssets(job).filter((a) => a.kind === "image" && a.state === "ready"), strip);
  } catch (e) {
    throw new StageFailure(`The model's storyboard could not be used: ${e instanceof Error ? e.message : "invalid answer"}. Retry needs a new price confirmation.`, "script");
  }
  if (await cancelled(job.id)) return;
  await saveFrames(job.id, parsed.frames);
  const next: MotionConfig = { ...cfg, title: parsed.title || cfg.title, caption: parsed.caption, scriptModel: r.model, timing: null };
  await transition(job.id, ["GENERATING_SCRIPT"], { status: "REVIEW_REQUIRED", stage: null, progressPct: 100, config: next as unknown as Prisma.InputJsonValue });
  const flagged = parsed.frames.filter((f) => f.needsReview).length;
  await addEvent(job.id, null, "script_ready", `Storyboard ready: ${parsed.frames.length} frames by ${r.model}${flagged ? `, ${flagged} flagged for review` : ""}.${parsed.warnings.length ? ` ${parsed.warnings.join(" ")}` : ""}`);
}

export async function saveFrames(jobId: string, frames: { sentence: string; onScreen: string; visual: MotionVisual; durationSec: number; needsReview: boolean; reviewNote: string | null }[]) {
  await prisma.$transaction([
    prisma.videoScene.deleteMany({ where: { jobId } }),
    prisma.videoScene.createMany({
      data: frames.map((f, i) => ({ jobId, index: i, narration: f.sentence, onScreenText: f.onScreen, visual: f.visual as unknown as Prisma.InputJsonValue, durationSec: f.durationSec, needsReview: f.needsReview, reviewNote: f.reviewNote, assetKey: f.visual.assetKey ?? null })),
    }),
  ]);
}

function audioFormat(buf: Buffer): "mp3" | "wav" {
  return buf.subarray(0, 4).toString("latin1") === "RIFF" ? "wav" : "mp3";
}

async function runMotionVoice(job: VideoJob) {
  const conf = (job.estimate as { motionVoice?: MotionVoiceConfirmation } | null)?.motionVoice;
  if (!conf) throw new StageFailure("No confirmed narration estimate.", "voice");
  const cfg = job.config as unknown as MotionConfig & { take?: MotionTake | null };
  const settings = await getVideoSettings();
  const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  const sentences = scenes.map((s) => s.narration);
  let timing: MotionTiming;
  let take: MotionTake | null = cfg.take ?? null;
  if (conf.mode === "silent") {
    timing = estimateTiming(sentences, cfg.language, null, "reading");
    take = null;
  } else {
    const text = scriptText(sentences);
    const hash = audioHash(conf.model!, conf.voice!, text);
    await ensureJobDir(job.id);
    await mkdir(await resolveJobPath(job.id, "audio"), { recursive: true });
    const cached = take && take.hash === hash && (await resolveJobPath(job.id, take.key, true).then(() => true, () => false));
    if (!cached) {
      if (conf.reuseOnly) throw new StageFailure("The narration file is missing — review the narration price and confirm again (a free re-render never records new narration).", "voice");
      if (conf.textHash !== (await import("node:crypto")).createHash("sha256").update(scenes.map((s) => `${s.id}:${s.narration}`).join("\n")).digest("hex")) throw new StageFailure("The script changed after the narration was confirmed — review the price again.", "voice");
      await checkpoint(job.id);
      await progress(job.id, "voice", 10);
      const { getUsdInr } = await import("@/lib/ai-engine/fx");
      const fx = await getUsdInr();
      const catalog = await (await import("@/lib/video-studio/voices")).getVoiceCatalog();
      const m = catalog.models.find((x) => x.id === conf.model && catalog.approvedModels.includes(x.id));
      if (!m) throw new StageFailure("The confirmed speech model is no longer approved in Voice Studio.", "voice");
      const { speechCostUsd } = await import("@/lib/video-studio/voices");
      const usd = speechCostUsd(m, [...text].length, take?.sec ?? 30).usd;
      // Never spend beyond what the admin confirmed.
      if (usd === null || !fx.rate || usd * fx.rate > conf.maxInr + 0.005) throw new StageFailure(`Stopped before exceeding the confirmed narration cost (₹${conf.maxInr.toFixed(2)}). Review the price again.`, "voice");
      const estUsd = conf.estInr / fx.rate;
      const r = await synthesizeSpeech({ model: conf.model!, voice: conf.voice!, text, estUsd, actorId: conf.confirmedById, ref: `video:${job.id}` });
      const key = `audio/take-${hash.slice(0, 10)}.${audioFormat(r.audio)}`;
      await writeFile(await resolveJobPath(job.id, key), r.audio);
      await recomputeJobCost(job.id);
      const probe = await runRenderTask<{ files: Record<string, { durationSec?: number; audio?: unknown; error?: string }> }>(job.id, "probe", { type: "probe", files: [key] }, { limits: renderLimits(settings), timeoutSec: 300 });
      const p = probe.files[key];
      if (!p || p.error || !p.audio || !p.durationSec) throw new StageFailure(`The narration audio is not valid${p?.error ? ` (${p.error})` : ""}.`, "voice");
      take = { key, hash, sec: p.durationSec };
      await addEvent(job.id, null, "voice_ready", `Narration recorded in one take: ${p.durationSec.toFixed(1)} s (${conf.model}, ${conf.voice}).`);
    }
    await progress(job.id, "voice", 55);
    timing = estimateTiming(sentences, cfg.language, take!.sec, "estimated");
    if (conf.sync === "precise" && conf.stt) {
      const { getUsdInr } = await import("@/lib/ai-engine/fx");
      const fx = await getUsdInr();
      const inr = fx.rate ? conf.stt.perSecondUsd * take!.sec * fx.rate : null;
      if (inr === null || inr > conf.stt.maxInr + 0.005) {
        await addEvent(job.id, null, "sync_estimated", `Precise sync skipped: the narration is longer than estimated (would cost more than the confirmed ₹${conf.stt.maxInr.toFixed(2)}). Words follow an estimate instead.`);
      } else {
        await checkpoint(job.id);
        const audio = await readFile(await resolveJobPath(job.id, take!.key, true));
        const r = await transcribeAudio({ model: conf.stt.model, audio, format: audioFormat(audio), language: conf.stt.language ?? undefined, estUsd: conf.stt.perSecondUsd * take!.sec, audioSec: take!.sec, actorId: conf.confirmedById, ref: `video:${job.id}` });
        await recomputeJobCost(job.id);
        if (r.words.length) {
          timing = alignTiming(sentences, r.words, take!.sec, cfg.language);
          await addEvent(job.id, null, "synced", `Word timing: ${timing.mode === "precise" ? `${r.words.length} word timestamps aligned` : "transcript did not match the script well enough — estimated timing used"} (${conf.stt.model}).`);
        } else await addEvent(job.id, null, "sync_estimated", "The transcription returned no word timestamps — estimated timing used.");
      }
    }
  }
  for (const [i, s] of scenes.entries()) {
    const f = timing.frames[i];
    if (f) await prisma.videoScene.update({ where: { id: s.id }, data: { durationSec: Math.round((f.end - f.start) * 1000) / 1000, audioSec: null } });
  }
  const next = { ...cfg, timing, take, voice: conf.mode === "voice" ? { model: conf.model!, voice: conf.voice! } : null };
  await transition(job.id, ["GENERATING_AUDIO"], { status: "RENDERING", stage: "render", progressPct: 0, config: next as unknown as Prisma.InputJsonValue });
}

async function runMotionRender(job: VideoJob) {
  const cfg = job.config as unknown as MotionConfig & { take?: MotionTake | null };
  const style = MOTION_STYLE_MAP[cfg.styleKey];
  if (!style) throw new StageFailure("Unknown motion style.", "render");
  const settings = await getVideoSettings();
  const scenes = await prisma.videoScene.findMany({ where: { jobId: job.id }, orderBy: { index: "asc" } });
  if (!scenes.length) throw new StageFailure("The storyboard has no frames.", "render");
  const conf = (job.estimate as { motionVoice?: MotionVoiceConfirmation } | null)?.motionVoice;
  const withVoice = conf?.mode === "voice" && cfg.take;
  const timing = cfg.timing && cfg.timing.frames.length === scenes.length ? cfg.timing : estimateTiming(scenes.map((s) => s.narration), cfg.language, withVoice ? cfg.take!.sec : null, withVoice ? "estimated" : "reading");
  const { width, height } = ASPECT_MAP[cfg.aspect];
  const images = readAssets(job).filter((a) => a.kind === "image" && a.state === "ready");
  if (style.layout === "photo" && !images.length) throw new StageFailure("Photo Story needs at least one uploaded image.", "render");
  await mkdir(await resolveJobPath(job.id, "scenes"), { recursive: true });
  const all = scenes.map((s) => ({ onScreen: s.onScreenText, tag: (s.visual as unknown as MotionVisual | null)?.tag ?? null }));
  const list = [];
  for (const [i, s] of scenes.entries()) {
    const v = s.visual as unknown as MotionVisual;
    const f = timing.frames[i];
    const dur = Math.max(0.6, f.end - f.start);
    const imgKey = v.type === "image" && v.assetKey ? v.assetKey : style.layout === "photo" ? images[i % images.length].key : null;
    const html = motionFrameDocument(
      { sentence: s.narration, onScreen: s.onScreenText, visual: v },
      {
        aspect: cfg.aspect,
        styleKey: cfg.styleKey,
        index: i,
        all,
        durationSec: dur,
        words: timing.words.filter((w) => w.frame === i).map((w) => ({ text: w.text, start: Math.max(0, w.start - f.start), end: Math.max(0, w.end - f.start) })),
        subtitles: cfg.subtitles,
        brand: { wordmark: settings.brand.wordmark, examLabel: cfg.examLabel, showBranding: cfg.branding, cta: cfg.cta },
        imageSrc: imgKey ? await imageDataUri(job.id, imgKey, Math.max(width, height)) : null,
        fontBase: RENDER_FONT_BASE,
        fontOrigin: RENDER_FONT_ORIGIN,
      }
    );
    const key = `scenes/motion-${String(i).padStart(2, "0")}.html`;
    await writeFile(await resolveJobPath(job.id, key), html);
    list.push({ html: key, durationSec: dur, audio: null });
  }
  const tr = style.transition.type !== "none" ? style.transition : null;
  await addEvent(job.id, null, "render_started", `Rendering ${scenes.length} motion frames (${style.name}, ${cfg.aspect}, ${timing.mode} timing).`);
  await runInContainer(
    job,
    "render",
    { type: "generate", width, height, fps: 25, transition: tr ? "fade" : "none", transitionType: tr?.type ?? "fade", transitionSec: tr?.sec ?? 0.3, scenes: list, narration: withVoice ? { file: cfg.take!.key } : null, music: null, output: "out/motion.mp4" },
    settings
  );
  const done = await prisma.videoJob.findUniqueOrThrow({ where: { id: job.id } });
  if (done.status === "COMPLETED" && done.outputSec) {
    const total = list.reduce((a, s) => a + s.durationSec, 0);
    const checks = renderChecks({ width, height, durationSec: done.outputSec, hasAudio: true }, { width, height, durationSec: total, audio: Boolean(withVoice) });
    await prisma.videoJob.update({ where: { id: job.id }, data: { config: { ...(done.config as object), renderQa: checks, timing } as unknown as Prisma.InputJsonValue } });
  }
}
