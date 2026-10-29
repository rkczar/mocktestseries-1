/**
 * Video render audio — measurement resilience + the music mix (scratch only: no AI, no database, no network
 * inside the render container, synthetic media).
 *
 *   A. render.mjs audio report (pure, render.mjs imported with RENDER_MJS_NO_MAIN=1): ffprobe failure,
 *      malformed / incomplete ffprobe output, a missing ebur128 summary and a failing loudness pass never
 *      throw — the numbers stay null (unknown, not 0), the reason is listed and logged; a measured 0 s stays
 *      0; silence is "-inf" peak, not a failure; the job-log text says "not measured" and never invents an
 *      A/V mismatch.
 *   B. real container: a genuine FFmpeg failure still fails the export; a good export measures cleanly.
 *   C. the music mix (editor export + Generator): audio exactly as long as the video when the last segment
 *      runs to the end of its source (it once ended ~53 ms early), the source's own sound in the last 50 ms,
 *      no limiter delay (the voice lines up with the same render without music), and unchanged levels
 *      (music at volume 0 → the voice + the limiter's usual ≈ +0.45 dB make-up gain).
 *
 *   set -a; . <scratch env with VIDEO_STUDIO_DIR + VIDEO_RENDER_INSTANCE>; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-video-audio-mix.ts [--pure]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chown, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { audioReportText } from "@/lib/video-studio/pipeline";

const PURE = process.argv.includes("--pure");
const ROOT = process.env.VIDEO_STUDIO_DIR ?? "";
const INSTANCE = process.env.VIDEO_RENDER_INSTANCE ?? "";
if (!PURE && (!ROOT.startsWith("/root/mts-scratch/") || !INSTANCE || INSTANCE === "1")) {
  console.error("Refusing to run: needs a /root/mts-scratch/ VIDEO_STUDIO_DIR and a non-production VIDEO_RENDER_INSTANCE (or --pure).");
  process.exit(2);
}
const IMAGE = "mts-video-render:1";
const SR = 48000;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${label}\n      ${e instanceof Error ? e.message.split("\n").slice(0, 4).join("\n      ") : e}`);
  }
}
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

type Exec = (cmd: string, args: string[], o?: { onStderr?: (s: string) => void }) => Promise<Buffer>;
type Report = { lufs: number | null; truePeakDb: number | null; silent: boolean; audioSec: number | null; videoSec: number | null; errors: string[] };
type RenderMjs = {
  measureAudio: (abs: string, exec: Exec) => Promise<Report>;
  parseStreamLengths: (json: string) => { audioSec: number | null; videoSec: number | null };
  parseEbur128: (log: string) => { lufs: number | null; truePeakDb: number | null; silent: boolean; error: string | null };
};

const SUMMARY = (peak: string) => `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -15.3 LUFS\n    Threshold: -25.6 LUFS\n\n  Loudness range:\n    LRA:         3.1 LU\n\n  True peak:\n    Peak:       ${peak} dBFS\n`;
const PROBE_OK = JSON.stringify({ streams: [{ codec_type: "video", duration: "12.000000" }, { codec_type: "audio", duration: "11.989000" }] });

/** A fake runner: ffprobe → `probe` (or throws), ffmpeg ebur128 → stderr `log` (or throws). */
function fake(probe: string | Error, log: string | Error): Exec {
  return async (cmd, _args, o) => {
    if (cmd === "ffprobe") {
      if (probe instanceof Error) throw probe;
      return Buffer.from(probe);
    }
    if (log instanceof Error) throw log;
    o?.onStderr?.(log);
    return Buffer.alloc(0);
  };
}

