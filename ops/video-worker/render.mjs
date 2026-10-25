/**
 * AI Video Studio — render task runner. Runs INSIDE the isolated render
 * container (ops/video-worker/Dockerfile): no network, read-only root, non-root.
 *
 *   node /opt/render/render.mjs <task.json>        (path relative to /work)
 *
 * /work  = the job folder (read-write) — every input and output path in a task
 *          is RELATIVE to it and validated (no "..", no absolute paths, a fixed
 *          character set), so a task can never reach anything else.
 * /fonts = the bundled video fonts (read-only).
 *
 * Tasks (task.type):
 *   probe     ffprobe a list of files → durations, streams.
 *   generate  scene HTML documents (+ narration audio, optional music) → MP4.
 *             Narration is either one file per scene (Generator) or ONE continuous
 *             track for the whole video (task.narration, Motion Workflow Studio).
 *             Frames are drawn by Chromium from the same HTML the admin preview
 *             shows; every CSS animation is paused and seeked per frame (Web
 *             Animations API), so rendering is deterministic. Frames that are
 *             identical to the previous one (nothing animating) are not
 *             re-captured: the previous frame is held (concat durations).
 *   proxy     uploaded video → small H.264 preview + timeline thumbnails.
 *   audio     a video's audio → compact mono MP3 (for transcription).
 *   edit      an edit decision list (segments, aspect, overlays, subtitles,
 *             audio settings) → MP4.
 *
 * FFmpeg / ffprobe run as child processes with argument arrays (never a shell).
 * Progress goes to task.progress (JSON, throttled); the result to task.result.
 * Any failure writes { ok: false, error } and exits 1. The output MP4 is
 * validated with ffprobe (codecs, size, duration) before ok: true.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const WORK = "/work";
const FONTS = "/fonts";
const ORIGIN = "http://render.local";
const REL = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

function rel(p) {
  if (typeof p !== "string" || !REL.test(p) || p.includes("..") || p.includes("//")) throw new Error(`Invalid path in task: ${String(p).slice(0, 60)}`);
  return path.join(WORK, p);
}
const num = (v, lo, hi, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`Invalid ${name}: ${v}`);
  return n;
};
const r3 = (n) => Math.round(n * 1000) / 1000;

function run(cmd, args, { timeoutMs = 30 * 60_000, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${path.basename(cmd)} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err = (err + s).slice(-4000);
      onStderr?.(s);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${err.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 600)}`));
    });
  });
}

let task;
let lastProgress = 0;
async function progress(stage, pct, extra = {}, force = false) {
  if (!task?.progress) return;
  const now = Date.now();
  if (!force && now - lastProgress < 1000) return;
  lastProgress = now;
  const file = rel(task.progress);
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ stage, pct: Math.max(0, Math.min(100, Math.round(pct))), at: new Date().toISOString(), ...extra }));
  await fs.rename(`${file}.tmp`, file);
}

// ---- probe ---------------------------------------------------------------------------------

async function probeFile(abs) {
  const raw = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", abs], { timeoutMs: 60_000 });
  const j = JSON.parse(raw.toString());
  const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
  const fps = v?.avg_frame_rate && v.avg_frame_rate !== "0/0" ? v.avg_frame_rate.split("/").reduce((x, y) => Number(x) / Number(y)) : null;
  const rot = Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0);
  const swap = Math.abs(rot) % 180 === 90;
  return {
    durationSec: Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0,
    formatName: String(j.format?.format_name ?? ""),
    sizeBytes: Number(j.format?.size ?? 0),
    video: v ? { codec: v.codec_name, width: swap ? v.height : v.width, height: swap ? v.width : v.height, fps: fps ? r3(fps) : null, pixFmt: v.pix_fmt ?? null } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels ?? null, sampleRate: Number(a.sample_rate ?? 0) || null } : null,
  };
}

async function doProbe(t) {
  const files = {};
  for (const f of t.files ?? []) {
    try {
      files[f] = await probeFile(rel(f));
    } catch (e) {
      files[f] = { error: String(e.message ?? e).slice(0, 300) };
    }
  }
  return { files };
}

/** The output must really be what was asked for before a job may say "completed". */
async function validateOutput(abs, want) {
  const p = await probeFile(abs);
  const problems = [];
  if (!p.video) problems.push("no video stream");
  else {
    if (p.video.codec !== "h264") problems.push(`video codec ${p.video.codec}`);
    if (p.video.width !== want.width || p.video.height !== want.height) problems.push(`size ${p.video.width}x${p.video.height}`);
  }
  if (want.audio && (!p.audio || p.audio.codec !== "aac")) problems.push(p.audio ? `audio codec ${p.audio.codec}` : "no audio stream");
  if (want.durationSec && Math.abs(p.durationSec - want.durationSec) > Math.max(0.6, want.durationSec * 0.02)) problems.push(`duration ${p.durationSec.toFixed(2)}s (expected ${want.durationSec.toFixed(2)}s)`);
  if (p.sizeBytes < 1000) problems.push("file too small");
  if (problems.length) throw new Error(`Output validation failed: ${problems.join(", ")}`);
  return p;
}

