/**
 * AI Video Editor — Phase 4 sound-effect timeline regression (scratch only: no AI, no database, no
 * network inside the render container, synthetic media).
 *
 *   A. catalogue: every bundled WAV exists, matches its SHA-256, is 48 kHz PCM with the listed length,
 *      peak level and peak time; no stray files.
 *   B. editor model: never added by default, parsing/clamping of offsets, trims, volume, fades, anchors
 *      that follow cuts and overlays through trims, reorders, splits, transitions and deletions,
 *      pre-render warnings, invalid input.
 *   C. job-log audio report text.
 *   D. real exports through the isolated render container (production limits: 1 CPU, 1536 MB), from a
 *      synthetic test-pattern source: 9:16 and 16:9, with and without effects. Checks the MP4 (H.264 +
 *      AAC 48 kHz stereo), audio vs video stream lengths, effect onsets in the output (silencedetect),
 *      trim, volume and fade levels (volumedetect), the limiter on stacked effects, the measured
 *      loudness report, and refusal of invalid effect tasks. Container memory is sampled every second.
 *
 *   set -a; . <scratch env with VIDEO_STUDIO_DIR + VIDEO_RENDER_INSTANCE>; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-video-sfx.ts [--pure] [shotsDir]
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chown, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SFX_LIBRARY, SFX_MAP, sfxUrl } from "@/lib/video-studio/sfx";
import {
  LIMITS,
  defaultProject,
  outputDuration,
  parseEditProject,
  segmentOffsets,
  sfxChecks,
  sfxRenderList,
  sfxTimeline,
  splitAt,
  type EditAsset,
  type EditProject,
  type EditSfx,
} from "@/lib/video-studio/editor-model";
import { audioReportText, type AudioReport } from "@/lib/video-studio/pipeline";

const PURE = process.argv.includes("--pure");
const SHOTS = process.argv.filter((a) => !a.startsWith("--"))[2] ?? "/root/mts-scratch/media-studio/shots/p4-sfx";
const ROOT = process.env.VIDEO_STUDIO_DIR ?? "";
const INSTANCE = process.env.VIDEO_RENDER_INSTANCE ?? "";
if (!PURE && (!ROOT.startsWith("/root/mts-scratch/") || !INSTANCE || INSTANCE === "1")) {
  console.error("Refusing to run: needs a /root/mts-scratch/ VIDEO_STUDIO_DIR and a non-production VIDEO_RENDER_INSTANCE (or --pure).");
  process.exit(2);
}

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
const throws = (fn: () => unknown, re?: RegExp) => {
  try {
    fn();
  } catch (e) {
    if (re) assert.match(String((e as Error).message), re);
    return true;
  }
  return false;
};
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

// ---- A. catalogue ---------------------------------------------------------------------------

const SFX_DIR = path.join(process.cwd(), "public/video-studio/sfx");

/** Minimal RIFF/WAVE reader: format + peak (absolute sample, all channels) and its time. */
function readWav(buf: Buffer) {
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    if (id === "data") data = body;
    off += 8 + size + (size % 2);
  }
  assert.ok(fmt && data, "fmt and data chunks");
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const fmtCode = fmt.format === 0xfffe ? (fmt.bits === 32 ? 3 : 1) : fmt.format; // WAVE_FORMAT_EXTENSIBLE: assume PCM / float by size
  let peak = 0;
  let peakFrame = 0;
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      const v = fmtCode === 3 ? data.readFloatLE(o) : bytes === 2 ? data.readInt16LE(o) / 32768 : bytes === 3 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648;
      if (Math.abs(v) > peak) [peak, peakFrame] = [Math.abs(v), i];
    }
  return { ...fmt, durationSec: frames / fmt.rate, peakDbfs: 20 * Math.log10(peak), peakAtSec: peakFrame / fmt.rate };
}

