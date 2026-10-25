/**
 * Motion Workflow Studio — local render smoke test (no AI, no database, no
 * network inside the container, scratch folder only). Renders a fixed
 * five-frame storyboard in one style through the isolated render container,
 * validates the MP4 and saves one still per frame for review.
 *
 *   VIDEO_STUDIO_DIR=/root/mts-scratch/video-studio/video-jobs \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/motion-render-smoke.ts <style> [aspect] [outDir]
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureJobDir } from "@/lib/video-studio/storage";
import { runRenderTask } from "@/lib/video-studio/render-runner";
import { RENDER_FONT_BASE, RENDER_FONT_ORIGIN } from "@/lib/video-studio/render-manifest";
import { ASPECT_MAP, type AspectRatio } from "@/lib/video-studio/types";
import { MOTION_STYLE_MAP } from "@/lib/video-studio/motion/styles";
import { defaultTag, estimateTiming, pickMotion, type MotionVisual } from "@/lib/video-studio/motion/storyboard";
import { motionFrameDocument } from "@/lib/video-studio/motion/template";

const FRAMES: { sentence: string; onScreen: string; visual: Partial<MotionVisual> }[] = [
  { sentence: "Heart attack के बाद सबसे पहले कौन सा marker बढ़ता है?", onScreen: "Which marker rises first?", visual: { type: "statement", highlight: "first" } },
  { sentence: "Plaque rupture, फिर thrombus, और फिर myocardial necrosis होता है।", onScreen: "MI pathway", visual: { type: "diagram", highlight: "pathway", nodes: ["Plaque rupture", "Thrombus", "Necrosis"] } },
  { sentence: "Troponin I लगभग 6 घंटे में बढ़ना शुरू होता है।", onScreen: "Troponin I by 6 hours", visual: { type: "stat", highlight: "Troponin", value: "6", unit: "hours" } },
  { sentence: "Boss question: सबसे specific marker कौन सा है? सोचिए, फिर answer देखिए।", onScreen: "Boss question", visual: { type: "question", highlight: "Boss", stem: "Most specific marker of myocardial injury?", options: [{ label: "A", text: "Myoglobin" }, { label: "B", text: "Troponin I" }, { label: "C", text: "LDH" }], correctLabel: "B", revealAtSec: 3 } },
  { sentence: "ऐसे और high-yield videos के लिए MockTestSeries.in पर practice कीजिए।", onScreen: "Practice on MockTestSeries.in", visual: { type: "cta", highlight: "Practice" } },
];

async function main() {
  const style = MOTION_STYLE_MAP[process.argv[2] ?? "big_sentence"];
  const aspect = (process.argv[3] ?? "9:16") as AspectRatio;
  const outDir = process.argv[4] ?? "/root/mts-scratch/video-studio/shots/motion-smoke";
  if (!style || !ASPECT_MAP[aspect]) throw new Error("usage: <style> [aspect] [outDir]");
  const jobId = `msmoke${style.key.replace(/[^a-z]/g, "")}${aspect.replace(":", "x")}`.padEnd(20, "0").slice(0, 40);
  const dir = await ensureJobDir(jobId);
  await mkdir(path.join(dir, "scenes"), { recursive: true });
  await mkdir(outDir, { recursive: true });
  const timing = estimateTiming(FRAMES.map((f) => f.sentence), "hinglish", null, "reading");
  const all = FRAMES.map((f, i) => ({ onScreen: f.onScreen, tag: style.tagHint ? defaultTag(style, i, FRAMES.length) : null }));
  const scenes = [];
  let prev: MotionVisual["motion"] | null = null;
  for (const [i, f] of FRAMES.entries()) {
    const t = timing.frames[i];
    const type = f.visual.type ?? "statement";
    const motion = pickMotion(style, null, prev, i, type);
    prev = motion;
    const visual = { kind: "motion", tag: all[i].tag, highlight: "", ...f.visual, type, motion } as MotionVisual;
    const html = motionFrameDocument(
      { sentence: f.sentence, onScreen: f.onScreen, visual },
      { aspect, styleKey: style.key, index: i, all, durationSec: t.end - t.start, words: timing.words.filter((w) => w.frame === i).map((w) => ({ text: w.text, start: w.start - t.start, end: w.end - t.start })), subtitles: true, brand: { wordmark: "MockTestSeries.in", examLabel: "NEET PG", showBranding: true, cta: "" }, imageSrc: null, fontBase: RENDER_FONT_BASE, fontOrigin: RENDER_FONT_ORIGIN }
    );
    await writeFile(path.join(dir, `scenes/m-${i}.html`), html);
    scenes.push({ html: `scenes/m-${i}.html`, durationSec: t.end - t.start, audio: null });
  }
  const { width, height } = ASPECT_MAP[aspect];
  const tr = style.transition.type !== "none" ? style.transition : null;
  const t0 = Date.now();
  const r = await runRenderTask<{ output: string; durationSec: number }>(jobId, "render", { type: "generate", width, height, fps: 25, transition: tr ? "fade" : "none", transitionType: tr?.type ?? "fade", transitionSec: tr?.sec ?? 0.3, scenes, output: "out/motion.mp4" }, { limits: { cpus: 1, memoryMb: 1536 }, timeoutSec: 900 });
  const file = path.join(dir, "out/motion.mp4");
  for (const [i, t] of timing.frames.entries()) {
    const png = execFileSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${path.dirname(file)}:/w:ro`, "--entrypoint", "ffmpeg", "mts-video-render:1", "-v", "error", "-ss", String(t.end - 0.25), "-i", "/w/motion.mp4", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], { maxBuffer: 64 * 1024 * 1024 });
    await writeFile(path.join(outDir, `${style.key}-${aspect.replace(":", "x")}-f${i + 1}.png`), png);
  }
  console.log(`${style.key} ${aspect}: ${r.durationSec.toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${outDir}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