async function partA() {
  console.log("\nA. Audio report: measurement failures are never fatal");
  process.env.RENDER_MJS_NO_MAIN = "1";
  const r = (await import(path.join(process.cwd(), "ops/video-worker/render.mjs"))) as RenderMjs;
  const logged: string[] = [];
  const origError = console.error;
  const quiet = async <T,>(fn: () => Promise<T>) => {
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      return await fn();
    } finally {
      console.error = origError;
    }
  };

  await check("successful measurement: loudness, true peak and both stream lengths; no errors, nothing logged", async () => {
    logged.length = 0;
    const m = await quiet(() => r.measureAudio("/w/x.mp4", fake(PROBE_OK, SUMMARY("-1.2"))));
    assert.deepEqual(m, { lufs: -15.3, truePeakDb: -1.2, silent: false, audioSec: 11.989, videoSec: 12, errors: [] });
    assert.equal(logged.length, 0);
  });
  await check("ffprobe fails (exit 1): no throw, lengths null (not 0), reason listed + logged, loudness still measured", async () => {
    logged.length = 0;
    const m = await quiet(() => r.measureAudio("/w/x.mp4", fake(new Error("ffprobe exited with 1: moov atom not found"), SUMMARY("-1.2"))));
    assert.equal(m.audioSec, null);
    assert.equal(m.videoSec, null);
    assert.equal(m.lufs, -15.3);
    assert.match(m.errors.join(), /stream lengths: ffprobe exited with 1/);
    assert.match(logged.join(), /audio-check unavailable \(export kept\)/);
  });
  await check("malformed ffprobe output (not JSON, no streams, garbage durations): null + reason, never 0", async () => {
    for (const bad of ["not json{", "{}", JSON.stringify({ streams: "x" })]) {
      const m = await quiet(() => r.measureAudio("/w/x.mp4", fake(bad, SUMMARY("-1.2"))));
      assert.equal(m.audioSec, null, bad);
      assert.equal(m.videoSec, null, bad);
      assert.match(m.errors.join(), /stream lengths/, bad);
    }
    const na = await quiet(() => r.measureAudio("/w/x.mp4", fake(JSON.stringify({ streams: [{ codec_type: "video", duration: "N/A" }, { codec_type: "audio", duration: "-3" }] }), SUMMARY("-1.2"))));
    assert.deepEqual([na.audioSec, na.videoSec], [null, null]);
    assert.match(na.errors.join(), /stream length missing/);
  });
  await check("a measured 0 s stays 0 (distinct from unknown)", () => {
    assert.deepEqual(r.parseStreamLengths(JSON.stringify({ streams: [{ codec_type: "video", duration: "0.000000" }, { codec_type: "audio", duration: 0 }] })), { audioSec: 0, videoSec: 0 });
  });
  await check("loudness pass fails or prints no summary: lufs/peak null + reason; lengths kept", async () => {
    const a = await quiet(() => r.measureAudio("/w/x.mp4", fake(PROBE_OK, new Error("ffmpeg exited with 1: Stream map '0:a:0' matches no streams."))));
    assert.deepEqual([a.lufs, a.truePeakDb, a.audioSec], [null, null, 11.989]);
    assert.match(a.errors.join(), /loudness: ffmpeg exited with 1/);
    const b = await quiet(() => r.measureAudio("/w/x.mp4", fake(PROBE_OK, "garbage without a summary")));
    assert.deepEqual([b.lufs, b.truePeakDb], [null, null]);
    assert.match(b.errors.join(), /loudness: no ebur128 summary/);
    const c = r.parseEbur128("Summary:\n I:  -20.0 LUFS\n");
    assert.equal(c.lufs, -20);
    assert.equal(c.error, "ebur128 summary incomplete");
  });
  await check("silence: '-inf' true peak is a valid measurement (silent: true, peak null, no error)", async () => {
    const m = await quiet(() => r.measureAudio("/w/x.mp4", fake(PROBE_OK, SUMMARY("-inf").replace("-15.3 LUFS", "-70.0 LUFS"))));
    assert.equal(m.silent, true);
    assert.equal(m.truePeakDb, null);
    assert.equal(m.lufs, -70);
    assert.deepEqual(m.errors, []);
  });
  await check("both fail: still a report (all null, two reasons) — the caller keeps the MP4", async () => {
    const m = await quiet(() => r.measureAudio("/w/x.mp4", fake(new Error("spawn ffprobe ENOENT"), new Error("spawn ffmpeg ENOENT"))));
    assert.deepEqual([m.lufs, m.truePeakDb, m.audioSec, m.videoSec], [null, null, null, null]);
    assert.equal(m.errors.length, 2);
  });
  await check("job-log text: unknown lengths say 'not measured', no invented A/V mismatch; reasons shown; silence shown as −∞", () => {
    const u = audioReportText({ lufs: null, truePeakDb: null, audioSec: null, videoSec: 12, errors: ["stream lengths: boom"] });
    assert.match(u, /audio not measured \/ video 12\.00 s/);
    assert.ok(!/differ/.test(u));
    assert.match(u, /Measurement unavailable \(the MP4 is fine\): stream lengths: boom/);
    assert.match(audioReportText({ lufs: -70, truePeakDb: null, silent: true, audioSec: 5, videoSec: 5, errors: [] }), /true peak −∞ \(silent\)/);
    assert.match(audioReportText({ lufs: -15, truePeakDb: -1.5, audioSec: 0, videoSec: 0 }), /audio 0\.00 s \/ video 0\.00 s\./);
  });
}