async function partA() {
  console.log("\nA. Sound-effect catalogue (public/video-studio/sfx)");
  await check("16 sounds, unique keys, every category used, file = <key>.wav, preview URL under /video-studio/sfx", () => {
    assert.equal(SFX_LIBRARY.length, 16);
    assert.equal(new Set(SFX_LIBRARY.map((s) => s.key)).size, 16);
    for (const s of SFX_LIBRARY) {
      assert.equal(s.file, `${s.key}.wav`);
      assert.match(s.file, /^[a-z0-9_]{1,60}\.wav$/, "file name accepted by render.mjs");
      assert.equal(sfxUrl(s.key), `/video-studio/sfx/${s.file}`);
    }
    assert.equal(sfxUrl("nope"), null);
    assert.equal(new Set(SFX_LIBRARY.map((s) => s.category)).size, 5);
  });
  await check("the folder holds exactly the catalogue's files (nothing unlisted is served or mounted)", async () => {
    const files = (await readdir(SFX_DIR)).sort();
    assert.deepEqual(files, SFX_LIBRARY.map((s) => s.file).sort());
  });
  await check("every file matches its recorded SHA-256", async () => {
    for (const s of SFX_LIBRARY) assert.equal(crypto.createHash("sha256").update(await readFile(path.join(SFX_DIR, s.file))).digest("hex"), s.sha256, s.key);
  });
  await check("every file is 48 kHz PCM; length, peak level (−3 dBFS) and peak time match the catalogue", async () => {
    for (const s of SFX_LIBRARY) {
      const w = readWav(await readFile(path.join(SFX_DIR, s.file)));
      assert.equal(w.rate, 48000, s.key);
      assert.ok(w.channels === 1 || w.channels === 2, `${s.key} channels ${w.channels}`);
      near(w.durationSec, s.durationSec, 0.002, `${s.key} duration`);
      near(w.peakDbfs, s.peakDbfs, 0.1, `${s.key} peak`);
      near(w.peakAtSec, s.peakAtSec, 0.002, `${s.key} peak time`);
      assert.ok((await stat(path.join(SFX_DIR, s.file))).size < 1_000_000, `${s.key} is small`);
    }
  });
}

// ---- B. editor model ------------------------------------------------------------------------

