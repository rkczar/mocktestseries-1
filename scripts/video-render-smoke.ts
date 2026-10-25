/**
 * AI Video Studio — local render smoke test (no AI, no network inside the
 * container, scratch folder only). Renders the curated sample scenes through
 * the isolated render container and validates the MP4.
 *
 *   VIDEO_STUDIO_DIR=/root/mts-scratch/video-studio/video-jobs \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/video-render-smoke.ts [design] [aspect] [--tone]
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { SAMPLE_SCENES } from "@/lib/video-studio/samples";
import { sceneDocument } from "@/lib/video-studio/template";
import { DESIGN_MAP } from "@/lib/video-studio/designs";
import { ensureJobDir } from "@/lib/video-studio/storage";
import { runRenderTask } from "@/lib/video-studio/render-runner";
import type { AspectRatio } from "@/lib/video-studio/types";
import { ASPECT_MAP } from "@/lib/video-studio/types";
import { RENDER_FONT_BASE, RENDER_FONT_ORIGIN } from "@/lib/video-studio/render-manifest";

async function main() {
  const design = DESIGN_MAP[process.argv[2] ?? "medical_classroom"];
  const aspect = (process.argv[3] ?? "9:16") as AspectRatio;
  if (!design || !ASPECT_MAP[aspect]) throw new Error("usage: [design] [aspect]");
  const jobId = `smoke${design.key.replace(/[^a-z]/g, "")}${aspect.replace(":", "x")}`.padEnd(20, "0").slice(0, 40);
  const dir = await ensureJobDir(jobId);
  await mkdir(path.join(dir, "scenes"), { recursive: true });
  const scenes = [];
  for (const [i, s] of SAMPLE_SCENES.entries()) {
    const html = sceneDocument(s.scene, { aspect, theme: design.theme, brand: { wordmark: "MockTestSeries.in", examLabel: "NEET PG", showBranding: true, cta: "" }, subtitles: true, fontBase: RENDER_FONT_BASE, fontOrigin: RENDER_FONT_ORIGIN });
    await writeFile(path.join(dir, `scenes/scene-${i}.html`), html);
    scenes.push({ html: `scenes/scene-${i}.html`, durationSec: s.scene.durationSec, audio: null });
  }
  const { width, height } = ASPECT_MAP[aspect];
  const t0 = Date.now();
  const r = await runRenderTask(jobId, "render", { type: "generate", width, height, fps: 25, transition: "fade", transitionSec: 0.4, scenes, output: "out/video.mp4" }, {
    limits: { cpus: 1, memoryMb: 1536 },
    timeoutSec: 900,
    onProgress: (p) => void process.stdout.write(`\r${p.stage} ${p.pct}%   `),
  });
  console.log(`\n${JSON.stringify(r)}\nwall ${(Date.now() - t0) / 1000}s → ${path.join(dir, "out/video.mp4")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