// ---- B / C. real renders --------------------------------------------------------------------

function tool(bin: "ffmpeg" | "ffprobe", dir: string, args: string[], rw = false) {
  const r = spawnSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${dir}:/w:${rw ? "rw" : "ro"}`, "--entrypoint", bin, IMAGE, ...args], { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr.toString().slice(-500)}`);
  return { out: r.stdout, err: r.stderr.toString() };
}
function lengths(dir: string, file: string) {
  const s = JSON.parse(tool("ffprobe", dir, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", `/w/${file}`]).out.toString()).streams as { codec_type: string; duration: string }[];
  return { audio: Number(s.find((x) => x.codec_type === "audio")?.duration), video: Number(s.find((x) => x.codec_type === "video")?.duration) };
}
function pcm(dir: string, file: string): Float32Array {
  const b = tool("ffmpeg", dir, ["-v", "error", "-i", `/w/${file}`, "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]).out;
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}
const rms = (a: Float32Array) => Math.sqrt(a.reduce((q, v) => q + v * v, 0) / Math.max(1, a.length));
const db = (x: number) => 20 * Math.log10(x);
/** Lag (ms) of `x` against `ref` over a 0.2 s window at t (±10 ms). Pink noise: one unambiguous peak. */
function lagMs(x: Float32Array, ref: Float32Array, t: number): number {
  const a = Math.round(t * SR);
  const n = Math.round(0.2 * SR);
  let best = -Infinity;
  let at = 0;
  for (let d = -480; d <= 480; d++) {
    let dot = 0;
    for (let j = 0; j < n; j++) dot += x[a + d + j] * ref[a + j];
    if (dot > best) [best, at] = [dot, d];
  }
  return (at / SR) * 1000;
}

async function partBC() {
  const { ensureJobDir } = await import("@/lib/video-studio/storage");
  const { runRenderTask } = await import("@/lib/video-studio/render-runner");
  const jobId = "audiomixsuite0000000";
  const dir = await ensureJobDir(jobId);
  for (const d of ["inputs", "out", "scenes"]) await mkdir(path.join(dir, d), { recursive: true });
  for (const d of [dir, ...["inputs", "out", "scenes"].map((x) => path.join(dir, x))]) await chown(d, 10001, 10001);
  const render = <T,>(name: string, task: Record<string, unknown>) => runRenderTask<T>(jobId, name, task, { limits: { cpus: 1, memoryMb: 1536 }, timeoutSec: 900 });

  console.log("\nB. Real container: genuine failures stay fatal, good exports measure cleanly");
  // 20 s 1080×1920 test pattern with pink-noise "voice" (broadband: lag and tail are measurable), plus voice / music WAVs.
  tool("ffmpeg", dir, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=25:d=20", "-f", "lavfi", "-i", "anoisesrc=d=20:c=pink:r=48000:a=0.25:s=3", "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ac", "2", "/w/inputs/rec.mp4"], true);
  tool("ffmpeg", dir, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=12:c=pink:r=48000:a=0.25:s=1", "-af", "aformat=channel_layouts=stereo", "/w/inputs/voice.wav"], true);
  tool("ffmpeg", dir, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=220:r=48000:d=10", "-f", "lavfi", "-i", "sine=f=330:r=48000:d=10", "-filter_complex", "[0][1]amix=inputs=2,aformat=channel_layouts=stereo", "/w/inputs/music.wav"], true);
  await writeFile(path.join(dir, "inputs/not-audio.wav"), "this is not a sound file\n");
  await chown(path.join(dir, "inputs/not-audio.wav"), 10001, 10001);
  for (let i = 0; i < 3; i++) await writeFile(path.join(dir, `scenes/s${i}.html`), `<!doctype html><html><body style="margin:0;background:#123;color:#fff;font:64px sans-serif;display:grid;place-items:center;height:100vh">Scene ${i + 1}</body></html>`);

  const edit = (segments: { in: number; out: number }[], music: { file: string; volume: number } | null) => ({ type: "edit", width: 1080, height: 1920, fps: 25, fit: "crop", transition: "none", segments: segments.map((s) => ({ src: "inputs/rec.mp4", ...s, volume: 1 })), overlays: [], subtitles: null, audio: { volume: 1, fadeInSec: 0, fadeOutSec: 0, clean: false, music }, sfx: [] });

  await check("a genuine FFmpeg failure (music file that is not audio) still fails the export — not hidden by the report", async () => {
    await assert.rejects(render("bad-music", { ...edit([{ in: 0, out: 4 }], { file: "inputs/not-audio.wav", volume: 0.12 }), output: "out/bad.mp4" }), /failed|error|exited|Invalid/i);
  });
  await check("a good export measures cleanly: lengths, loudness, true peak, no errors", async () => {
    const r = await render<{ audioReport: Report }>("good", { ...edit([{ in: 0, out: 6 }], null), output: "out/good.mp4" });
    assert.deepEqual(r.audioReport.errors, []);
    near(r.audioReport.audioSec ?? -1, 6, 0.025, "audio length");
    near(r.audioReport.videoSec ?? -1, 6, 0.001, "video length");
    assert.ok(r.audioReport.lufs !== null && r.audioReport.truePeakDb !== null && !r.audioReport.silent, JSON.stringify(r.audioReport));
  });

  console.log("\nC. Music mix: full length, no limiter delay, unchanged levels");
  const music = { file: "inputs/music.wav", volume: 0.12 };
  for (const [name, segs] of [["contiguous cuts to the end of the source", [{ in: 0, out: 10 }, { in: 10, out: 20 }]], ["a gap, last cut to the end of the source", [{ in: 0, out: 6 }, { in: 8, out: 20 }]]] as const) {
    await check(`editor + music, ${name}: audio = video length, real sound in the last 50 ms, voice not delayed`, async () => {
      const tag = name.startsWith("contiguous") ? "cont" : "gap";
      await render(`m-${tag}`, { ...edit([...segs], music), output: `out/m-${tag}.mp4` });
      await render(`n-${tag}`, { ...edit([...segs], null), output: `out/n-${tag}.mp4` });
      const len = lengths(dir, `out/m-${tag}.mp4`);
      near(len.audio, len.video, 0.025, "audio vs video length");
      const x = pcm(dir, `out/m-${tag}.mp4`);
      const ref = pcm(dir, `out/n-${tag}.mp4`);
      near(db(rms(x.subarray(x.length - 2400, x.length - 240))), db(rms(x.subarray(SR * 3, SR * 4))), 3, "last 50 ms level vs mid (dB)");
      near(lagMs(x, ref, 1), 0, 0.05, "voice lag at 1 s (ms)");
      near(lagMs(x, ref, len.video - 2), 0, 0.05, "voice lag near the end (ms)");
    });
  }
  await check("editor + music at volume 0: the voice keeps its level + the limiter's usual make-up gain (≈ +0.45 dB, unchanged)", async () => {
    await render("m-mute", { ...edit([{ in: 0, out: 8 }], { ...music, volume: 0 }), output: "out/m-mute.mp4" });
    await render("n-mute", { ...edit([{ in: 0, out: 8 }], null), output: "out/n-mute.mp4" });
    const x = pcm(dir, "out/m-mute.mp4").subarray(SR, SR * 7);
    const ref = pcm(dir, "out/n-mute.mp4").subarray(SR, SR * 7);
    near(db(rms(x)) - db(rms(ref)), 20 * Math.log10(1 / 0.95), 0.1, "gain (dB)");
  });
  for (const narration of [false, true]) {
    await check(`Generator + music, ${narration ? "one narration take" : "per-scene audio"}: audio = video length, voice not delayed`, async () => {
      const tag = narration ? "take" : "scenes";
      const base = { type: "generate", width: 1080, height: 1920, fps: 25, transition: "fade", transitionSec: 0.35, scenes: [0, 1, 2].map((i) => ({ html: `scenes/s${i}.html`, durationSec: 4, audio: narration ? null : "inputs/voice.wav" })), ...(narration ? { narration: { file: "inputs/voice.wav" } } : {}) };
      await render(`g-${tag}`, { ...base, music, output: `out/g-${tag}.mp4` });
      await render(`gn-${tag}`, { ...base, output: `out/gn-${tag}.mp4` });
      const len = lengths(dir, `out/g-${tag}.mp4`);
      near(len.audio, len.video, 0.025, "audio vs video length");
      near(lagMs(pcm(dir, `out/g-${tag}.mp4`), pcm(dir, `out/gn-${tag}.mp4`), 1), 0, 0.05, "voice lag (ms)");
    });
  }
}

async function main() {
  await partA();
  if (!PURE) await partBC();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