const SRC = "inputs/src.mp4";
const SRC2 = "inputs/tone.mp4";
const ASSETS: EditAsset[] = [
  { key: SRC, kind: "video", durationSec: 8, hasAudio: true },
  { key: SRC2, kind: "video", durationSec: 8, hasAudio: true },
];
const clip = (key: string, x: Partial<EditSfx> = {}): EditSfx => ({ id: `sfx${key.replace(/[^a-z]/g, "").slice(0, 10)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 24), key, start: 0, anchor: null, offsetSec: 0, trimIn: 0, trimOut: SFX_MAP[key].durationSec, volume: 1, fadeInSec: 0, fadeOutSec: 0, ...x });
const base = (): EditProject => parseEditProject({ ...defaultProject(ASSETS[0], "9:16", "minimal_professional", 12), segments: [{ id: "segaaaa1", src: SRC, in: 0, out: 4, volume: 1 }, { id: "segbbbb2", src: SRC, in: 4, out: 8, volume: 1 }] }, ASSETS);

function partB() {
  console.log("\nB. Editor model: sound-effect clips on the output timeline");
  return (async () => {
    await check("never automatic: a new project and a project saved before effects existed have none", () => {
      const p = defaultProject(ASSETS[0], "16:9", "minimal_professional", 12);
      assert.deepEqual(p.sfx, []);
      const legacy = { ...p } as Partial<EditProject>;
      delete legacy.sfx;
      assert.deepEqual(parseEditProject(legacy, ASSETS).sfx, []);
      assert.deepEqual(sfxTimeline(parseEditProject(legacy, ASSETS)), []);
      assert.deepEqual(sfxChecks(parseEditProject(legacy, ASSETS)), []);
    });
    await check("a fixed-time clip keeps its position, trim, volume and fades through save/parse", () => {
      const c = clip("correct_chime", { start: 2.5, trimIn: 0.1, trimOut: 1.1, volume: 0.6, fadeInSec: 0.05, fadeOutSec: 0.3 });
      const p = parseEditProject({ ...base(), sfx: [c] }, ASSETS);
      assert.deepEqual(p.sfx, [c]);
      const [r] = sfxTimeline(p);
      assert.deepEqual({ start: r.start, duration: r.duration, trimIn: r.trimIn, volume: r.volume, fi: r.fadeInSec, fo: r.fadeOutSec, file: r.file }, { start: 2.5, duration: 1, trimIn: 0.1, volume: 0.6, fi: 0.05, fo: 0.3, file: "correct_chime.wav" });
      assert.deepEqual(sfxRenderList(p), [{ file: "correct_chime.wav", start: 2.5, duration: 1, trimIn: 0.1, volume: 0.6, fadeInSec: 0.05, fadeOutSec: 0.3 }]);
    });
    await check("out-of-range values are clamped: volume ≤ 1.5, trims inside the file, fades ≤ half the clip, offset ±5 s, start inside the video", () => {
      const p = parseEditProject({ ...base(), sfx: [{ ...clip("text_pop"), start: 99, volume: 9, trimIn: -1, trimOut: 50, fadeInSec: 5, fadeOutSec: -2, offsetSec: 12 }] }, ASSETS);
      const c = p.sfx[0];
      assert.equal(c.volume, 1.5);
      assert.equal(c.trimIn, 0);
      assert.equal(c.trimOut, SFX_MAP.text_pop.durationSec);
      assert.equal(c.fadeInSec, Math.round((SFX_MAP.text_pop.durationSec / 2) * 1000) / 1000);
      assert.equal(c.fadeOutSec, 0);
      assert.equal(c.offsetSec, 5);
      assert.ok(c.start <= outputDuration(p) - 0.05);
      const q = parseEditProject({ ...base(), sfx: [{ ...clip("typing_run"), trimIn: 1.5, trimOut: 0.2 }] }, ASSETS).sfx[0];
      assert.ok(q.trimOut - q.trimIn >= 0.049, `trimOut ${q.trimOut} after trimIn ${q.trimIn}`);
    });
    await check("invalid input: unknown sound refused; non-numeric fields fall back; bad ids replaced; bad anchors dropped; at most 40 clips", () => {
      assert.ok(throws(() => parseEditProject({ ...base(), sfx: [{ ...clip("text_pop"), key: "../../etc/passwd" }] }, ASSETS), /unknown sound/));
      assert.ok(throws(() => parseEditProject({ ...base(), sfx: [{ key: 7 }] }, ASSETS), /unknown sound/));
      const p = parseEditProject({ ...base(), sfx: [{ key: "ui_blip", id: "BAD ID!", start: "3", volume: null, anchor: { kind: "segment", id: "segaaaa1" } }, { key: "ui_blip", anchor: { kind: "cut", id: "x" } }] }, ASSETS);
      assert.match(p.sfx[0].id, /^[a-z0-9]{4,24}$/);
      assert.notEqual(p.sfx[0].id, "BAD ID!");
      assert.equal(p.sfx[0].start, 0);
      assert.equal(p.sfx[0].volume, 1);
      assert.equal(p.sfx[0].anchor, null);
      assert.equal(p.sfx[1].anchor, null);
      const many = parseEditProject({ ...base(), sfx: Array.from({ length: 55 }, () => clip("ui_blip")) }, ASSETS);
      assert.equal(many.sfx.length, LIMITS.sfx);
      assert.equal(LIMITS.sfx, 40);
    });
    await check("a clip anchored to a cut follows it when the segment before it is trimmed", () => {
      const p = base();
      p.sfx = [clip("transition_whoosh", { anchor: { kind: "cut", id: "segbbbb2" }, offsetSec: -SFX_MAP.transition_whoosh.peakAtSec, start: 4 })];
      near(sfxTimeline(p)[0].start, 4 - SFX_MAP.transition_whoosh.peakAtSec, 0.0005, "before trim");
      const q = { ...p, segments: [{ ...p.segments[0], in: 1.5 }, p.segments[1]] };
      near(sfxTimeline(q)[0].start, 2.5 - SFX_MAP.transition_whoosh.peakAtSec, 0.0005, "after trimming 1.5 s off the first segment");
      // The peak lands on the cut:
      near(sfxTimeline(q)[0].start + SFX_MAP.transition_whoosh.peakAtSec, segmentOffsets(q)[1], 0.0005, "peak on the cut");
    });
    await check("…and when segments are reordered, and when a fade transition shortens the timeline", () => {
      const p = parseEditProject({ ...base(), segments: [{ id: "segaaaa1", src: SRC, in: 0, out: 3, volume: 1 }, { id: "segbbbb2", src: SRC, in: 3, out: 5, volume: 1 }, { id: "segcccc3", src: SRC, in: 5, out: 8, volume: 1 }] }, ASSETS);
      p.sfx = [clip("text_pop", { anchor: { kind: "cut", id: "segcccc3" } })];
      assert.equal(sfxTimeline(p)[0].start, 5);
      const swapped = { ...p, segments: [p.segments[1], p.segments[0], p.segments[2]] };
      assert.equal(sfxTimeline(swapped)[0].start, 5, "same total before it");
      const first = { ...p, segments: [p.segments[2], p.segments[0], p.segments[1]] };
      assert.equal(sfxTimeline(first)[0].start, 0, "moved to the front");
      const faded = { ...p, transition: "fade" as const };
      near(sfxTimeline(faded)[0].start, segmentOffsets(faded)[2], 0.0005, "fade");
      near(sfxTimeline(faded)[0].start, 5 - 2 * 0.5, 0.0005, "two 0.5 s crossfades before the cut");
    });
    await check("a split keeps the anchored cut (the first half keeps the segment id)", () => {
      const p = base();
      p.sfx = [clip("bullet_tick", { anchor: { kind: "cut", id: "segbbbb2" } }), clip("ui_blip", { anchor: { kind: "cut", id: "segaaaa1" } })];
      const q = splitAt(p, 2)!;
      assert.equal(q.segments.length, 3);
      assert.deepEqual(sfxTimeline(q).map((c) => c.start), [0, 4]);
    });
    await check("a clip anchored to an overlay follows the overlay when it moves", () => {
      const p = base();
      p.overlays = [{ id: "ovtext01", kind: "text", start: 1, end: 3, text: "Troponin I", style: "title", position: "top" }];
      p.sfx = [clip("text_pop", { anchor: { kind: "overlay", id: "ovtext01" }, offsetSec: 0.1 })];
      near(sfxTimeline(p)[0].start, 1.1, 0.0005, "on the overlay");
      p.overlays = [{ ...p.overlays[0], start: 5.5, end: 7 }];
      near(sfxTimeline(p)[0].start, 5.6, 0.0005, "after the move");
    });
    await check("deleting the anchored event keeps the clip at its stored time and warns (SFX_ORPHANED)", () => {
      const p = base();
      p.sfx = [clip("transition_swipe", { id: "orphan01", anchor: { kind: "cut", id: "segbbbb2" }, start: 3.2 })];
      const q = { ...p, segments: [p.segments[0]] };
      const [r] = sfxTimeline(q);
      assert.equal(r.orphaned, true);
      assert.equal(r.start, 3.2);
      assert.ok(sfxChecks(q).some((c) => c.code === "SFX_ORPHANED:orphan01" && c.severity === "warn"));
      assert.equal(sfxTimeline(p)[0].orphaned, false);
    });
    await check("timing edge cases: negative start clamps to 0; a clip past the end is dropped (SFX_AFTER_END); one running past the end is cut (SFX_CUT_OFF); list sorted", () => {
      const p = base();
      p.sfx = [clip("correct_chime", { id: "cutoff01", start: 7.2 }), clip("transition_whip", { anchor: { kind: "cut", id: "segaaaa1" }, offsetSec: -1 }), clip("ui_blip", { start: 7.99 })];
      const q = { ...p, segments: p.segments.map((s, i) => (i === 1 ? { ...s, out: 7.5 } : s)) };
      const list = sfxTimeline(q);
      assert.deepEqual(list.map((c) => c.key), ["transition_whip", "correct_chime"]);
      assert.equal(list[0].start, 0);
      near(list[1].duration, 7.5 - 7.2, 0.0005, "cut at the end");
      const codes = sfxChecks(q).map((c) => c.code);
      assert.ok(codes.includes("SFX_AFTER_END") && codes.includes("SFX_CUT_OFF:cutoff01"), codes.join());
    });
    await check("loudness warning only when overlapping clips could squash (SFX_LOUD); density hint (SFX_DENSE)", () => {
      const p = base();
      p.sfx = [clip("emphasis_drop", { start: 2, volume: 0.7 })];
      assert.ok(!sfxChecks(p).some((c) => c.code === "SFX_LOUD"), "one clip at 0.7 is fine");
      p.sfx = [1, 2, 3].map(() => clip("emphasis_drop", { start: 2, volume: 1.5 }));
      const loud = sfxChecks(p).find((c) => c.code === "SFX_LOUD");
      assert.ok(loud && /2\.0 s/.test(loud.message), JSON.stringify(sfxChecks(p)));
      p.sfx = Array.from({ length: 8 }, (_, i) => clip("ui_blip", { start: i, volume: 0.3 }));
      assert.ok(sfxChecks(p).some((c) => c.code === "SFX_DENSE"));
    });
  })();
}

// ---- C. job-log report ----------------------------------------------------------------------

async function partC() {
  console.log("\nC. Audio report text (job log)");
  const r = (x: Partial<AudioReport>): AudioReport => ({ lufs: -15, truePeakDb: -1.5, audioSec: 10, videoSec: 10, ...x });
  await check("normal export: measurements only, no warning", () => {
    const t = audioReportText(r({}));
    assert.match(t, /-15\.0 LUFS, true peak -1\.5 dBTP, audio 10\.00 s \/ video 10\.00 s\./);
    assert.ok(!/Warning/.test(t));
  });
  await check("warnings: near-clipping peak, quiet, very loud, A/V length mismatch; unmeasured stays honest", () => {
    assert.match(audioReportText(r({ truePeakDb: -0.2 })), /close to clipping/);
    assert.match(audioReportText(r({ lufs: -30 })), /quiet for phone playback/);
    assert.match(audioReportText(r({ lufs: -7 })), /very loud/);
    assert.match(audioReportText(r({ audioSec: 9.7 })), /differ by 0\.30 s/);
    assert.ok(!/differ/.test(audioReportText(r({ audioSec: 10.05 }))), "AAC priming within 0.1 s is fine");
    const u = audioReportText(r({ lufs: null, truePeakDb: null }));
    assert.match(u, /loudness not measured, true peak n\/a/);
    assert.ok(!/Warning/.test(u));
  });
}

// ---- D. real exports ------------------------------------------------------------------------

const run = promisify(execFile);
const IMAGE = "mts-video-render:1";
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

/** ffmpeg/ffprobe inside the render image, read-only, no network; returns stdout + stderr. */
function tool(bin: "ffmpeg" | "ffprobe", dir: string, args: string[], rw = false) {
  const r = spawnSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${dir}:/w:${rw ? "rw" : "ro"}`, "--entrypoint", bin, IMAGE, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr.slice(-500)}`);
  return { out: r.stdout, err: r.stderr };
}

function probeStreams(dir: string, file: string) {
  return JSON.parse(tool("ffprobe", dir, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,sample_rate,channels,duration,avg_frame_rate,pix_fmt:format=duration", "-of", "json", `/w/${file}`]).out) as {
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; sample_rate?: string; channels?: number; duration?: string; avg_frame_rate?: string; pix_fmt?: string }[];
    format: { duration: string };
  };
}

/** Start times of sound (ends of silences) in the output's audio. */
function onsets(dir: string, file: string, noiseDb = -50): number[] {
  const { err } = tool("ffmpeg", dir, ["-hide_banner", "-nostdin", "-i", `/w/${file}`, "-map", "0:a:0", "-af", `silencedetect=noise=${noiseDb}dB:d=0.04`, "-f", "null", "-"]);
  return [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
}
function silenceStarts(dir: string, file: string, noiseDb = -50): number[] {
  const { err } = tool("ffmpeg", dir, ["-hide_banner", "-nostdin", "-i", `/w/${file}`, "-map", "0:a:0", "-af", `silencedetect=noise=${noiseDb}dB:d=0.04`, "-f", "null", "-"]);
  return [...err.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
}
/** Max level (dBFS) of the output's audio in [start, start + dur). */
function maxDb(dir: string, file: string, start: number, dur: number): number {
  const { err } = tool("ffmpeg", dir, ["-hide_banner", "-nostdin", "-i", `/w/${file}`, "-map", "0:a:0", "-af", `atrim=start=${start}:duration=${dur},volumedetect`, "-f", "null", "-"]);
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(err);
  return m && m[1] !== "-inf" ? Number(m[1]) : -120;
}

type Measure = { tag: string; renderSec: number; peakMiB: number; samples: number; videoSec: number; audio: string; sfx: number; report?: AudioReport };
const measures: Measure[] = [];

async function partD() {
  const { ensureJobDir } = await import("@/lib/video-studio/storage");
  const { runRenderTask } = await import("@/lib/video-studio/render-runner");
  const { ASPECT_MAP } = await import("@/lib/video-studio/types");
  console.log("\nD. Real exports through the render container (synthetic source, production limits 1 CPU / 1536 MB)");
  await mkdir(SHOTS, { recursive: true });
  const jobId = "p4sfxsuite0000000000";
  const dir = await ensureJobDir(jobId);
  await mkdir(path.join(dir, "inputs"), { recursive: true });
  await mkdir(path.join(dir, "out"), { recursive: true });
  for (const d of [dir, path.join(dir, "inputs"), path.join(dir, "out")]) await chown(d, 10001, 10001);

  await check("synthetic sources: 8 s 1280×720 test pattern with SILENT audio, and one with a quiet 220 Hz tone (≈ −42 dBFS: lavfi sine is 1/8 scale, −24 dB)", () => {
    tool("ffmpeg", dir, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=8", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "8", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", `/w/${SRC}`], true);
    tool("ffmpeg", dir, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=25:d=8", "-f", "lavfi", "-i", "sine=f=220:r=48000:d=8", "-t", "8", "-af", "volume=-24dB", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ac", "2", "-shortest", `/w/${SRC2}`], true);
    const pr = probeStreams(dir, SRC);
    near(Number(pr.format.duration), 8, 0.1, "source duration");
  });

  /** Mirrors pipeline.ts runExport's task for an EditProject (no overlays / subtitles here). */
  async function exportEdit(tag: string, p: EditProject, extra: Record<string, unknown> = {}) {
    const { width, height } = ASPECT_MAP[p.aspect];
    const task = { type: "edit", width, height, fps: 25, fit: p.fit, transition: p.transition, segments: p.segments.map((s) => ({ src: s.src, in: s.in, out: s.out, volume: s.volume })), overlays: [], subtitles: null, audio: { volume: p.audio.volume, fadeInSec: p.audio.fadeInSec, fadeOutSec: p.audio.fadeOutSec, clean: p.audio.clean, music: null }, sfx: sfxRenderList(p), output: `out/${tag}.mp4`, ...extra };
    let done = false;
    let peak = 0;
    let samples = 0;
    const t0 = Date.now();
    const sampler = (async () => {
      while (!done) {
        const m = await memMiB().catch(() => 0);
        if (m > 0) samples++;
        peak = Math.max(peak, m);
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    try {
      const r = await runRenderTask<{ output: string; durationSec: number; sfxCount: number; audioReport: AudioReport }>(jobId, `export-${tag}`.slice(0, 30), task, { limits: { cpus: 1, memoryMb: 1536 }, timeoutSec: 900 });
      return { r, renderSec: (Date.now() - t0) / 1000, peak, samples };
    } finally {
      done = true;
      await sampler;
    }
  }

  async function validate(tag: string, p: EditProject, res: Awaited<ReturnType<typeof exportEdit>>) {
    const file = `out/${tag}.mp4`;
    const pr = probeStreams(dir, file);
    const v = pr.streams.find((s) => s.codec_type === "video")!;
    const a = pr.streams.find((s) => s.codec_type === "audio")!;
    const { width, height } = ASPECT_MAP[p.aspect];
    assert.equal(`${v.codec_name} ${v.width}x${v.height} ${v.pix_fmt} ${v.avg_frame_rate}`, `h264 ${width}x${height} yuv420p 25/1`);
    assert.equal(`${a.codec_name} ${a.sample_rate} ${a.channels}`, "aac 48000 2");
    const want = outputDuration(p);
    near(Number(pr.format.duration), want, 0.1, "container duration");
    // One AAC frame (21 ms): the effects mix once ended ~53 ms early on multi-segment edits.
    near(Number(a.duration), Number(v.duration), 0.025, "audio vs video stream length");
    const rep = res.r.audioReport;
    assert.ok(rep, "audio report returned");
    assert.deepEqual(rep.errors ?? [], [], "every measurement available");
    assert.ok(rep.audioSec !== null && rep.videoSec !== null, "both stream lengths measured");
    near(rep.audioSec, Number(a.duration), 0.01, "report audio length");
    near(rep.videoSec, Number(v.duration), 0.01, "report video length");
    assert.equal(res.r.sfxCount, sfxRenderList(p).length);
    measures.push({ tag, renderSec: Math.round(res.renderSec), peakMiB: Math.round(res.peak), samples: res.samples, videoSec: Number(Number(pr.format.duration).toFixed(2)), audio: `${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch`, sfx: res.r.sfxCount, report: rep });
    await writeFile(path.join(SHOTS, `${tag}.mp4`), await readFile(path.join(dir, file)));
    return { rep, file };
  }

  // D1/D2 — the same 2-segment fade edit, 9:16 and 16:9, without effects (regression) and with.
  for (const aspect of ["9:16", "16:9"] as const) {
    const plain = { ...base(), aspect, transition: "fade" as const, segments: [{ id: "segaaaa1", src: SRC2, in: 0, out: 4, volume: 1 }, { id: "segbbbb2", src: SRC2, in: 4, out: 8, volume: 1 }] };
    const ar = aspect.replace(":", "x");
    await check(`${aspect} without effects: valid MP4, the tone's level unchanged by the edit, report measured (no sound-effect inputs)`, async () => {
      const res = await exportEdit(`plain-${ar}`, plain);
      const { rep, file } = await validate(`plain-${ar}`, plain, res);
      assert.equal(res.r.sfxCount, 0);
      const src = maxDb(dir, SRC2, 1, 2);
      near(maxDb(dir, file, 1, 2), src, 0.5, "tone level vs source");
      near(rep.truePeakDb ?? 0, src, 1.5, "report true peak vs source level");
      assert.ok(rep.lufs !== null && rep.lufs < -40 && rep.lufs > -52, `tone loudness ${rep.lufs}`);
      assert.match(audioReportText(rep), /quiet for phone playback/, "a quiet export is flagged");
    });
    await check(`${aspect} with effects: anchored whoosh peaks on the crossfaded cut, pop on an overlay time, chime trimmed; A/V in sync`, async () => {
      const p: EditProject = { ...plain, segments: plain.segments.map((s) => ({ ...s, src: SRC })), sfx: [clip("text_pop", { start: 1 }), clip("transition_whoosh", { anchor: { kind: "cut", id: "segbbbb2" }, offsetSec: -SFX_MAP.transition_whoosh.peakAtSec }), clip("correct_chime", { start: 6, trimOut: 0.6, fadeOutSec: 0.05 })] };
      const res = await exportEdit(`sfx-${ar}`, p);
      const { rep, file } = await validate(`sfx-${ar}`, p, res);
      const list = sfxTimeline(p);
      const cut = segmentOffsets(p)[1];
      near(cut, 3.5, 0.0005, "crossfaded cut");
      const on = onsets(dir, file);
      // Silent source: sound appears exactly where the effects were placed (AAC frame ≈ 21 ms; detector granularity).
      for (const c of list) assert.ok(on.some((t) => Math.abs(t - c.start) <= 0.06), `onset near ${c.start} (${c.key}); got ${on.join(", ")}`);
      const whoosh = list.find((c) => c.key === "transition_whoosh")!;
      near(whoosh.start + SFX_MAP.transition_whoosh.peakAtSec, cut, 0.0005, "whoosh peak on the cut");
      const ends = silenceStarts(dir, file);
      assert.ok(ends.some((t) => Math.abs(t - 6.6) <= 0.06), `chime trimmed at 6.6 s; silences start at ${ends.join(", ")}`);
      assert.ok(maxDb(dir, file, 0, 0.9) < -60, "silence before the first effect");
      assert.ok(rep.truePeakDb !== null && rep.truePeakDb <= 0.5, `true peak ${rep.truePeakDb}`);
      await writeFile(path.join(SHOTS, `sfx-${ar}-onsets.json`), JSON.stringify({ placed: list.map((c) => ({ key: c.key, start: c.start, end: c.start + c.duration })), onsets: on, silenceStarts: ends, report: rep }, null, 1));
    });
  }

  // D3 — hard cuts with a gap (concatenated soundtrack) + effects: the voice runs to the last frame.
  await check("hard cuts with a gap + effects: audio as long as the video, and the source's own sound still in the last 50 ms", async () => {
    const p: EditProject = { ...base(), transition: "none", segments: [{ id: "segaaaa1", src: SRC2, in: 0, out: 3, volume: 1 }, { id: "segbbbb2", src: SRC2, in: 4, out: 8, volume: 1 }], sfx: [clip("text_pop", { start: 1 }), clip("transition_whoosh", { anchor: { kind: "cut", id: "segbbbb2" }, offsetSec: -SFX_MAP.transition_whoosh.peakAtSec })] };
    const res = await exportEdit("sfx-hardcut", p);
    const { rep, file } = await validate("sfx-hardcut", p, res);
    near(rep.audioSec!, rep.videoSec!, 0.025, "report: audio vs video length");
    near(maxDb(dir, file, outputDuration(p) - 0.06, 0.05), maxDb(dir, SRC2, 1, 2), 1, "tone level in the last 50 ms vs source");
  });

  await check("16:9 levels: volume 0.5 is −6 dB of volume 1; a 0.4 s fade-in starts ≥ 12 dB quieter; trim ends the sound", async () => {
    const p: EditProject = { ...base(), aspect: "16:9", segments: [{ id: "segaaaa1", src: SRC, in: 0, out: 8, volume: 1 }], sfx: [clip("correct_chime", { start: 1, trimOut: 0.5 }), clip("correct_chime", { start: 3, trimOut: 0.5, volume: 0.5 }), clip("correct_chime", { start: 5, trimOut: 0.5, fadeInSec: 0.4 })] };
    const res = await exportEdit("levels-16x9", p);
    const { file } = await validate("levels-16x9", p, res);
    const full = maxDb(dir, file, 1, 0.5);
    const half = maxDb(dir, file, 3, 0.5);
    near(full - half, 6.02, 1, "volume 0.5");
    const headFull = maxDb(dir, file, 1, 0.06);
    const headFade = maxDb(dir, file, 5, 0.06);
    assert.ok(headFull - headFade >= 12, `fade-in head ${headFade} vs ${headFull} dB`);
    for (const t of [1.5, 3.5, 5.5]) assert.ok(maxDb(dir, file, t + 0.06, 0.3) < -55, `silent after the trim at ${t}`);
    near(full, -3, 1.5, "unity clip peak ≈ file peak (−3 dBFS)");
  });

  await check("stacked effects at volume 1.5 + tone: the −1 dBFS limiter keeps the true peak ≤ 0 dBTP; the report flags a peak only above −0.5 dBTP", async () => {
    const p: EditProject = { ...base(), aspect: "9:16", segments: [{ id: "segaaaa1", src: SRC2, in: 0, out: 6, volume: 1 }], sfx: [1, 2, 3, 4].map(() => clip("emphasis_drop", { start: 2, volume: 1.5 })) };
    assert.ok(sfxChecks(p).some((c) => c.code === "SFX_LOUD"), "pre-render warning");
    const res = await exportEdit("stacked-9x16", p);
    const { rep, file } = await validate("stacked-9x16", p, res);
    assert.ok(rep.truePeakDb !== null && rep.truePeakDb <= 0, `true peak ${rep.truePeakDb} dBTP (limiter −1 dBFS + AAC overshoot)`);
    assert.ok(maxDb(dir, file, 1.9, 0.5) <= -0.5, "no samples near full scale");
    const text = audioReportText(rep);
    assert.ok(/close to clipping/.test(text) === (rep.truePeakDb > -0.5), text);
  });

  await check("invalid effect tasks are refused by the container: path outside /sfx, unknown file, volume > 1.5, start after the end, > 40 clips", async () => {
    const p: EditProject = { ...base(), aspect: "16:9", segments: [{ id: "segaaaa1", src: SRC, in: 0, out: 3, volume: 1 }] };
    const ok = { file: "ui_blip.wav", start: 0.5, duration: 0.1, trimIn: 0, volume: 1, fadeInSec: 0, fadeOutSec: 0 };
    const bad: [string, unknown[], RegExp][] = [
      ["traversal", [{ ...ok, file: "../work/inputs/src.mp4" }], /Invalid sound effect/],
      ["abs", [{ ...ok, file: "/etc/passwd" }], /Invalid sound effect/],
      ["missing", [{ ...ok, file: "no_such_sound.wav" }], /No such file|exited with/],
      ["vol", [{ ...ok, volume: 3 }], /Invalid sound effect volume/],
      ["late", [{ ...ok, start: 9 }], /Invalid sound effect start/],
      ["many", Array.from({ length: 41 }, () => ok), /At most 40 sound effects/],
    ];
    for (const [tag, sfx, re] of bad) {
      let err = "";
      await exportEdit(`bad-${tag}`, p, { sfx }).catch((e: Error) => (err = e.message));
      assert.match(err, re, `${tag}: ${err || "rendered"}`);
    }
  });
}

async function main() {
  await partA();
  await partB();
  await partC();
  if (!PURE) await partD();
  if (measures.length) {
    await mkdir(SHOTS, { recursive: true });
    await writeFile(path.join(SHOTS, "measures.json"), JSON.stringify(measures, null, 1));
    console.log("\nRenders:");
    for (const m of measures) console.log(`  ${m.tag}: ${m.videoSec} s, ${m.audio}, ${m.sfx} effect(s), rendered in ${m.renderSec} s, peak ${m.peakMiB} MiB (${m.samples} samples)${m.report ? `, ${m.report.lufs ?? "n/a"} LUFS, TP ${m.report.truePeakDb ?? "n/a"} dBTP` : ""}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