// ---- Chromium ------------------------------------------------------------------------------

let browser;
async function newPage(width, height) {
  if (!browser) {
    const require = createRequire("/opt/render/");
    const { chromium } = require("playwright-core");
    browser = await chromium.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
      // The container is the sandbox (no network, non-root, read-only, no capabilities):
      // Chromium's own sandbox needs user namespaces the container does not grant.
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none", "--disable-lcd-text", "--hide-scrollbars", "--mute-audio"],
    });
  }
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, javaScriptEnabled: true, offline: false });
  // Everything is served from disk through this route — nothing ever reaches a network.
  await ctx.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== ORIGIN) return route.abort();
    let file = null;
    if (u.pathname.startsWith("/fonts/") && /^\/fonts\/[A-Za-z0-9-]+\.ttf$/.test(u.pathname)) file = path.join(FONTS, u.pathname.slice(7));
    else if (u.pathname.startsWith("/work/")) file = rel(decodeURIComponent(u.pathname.slice(6)));
    if (!file) return route.abort();
    try {
      const body = await fs.readFile(file);
      const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".ttf") ? "font/ttf" : file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : "application/octet-stream";
      return route.fulfill({ status: 200, body, headers: { "content-type": type, "access-control-allow-origin": "*" } });
    } catch {
      return route.abort();
    }
  });
  return await ctx.newPage();
}

async function openDoc(page, htmlRel) {
  await page.goto(`${ORIGIN}/work/${htmlRel}`, { waitUntil: "load", timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  // Every font face the document declares must really be loaded (no silent fallback glyphs).
  const failed = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "error").map((f) => f.family));
  if (failed.length) throw new Error(`Font failed to load: ${[...new Set(failed)].join(", ")}`);
}

/** Pauses every animation and returns when the picture can change: continuous ranges and instant steps. */
async function animationPlan(page) {
  return await page.evaluate(() => {
    const ranges = [];
    const steps = [];
    for (const a of document.getAnimations()) {
      a.pause();
      const t = a.effect.getComputedTiming();
      const start = (Number(t.delay) || 0) / 1000;
      const end = (Number(t.endTime) || 0) / 1000;
      // Constant keyframes (subtitle cues) only change at their start and end.
      if (a.animationName === "cue") steps.push(start, end);
      else ranges.push([start, end]);
    }
    return { ranges, steps };
  });
}

async function seek(page, sec) {
  await page.evaluate((ms) => {
    for (const a of document.getAnimations()) a.currentTime = ms;
  }, sec * 1000);
}

/** Frame numbers that need a fresh capture for a document of `frames` frames at `fps`. */
function captureFrames(plan, frames, fps) {
  const need = new Set([0]);
  for (const [s, e] of plan.ranges) {
    const a = Math.max(0, Math.floor(s * fps));
    const b = Math.min(frames - 1, Math.ceil(e * fps) + 1);
    for (let k = a; k <= b; k++) need.add(k);
  }
  for (const s of plan.steps) {
    const k = Math.ceil(s * fps - 1e-6);
    if (k >= 0 && k < frames) need.add(k);
  }
  return [...need].sort((x, y) => x - y);
}

