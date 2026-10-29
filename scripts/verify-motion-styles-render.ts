/**
 * Motion Workflow Studio — render benchmark + MP4 validation for every style (scratch only, no AI, no DB).
 * For each style × aspect it runs scripts/motion-render-smoke.ts (the fixed five-frame storyboard through
 * the isolated render container), samples the container's memory every second, then checks the MP4 with
 * ffprobe inside the render image. The two Phase 3 styles are rendered twice and their stills compared
 * byte for byte (frame-seeking determinism).
 *
 *   set -a; . <scratch env with VIDEO_STUDIO_DIR + VIDEO_RENDER_INSTANCE>; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-motion-styles-render.ts <outDir> [style,style…] [aspect,aspect…]
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MOTION_STYLES } from "@/lib/video-studio/motion/styles";

const run = promisify(execFile);
const ROOT = process.env.VIDEO_STUDIO_DIR ?? "";
const INSTANCE = process.env.VIDEO_RENDER_INSTANCE ?? "";
if (!ROOT.startsWith("/root/mts-scratch/") || !INSTANCE || INSTANCE === "1") {
  console.error("Refusing to run: needs a /root/mts-scratch/ VIDEO_STUDIO_DIR and a non-production VIDEO_RENDER_INSTANCE.");
  process.exit(2);
}
const OUT = process.argv[2] ?? "/root/mts-scratch/media-studio/shots/p3-bench";
const STYLES = process.argv[3] ? process.argv[3].split(",") : MOTION_STYLES.filter((s) => s.status === "ready").map((s) => s.key);
const ASPECTS = process.argv[4] ? process.argv[4].split(",") : ["9:16", "16:9"];
const REPEAT = new Set(["whiteboard", "kinetic_type"]);

const MIB: Record<string, number> = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 };
async function memMiB(): Promise<number> {
  const ids = (await run("/usr/bin/docker", ["ps", "-q", "--filter", `label=mts.video=${INSTANCE}`])).stdout.split("\n").filter(Boolean);
  let total = 0;
  for (const id of ids) {
    const s = (await run("/usr/bin/docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", id]).catch(() => ({ stdout: "" }))).stdout.split("/")[0].trim();
    const m = /([\d.]+)(\w+)/.exec(s);
    if (m) total += Number(m[1]) * (MIB[m[2]] ?? 0);
  }
  return total;
}

async function renderOnce(style: string, aspect: string, dir: string): Promise<{ sec: number; peak: number; samples: number }> {
  const child = spawn("npx", ["tsx", "scripts/motion-render-smoke.ts", style, aspect, dir], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const t0 = Date.now();
  let peak = 0;
  let samples = 0;
  let done = false;
  const exit = new Promise<number>((r) => child.on("close", (c) => ((done = true), r(c ?? 1))));
  while (!done) {
    const m = await memMiB();
    if (m > 0) samples++;
    peak = Math.max(peak, m);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const code = await exit;
  assert.equal(code, 0, `${style} ${aspect}: smoke failed\n${log}`);
  return { sec: (Date.now() - t0) / 1000, peak, samples };
}

function probe(file: string) {
  const out = execFileSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${path.dirname(file)}:/w:ro`, "--entrypoint", "ffprobe", "mts-video-render:1", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt:format=duration", "-of", "json", `/w/${path.basename(file)}`], { encoding: "utf8" });
  return JSON.parse(out) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string; pix_fmt?: string }[]; format: { duration: string } };
}

const sha = async (f: string) => crypto.createHash("sha256").update(await readFile(f)).digest("hex");

async function main() {
  const rows: Record<string, unknown>[] = [];
  let failed = 0;
  for (const style of STYLES)
    for (const aspect of ASPECTS) {
      const tag = `${style}-${aspect.replace(":", "x")}`;
      try {
        const r = await renderOnce(style, aspect, OUT);
        const jobId = `msmoke${style.replace(/[^a-z]/g, "")}${aspect.replace(":", "x")}`.padEnd(20, "0").slice(0, 40);
        const mp4 = path.join(ROOT, jobId, "out/motion.mp4");
        const p = probe(mp4);
        const v = p.streams.find((s) => s.codec_type === "video")!;
        const [W, H] = aspect === "9:16" ? [1080, 1920] : aspect === "16:9" ? [1920, 1080] : aspect === "1:1" ? [1080, 1080] : [1080, 1350];
        assert.equal(v.codec_name, "h264", tag);
        assert.equal(v.pix_fmt, "yuv420p", tag);
        assert.deepEqual([v.width, v.height], [W, H], tag);
        assert.equal(v.avg_frame_rate, "25/1", tag);
        const dur = Number(p.format.duration);
        assert.ok(dur > 25 && dur < 40, `${tag} duration ${dur}`);
        const row: Record<string, unknown> = { style, aspect, videoSec: Math.round(dur * 10) / 10, renderSec: Math.round(r.sec), peakMiB: Math.round(r.peak), memSamples: r.samples, codec: `${v.codec_name} ${v.width}x${v.height} ${v.avg_frame_rate}`, audio: p.streams.some((s) => s.codec_type === "audio") };
        if (REPEAT.has(style)) {
          const first = await Promise.all([1, 2, 3, 4, 5].map((i) => sha(path.join(OUT, `${tag}-f${i}.png`))));
          const dir2 = path.join(OUT, "repeat");
          await renderOnce(style, aspect, dir2);
          const second = await Promise.all([1, 2, 3, 4, 5].map((i) => sha(path.join(dir2, `${tag}-f${i}.png`))));
          row.deterministic = first.every((h, i) => h === second[i]);
          assert.ok(row.deterministic, `${tag}: stills differ between two renders`);
        }
        rows.push(row);
        console.log(`  ✓ ${tag}: ${row.videoSec} s video, rendered in ${row.renderSec} s, peak ${row.peakMiB} MiB${row.deterministic !== undefined ? ", stills identical on re-render" : ""}`);
      } catch (e) {
        failed++;
        rows.push({ style, aspect, error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
        console.error(`  ✗ ${tag}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
    }
  await writeFile(path.join(OUT, "bench.json"), JSON.stringify(rows, null, 1));
  console.log(`\n${rows.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