/**
 * Captures one HTML document as a held-frame sequence and returns concat-demuxer
 * lines. holdSec extends the last frame (for a crossfade into the next scene).
 */
async function captureDoc(page, htmlRel, durationSec, fps, outDir, prefix, holdSec, onFrame) {
  await openDoc(page, htmlRel);
  const plan = await animationPlan(page);
  const frames = Math.max(1, Math.round(durationSec * fps));
  const keys = captureFrames(plan, frames, fps);
  const lines = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    await seek(page, k / fps);
    const file = path.join(outDir, `${prefix}-${String(k).padStart(5, "0")}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 92 });
    const next = i + 1 < keys.length ? keys[i + 1] : frames;
    let dur = (next - k) / fps;
    if (i + 1 === keys.length) dur += holdSec;
    lines.push(`file '${file}'`, `duration ${dur.toFixed(6)}`);
    await onFrame?.(i + 1, keys.length);
  }
  // The concat demuxer needs the last file repeated for its duration to count.
  lines.push(lines[lines.length - 2]);
  return { lines, captured: keys.length, frames };
}

// ---- generate ------------------------------------------------------------------------------

async function doGenerate(t) {
  const W = num(t.width, 240, 3840, "width");
  const H = num(t.height, 240, 3840, "height");
  const fps = num(t.fps ?? 25, 10, 60, "fps");
  const tr = t.transition === "fade" ? num(t.transitionSec ?? 0.4, 0.1, 1.5, "transitionSec") : 0;
  // xfade transition name (whitelist); "fade" unless the task asks for another one.
  const xfade = ["fade", "fadeblack", "slideleft", "slideup", "smoothup", "circleopen"].includes(t.transitionType) ? t.transitionType : "fade";
  const scenes = (t.scenes ?? []).map((s) => ({ html: s.html, durationSec: num(s.durationSec, 0.5, 600, "scene duration"), audio: s.audio ? s.audio : null }));
  if (!scenes.length || scenes.length > 60) throw new Error("A video needs 1–60 scenes.");
  const total = scenes.reduce((a, s) => a + s.durationSec, 0);
  const frameDir = rel(t.frameDir ?? "render/frames");
  await fs.rm(frameDir, { recursive: true, force: true });
  await fs.mkdir(frameDir, { recursive: true });
  const page = await newPage(W, H);
  const lists = [];
  let captured = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const hold = i + 1 < scenes.length ? tr : 0;
    const r = await captureDoc(page, s.html, s.durationSec, fps, frameDir, `s${i}`, hold, (n, of) => progress("frames", ((i + n / of) / scenes.length) * 70, { scene: i + 1, scenes: scenes.length }));
    captured += r.captured;
    const list = path.join(frameDir, `s${i}.txt`);
    await fs.writeFile(list, r.lines.join("\n") + "\n");
    lists.push(list);
  }
  await progress("encode", 70, {}, true);

  const args = ["-hide_banner", "-y", "-nostdin"];
  for (const l of lists) args.push("-f", "concat", "-safe", "0", "-i", l);
  let nextInput = lists.length;
  const audioIdx = scenes.map((s) => {
    if (!s.audio) return null;
    args.push("-i", rel(s.audio));
    return nextInput++;
  });
  let narrIdx = null;
  if (t.narration?.file) {
    narrIdx = nextInput++;
    args.push("-i", rel(t.narration.file));
  }
  let musicIdx = null;
  if (t.music?.file) {
    musicIdx = nextInput++;
    args.push("-stream_loop", "-1", "-i", rel(t.music.file));
  }
  const f = [];
  scenes.forEach((s, i) => f.push(`[${i}:v]fps=${fps},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p,trim=duration=${(s.durationSec + (i + 1 < scenes.length ? tr : 0)).toFixed(3)},setpts=PTS-STARTPTS[v${i}]`));
  let last = "v0";
  if (scenes.length > 1 && tr > 0) {
    let offset = 0;
    for (let i = 1; i < scenes.length; i++) {
      offset += scenes[i - 1].durationSec;
      const out = i + 1 === scenes.length ? "vout" : `x${i}`;
      f.push(`[${last}][v${i}]xfade=transition=${xfade}:duration=${tr.toFixed(3)}:offset=${offset.toFixed(3)}[${out}]`);
      last = out;
    }
  } else if (scenes.length > 1) {
    f.push(`${scenes.map((_, i) => `[v${i}]`).join("")}concat=n=${scenes.length}:v=1:a=0[vout]`);
    last = "vout";
  } else {
    f.push(`[v0]null[vout]`);
    last = "vout";
  }
  if (narrIdx !== null) {
    // One continuous take: padded / cut to the video length (frame times were planned from this same file).
    f.push(`[${narrIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS[narr]`);
  } else {
    // Narration: each scene's audio padded / cut to exactly its scene length, then joined.
    scenes.forEach((s, i) => {
      const src = audioIdx[i] === null ? "anullsrc=r=48000:cl=stereo" : `[${audioIdx[i]}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad`;
      f.push(`${src},atrim=duration=${s.durationSec.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    f.push(`${scenes.map((_, i) => `[a${i}]`).join("")}concat=n=${scenes.length}:v=0:a=1[narr]`);
  }
  let aout = "narr";
  if (musicIdx !== null) {
    const vol = num(t.music.volume ?? 0.12, 0, 1, "music volume");
    f.push(`[narr]asplit=2[nm][sc]`);
    f.push(`[${musicIdx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${vol},atrim=duration=${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[mus]`);
    f.push(`[mus][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
    f.push(`[nm][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mix]`);
    aout = "mix";
  }
  const output = rel(t.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const tmp = `${output}.part.mp4`;
  args.push("-filter_complex", f.join(";"), "-map", `[${last}]`, "-map", `[${aout}]`, "-t", total.toFixed(3));
  args.push("-c:v", "libx264", "-preset", t.preset === "medium" ? "medium" : "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", String(fps), "-threads", "2");
  args.push("-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", tmp);
  await run("ffmpeg", args, {
    timeoutMs: num(t.timeoutSec ?? 1800, 60, 7200, "timeout") * 1000,
    onStderr: (s) => {
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m) void progress("encode", 70 + Math.min(29, ((+m[1] * 3600 + +m[2] * 60 + +m[3]) / total) * 29));
    },
  });
  const probe = await validateOutput(tmp, { width: W, height: H, audio: true, durationSec: total });
  await fs.rename(tmp, output);
  if (!t.keepFrames) await fs.rm(frameDir, { recursive: true, force: true });
  return { output: t.output, durationSec: probe.durationSec, sizeBytes: probe.sizeBytes, width: W, height: H, framesCaptured: captured, framesTotal: Math.round(total * fps) };
}

// ---- proxy / audio -------------------------------------------------------------------------

async function doProxy(t) {
  const input = rel(t.input);
  const src = await probeFile(input);
  if (!src.video) throw new Error("The file has no video stream.");
  const maxH = num(t.maxHeight ?? 540, 144, 1080, "maxHeight");
  const output = rel(t.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  // The shorter side becomes maxHeight (ffmpeg applies the rotation tag first, like the probe).
  const scale = src.video.width >= src.video.height ? `scale=-2:${maxH}` : `scale=${maxH}:-2`;
  const args = ["-hide_banner", "-y", "-nostdin", "-i", input, "-vf", `${scale},fps=25,format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-threads", "2"];
  if (src.audio) args.push("-c:a", "aac", "-b:a", "96k", "-ac", "2");
  else args.push("-an");
  args.push("-movflags", "+faststart", `${output}.part.mp4`);
  await run("ffmpeg", args, {
    timeoutMs: 30 * 60_000,
    onStderr: (s) => {
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m && src.durationSec) void progress("proxy", Math.min(90, ((+m[1] * 3600 + +m[2] * 60 + +m[3]) / src.durationSec) * 90));
    },
  });
  await fs.rename(`${output}.part.mp4`, output);
  let thumbs = null;
  if (t.thumbs) {
    const every = num(t.thumbs.everySec ?? 2, 0.5, 60, "thumb interval");
    const width = num(t.thumbs.width ?? 160, 40, 400, "thumb width");
    const count = Math.min(200, Math.max(1, Math.ceil(src.durationSec / every)));
    const sprite = rel(t.thumbs.output);
    await run("ffmpeg", ["-hide_banner", "-y", "-nostdin", "-i", input, "-vf", `fps=1/${every},scale=${width}:-2,tile=${count}x1`, "-frames:v", "1", "-q:v", "5", sprite], { timeoutMs: 10 * 60_000 });
    thumbs = { output: t.thumbs.output, count, everySec: every, width };
  }
  await progress("proxy", 100, {}, true);
  return { source: src, output: t.output, thumbs };
}

async function doAudio(t) {
  const input = rel(t.input);
  const output = rel(t.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await run("ffmpeg", ["-hide_banner", "-y", "-nostdin", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k", output], { timeoutMs: 15 * 60_000 });
  const p = await probeFile(output);
  return { output: t.output, durationSec: p.durationSec, sizeBytes: p.sizeBytes };
}

// ---- edit ----------------------------------------------------------------------------------

/**
 * Edit decision list:
 *   width/height/fps, fit: "crop" | "blur" | "pad" (how the source fills the new aspect ratio),
 *   segments: [{ src, in, out, volume }] (played in order), transition: "none" | "fade",
 *   overlays: [{ html | image, start, end, x, y, w, h, kind }] — html overlays are drawn by
 *     Chromium on a transparent page the size of the video (text, diagrams, subtitles);
 *     image / video overlays (B-roll, picture-in-picture) are scaled into their box,
 *   subtitles: { html } — one transparent document whose cues are timed like a scene,
 *   audio: { volume, fadeInSec, fadeOutSec, clean, music?: { file, volume } }.
 */
async function doEdit(t) {
  const W = num(t.width, 240, 3840, "width");
  const H = num(t.height, 240, 3840, "height");
  const fps = num(t.fps ?? 25, 10, 60, "fps");
  const segs = (t.segments ?? []).map((s) => ({ src: s.src, in: num(s.in, 0, 36000, "in"), out: num(s.out, 0, 36000, "out"), volume: num(s.volume ?? 1, 0, 4, "segment volume") }));
  if (!segs.length || segs.length > 200) throw new Error("The edit needs 1–200 segments.");
  for (const s of segs) if (s.out - s.in < 0.1) throw new Error("A segment is shorter than 0.1 s.");
  const tr = t.transition === "fade" && segs.length > 1 ? Math.min(0.5, ...segs.map((s) => (s.out - s.in) / 3)) : 0;
  const total = segs.reduce((a, s) => a + (s.out - s.in), 0) - tr * (segs.length - 1);
  const fit = ["crop", "blur", "pad"].includes(t.fit) ? t.fit : "blur";
  const sources = [...new Set(segs.map((s) => s.src))];
  const probes = {};
  for (const s of sources) probes[s] = await probeFile(rel(s));

  const work = rel(t.workDir ?? "render/edit");
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  const args = ["-hide_banner", "-y", "-nostdin"];
  const inputIndex = new Map();
  const addInput = (file, pre = []) => {
    const key = pre.join(" ") + "|" + file;
    if (!inputIndex.has(key)) {
      inputIndex.set(key, inputIndex.size);
      args.push(...pre, "-i", file);
    }
    return inputIndex.get(key);
  };
  const f = [];
  const fill = (inp, out) => {
    if (fit === "crop") return [`[${inp}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[${out}]`];
    if (fit === "pad") return [`[${inp}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${out}]`];
    return [
      `[${inp}]split=2[${out}b][${out}f]`,
      `[${out}b]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2,eq=brightness=-0.08[${out}bb]`,
      `[${out}f]scale=${W}:${H}:force_original_aspect_ratio=decrease[${out}ff]`,
      `[${out}bb][${out}ff]overlay=(W-w)/2:(H-h)/2,setsar=1[${out}]`,
    ];
  };
  segs.forEach((s, i) => {
    const idx = addInput(rel(s.src));
    const hasAudio = !!probes[s.src].audio;
    f.push(`[${idx}:v]trim=start=${s.in.toFixed(3)}:end=${s.out.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps}[sv${i}]`);
    f.push(...fill(`sv${i}`, `fv${i}`));
    f.push(`[fv${i}]format=yuv420p[v${i}]`);
    if (hasAudio) f.push(`[${idx}:a]atrim=start=${s.in.toFixed(3)}:end=${s.out.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${s.volume}[a${i}]`);
    else f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${(s.out - s.in).toFixed(3)}[a${i}]`);
  });
  let vlast;
  let alast;
  if (segs.length === 1) {
    vlast = "v0";
    alast = "a0";
  } else if (tr > 0) {
    let offset = 0;
    vlast = "v0";
    alast = "a0";
    for (let i = 1; i < segs.length; i++) {
      offset += segs[i - 1].out - segs[i - 1].in - tr;
      f.push(`[${vlast}][v${i}]xfade=transition=fade:duration=${tr.toFixed(3)}:offset=${offset.toFixed(3)}[xv${i}]`);
      f.push(`[${alast}][a${i}]acrossfade=d=${tr.toFixed(3)}[xa${i}]`);
      vlast = `xv${i}`;
      alast = `xa${i}`;
    }
  } else {
    f.push(`${segs.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${segs.length}:v=1:a=1[cv][ca]`);
    vlast = "cv";
    alast = "ca";
  }

  // Overlays: HTML ones become transparent PNGs drawn by Chromium.
  const overlays = t.overlays ?? [];
  if (overlays.length > 60) throw new Error("At most 60 overlays.");
  let page = null;
  for (let i = 0; i < overlays.length; i++) {
    const o = overlays[i];
    const start = num(o.start, 0, total, "overlay start");
    const end = num(o.end, start, total + 1, "overlay end");
    const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    let idx;
    let box;
    if (o.html) {
      page ??= await newPage(W, H);
      await openDoc(page, o.html);
      const png = path.join(work, `ov${i}.png`);
      await page.screenshot({ path: png, type: "png", omitBackground: true });
      idx = addInput(png, ["-loop", "1", "-t", total.toFixed(3)]);
      f.push(`[${idx}:v]format=rgba[ov${i}]`);
      box = { x: 0, y: 0 };
    } else {
      const file = rel(o.image ?? o.video);
      const x = Math.round(num(o.x ?? 0, 0, 1, "x") * W);
      const y = Math.round(num(o.y ?? 0, 0, 1, "y") * H);
      const w = Math.max(16, Math.round(num(o.w ?? 1, 0.02, 1, "w") * W)) & ~1;
      const h = Math.max(16, Math.round(num(o.h ?? 1, 0.02, 1, "h") * H)) & ~1;
      if (o.video) {
        idx = addInput(file);
        const vin = num(o.srcIn ?? 0, 0, 36000, "overlay in");
        f.push(`[${idx}:v]trim=start=${vin.toFixed(3)},setpts=PTS-STARTPTS+${start.toFixed(3)}/TB,fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},format=rgba[ov${i}]`);
      } else {
        idx = addInput(file, ["-loop", "1", "-t", total.toFixed(3)]);
        f.push(`[${idx}:v]scale=${w}:${h}:force_original_aspect_ratio=${o.cover ? "increase" : "decrease"}${o.cover ? `,crop=${w}:${h}` : ""},format=rgba[ov${i}]`);
      }
      box = { x, y };
    }
    f.push(`[${vlast}][ov${i}]overlay=${box.x}:${box.y}:${enable}:eof_action=pass[ovo${i}]`);
    vlast = `ovo${i}`;
  }
  // Subtitles: one transparent document captured like a scene (cue steps only) → an RGBA track.
  if (t.subtitles?.html) {
    page ??= await newPage(W, H);
    const sdir = path.join(work, "subs");
    await fs.mkdir(sdir, { recursive: true });
    const r = await captureDocTransparent(page, t.subtitles.html, total, fps, sdir);
    const list = path.join(sdir, "subs.txt");
    await fs.writeFile(list, r.join("\n") + "\n");
    const idx = addInput(list, ["-f", "concat", "-safe", "0"]);
    f.push(`[${idx}:v]fps=${fps},format=rgba[subs]`);
    f.push(`[${vlast}][subs]overlay=0:0:eof_action=pass[vsub]`);
    vlast = "vsub";
  }
  // Audio finishing: level, optional clean-up (rumble filter + denoise + loudness), fades, music.
  const au = t.audio ?? {};
  const af = [`volume=${num(au.volume ?? 1, 0, 4, "volume")}`];
  if (au.clean) af.push("highpass=f=80", "afftdn=nf=-25", "loudnorm=I=-16:TP=-1.5:LRA=11");
  const fin = num(au.fadeInSec ?? 0, 0, 10, "fade in");
  const fout = num(au.fadeOutSec ?? 0, 0, 10, "fade out");
  if (fin > 0) af.push(`afade=t=in:st=0:d=${fin}`);
  if (fout > 0) af.push(`afade=t=out:st=${Math.max(0, total - fout).toFixed(3)}:d=${fout}`);
  f.push(`[${alast}]${af.join(",")}[afin]`);
  alast = "afin";
  if (au.music?.file) {
    const idx = addInput(rel(au.music.file), ["-stream_loop", "-1"]);
    const vol = num(au.music.volume ?? 0.12, 0, 1, "music volume");
    f.push(`[${alast}]asplit=2[nm][sc]`);
    f.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${vol},atrim=duration=${total.toFixed(3)},afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[mus]`);
    f.push(`[mus][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]`);
    f.push(`[nm][duck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mix]`);
    alast = "mix";
  }
  const output = rel(t.output);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const tmp = `${output}.part.mp4`;
  args.push("-filter_complex", f.join(";"), "-map", `[${vlast}]`, "-map", `[${alast}]`, "-t", total.toFixed(3));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", String(fps), "-threads", "2");
  args.push("-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", tmp);
  await progress("encode", 10, {}, true);
  await run("ffmpeg", args, {
    timeoutMs: num(t.timeoutSec ?? 3600, 60, 7200, "timeout") * 1000,
    onStderr: (s) => {
      const m = /time=(\d+):(\d+):([\d.]+)/.exec(s);
      if (m) void progress("encode", 10 + Math.min(89, ((+m[1] * 3600 + +m[2] * 60 + +m[3]) / total) * 89));
    },
  });
  const probe = await validateOutput(tmp, { width: W, height: H, audio: true, durationSec: total });
  await fs.rename(tmp, output);
  await fs.rm(work, { recursive: true, force: true });
  return { output: t.output, durationSec: probe.durationSec, sizeBytes: probe.sizeBytes, width: W, height: H };
}

async function captureDocTransparent(page, htmlRel, durationSec, fps, outDir) {
  await openDoc(page, htmlRel);
  const plan = await animationPlan(page);
  const frames = Math.max(1, Math.round(durationSec * fps));
  const keys = captureFrames({ ranges: plan.ranges, steps: plan.steps }, frames, fps);
  const lines = [];
  for (let i = 0; i < keys.length; i++) {
    await seek(page, keys[i] / fps);
    const file = path.join(outDir, `c${String(keys[i]).padStart(6, "0")}.png`);
    await page.screenshot({ path: file, type: "png", omitBackground: true });
    const next = i + 1 < keys.length ? keys[i + 1] : frames;
    lines.push(`file '${file}'`, `duration ${((next - keys[i]) / fps).toFixed(6)}`);
  }
  lines.push(lines[lines.length - 2]);
  return lines;
}

// ---- main ----------------------------------------------------------------------------------

async function main() {
  const taskRel = process.argv[2];
  task = JSON.parse(await fs.readFile(rel(taskRel), "utf8"));
  const resultFile = rel(task.result);
  try {
    let result;
    if (task.type === "probe") result = await doProbe(task);
    else if (task.type === "generate") result = await doGenerate(task);
    else if (task.type === "proxy") result = await doProxy(task);
    else if (task.type === "audio") result = await doAudio(task);
    else if (task.type === "edit") result = await doEdit(task);
    else throw new Error(`Unknown task type: ${String(task.type).slice(0, 30)}`);
    await progress("done", 100, {}, true);
    await fs.writeFile(resultFile, JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    await fs.writeFile(resultFile, JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 800) })).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

await main();
