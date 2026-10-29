/**
 * AI Video Editor → Sound effects — browser checks on a SCRATCH server (never production), with the
 * real worker (kicked by the server, scratch lock) and the real render container.
 *
 * Covers the SFX panel (library, preview, add), clip editing (time, trim, volume, fade), attaching a clip
 * to a cut or an overlay (it follows trims and moves; an orphaned clip falls back to its stored time),
 * "Play edit" preview playback, and export sync: each effect is located in the exported audio by
 * cross-correlation and must sit within 2 ms of its planned output time.
 *
 *   Fixtures: scripts/ig-studio-fixture.ts setup + scripts/video-studio-fixture.ts setup.
 *   Run AFTER scripts/verify-video-studio-ui.mjs (that suite expects no worker heartbeat). The editor needs a
 *   fresh worker heartbeat: run it right after scripts/verify-motion-editor-ui.mjs, or run
 *   scripts/video-worker.ts once with the server's environment first.
 *   BASE=http://localhost:3651 SHOTS=<dir> RECORDING=<a silent .mp4, ≥ 20 s> VIDEO_STUDIO_DIR=<the server's>
 *     NODE_PATH=<dir with playwright> node scripts/verify-video-sfx-ui.mjs
 *   The recording must be SILENT: every sound in the export is then an effect.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3651";
const SHOTS = process.env.SHOTS ?? "/tmp/video-sfx-shots";
const RECORDING = process.env.RECORDING ?? "";
const ROOT = process.env.VIDEO_STUDIO_DIR ?? "";
const PASSWORD = "IgStudio#Fixture2026";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
if (!RECORDING || !ROOT.startsWith("/root/mts-scratch/")) throw new Error("RECORDING and a scratch VIDEO_STUDIO_DIR are required.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();
const SFX_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "../public/video-studio/sfx");

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}

async function waitStatus(page, id, statuses, timeoutMs = 8 * 60_000) {
  const t0 = Date.now();
  for (;;) {
    const s = sql(`SELECT status FROM "VideoJob" WHERE id='${id}'`);
    if (statuses.includes(s)) {
      await page.reload();
      return s;
    }
    if (Date.now() - t0 > timeoutMs) return s;
    await page.waitForTimeout(4000);
  }
}

/** Mono float32 PCM at 48 kHz, decoded inside the render image (no ffmpeg on the host). */
function pcm(file) {
  const buf = execFileSync("/usr/bin/docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "-v", `${path.dirname(file)}:/w:ro`, "--entrypoint", "ffmpeg", "mts-video-render:1", "-v", "error", "-i", `/w/${path.basename(file)}`, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 256 * 1024 * 1024 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/** Lag (s) where `clip` (first 0.25 s, from trimIn) best matches `out` within ±0.3 s of `expect`; normalised correlation. */
function locate(out, clip, trimIn, expect) {
  const sr = 48000;
  const c = clip.subarray(Math.round(trimIn * sr), Math.round(trimIn * sr) + Math.round(0.25 * sr));
  const cn = Math.sqrt(c.reduce((a, x) => a + x * x, 0)) || 1;
  let best = -Infinity;
  let at = 0;
  const from = Math.max(0, Math.round((expect - 0.3) * sr));
  const to = Math.min(out.length - c.length, Math.round((expect + 0.3) * sr));
  for (let k = from; k <= to; k++) {
    let dot = 0;
    let on = 0;
    for (let j = 0; j < c.length; j++) {
      const o = out[k + j];
      dot += o * c[j];
      on += o * o;
    }
    const r = dot / (cn * (Math.sqrt(on) || 1));
    if (r > best) [best, at] = [r, k];
  }
  return { sec: at / sr, corr: best };
}

const clipLi = (page, key) => page.locator(`[data-testid=sfx-clips] li[data-sfx="${key}"]`);
const playsText = async (page, key) => (await clipLi(page, key).getByRole("button", { name: /plays|does not play/ }).textContent()).trim();

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
try {
  sql(`DELETE FROM "VideoJob" WHERE kind = 'EDIT' AND title = 'SFX clip'`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Record every media play() call (src, playhead text, promise outcome) for the preview checks.
  await ctx.addInitScript(() => {
    window.__plays = [];
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const rec = { src: this.currentSrc || this.src, at: document.querySelector("[data-testid=playhead-time]")?.textContent ?? "", t: performance.now(), ok: null };
      window.__plays.push(rec);
      const p = orig.call(this);
      p.then(() => (rec.ok = true), (e) => (rec.ok = String(e?.name ?? e)));
      return p;
    };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of 404/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const wavRequests = [];
  page.on("response", (r) => r.url().includes("/video-studio/sfx/") && wavRequests.push({ url: r.url(), status: r.status() }));
  await login(page, "igmaster");

  console.log("\nA. Edit job from a silent recording");
  await page.goto(`${BASE}/admin/video-studio/editor`);
  await page.getByTestId("edit-title").fill("SFX clip");
  await Promise.all([page.waitForURL(/\/admin\/video-studio\/jobs\/[a-z0-9]{20,}$/, { timeout: 30000 }), page.getByTestId("create-edit").click()]);
  const eid = page.url().split("/").pop();
  await page.locator("[data-testid=editor-assets] [data-testid=asset-input]").setInputFiles(RECORDING);
  await page.getByTestId("process-uploads").waitFor({ timeout: 60000 });
  await page.getByTestId("process-uploads").click();
  await waitStatus(page, eid, ["REVIEW_REQUIRED", "FAILED"]);
  if (await page.getByTestId("start-edit").count()) await page.getByTestId("start-edit").click();
  await page.getByTestId("segments").waitFor({ timeout: 30000 });
  check("edit ready: one segment for the recording", (await page.locator("[data-testid=segments] [data-segment]").count()) === 1);

  console.log("\nB. SFX panel: library, preview, add");
  check("panel starts empty (nothing added automatically)", (await page.locator("[data-testid=sfx-clips] li[data-sfx]").count()) === 0 && (await page.getByTestId("sfx-clips").textContent()).includes("No sound effects"));
  check("library lists all 16 sounds in category groups", (await page.locator("[data-testid=sfx-pick] option").count()) === 16 && (await page.locator("[data-testid=sfx-pick] optgroup").count()) >= 4);
  await page.getByTestId("sfx-pick").selectOption("correct_chime");
  await page.getByTestId("sfx-preview").click();
  await page.waitForFunction(() => window.__plays.some((p) => p.src.includes("correct_chime") && p.ok !== null), null, { timeout: 10000 }).catch(() => undefined);
  const pv = await page.evaluate(() => window.__plays.find((p) => p.src.includes("correct_chime")));
  check("Preview plays the bundled WAV in the browser", pv?.ok === true && wavRequests.some((r) => r.url.endsWith("/correct_chime.wav") && r.status < 400), { pv, wavRequests });

  await page.getByTestId("playhead").fill("8");
  await page.getByTestId("split").click();
  await page.getByTestId("playhead").fill("3");
  await page.getByTestId("sfx-pick").selectOption("transition_whoosh");
  await page.getByTestId("sfx-add").click();
  check("transition sound added with its peak on the playhead (3 − 0.136 s)", (await playsText(page, "transition_whoosh")) === "plays 2.86–3.92 s", await playsText(page, "transition_whoosh"));

  console.log("\nC. Attach to a cut / an overlay; they follow edits");
  await clipLi(page, "transition_whoosh").getByLabel("Follow").selectOption({ label: "Cut 1 (8.0 s)" });
  check("attached to Cut 1: peak lands on the cut (offset −0.136)", (await playsText(page, "transition_whoosh")) === "plays 7.86–8.92 s" && (await clipLi(page, "transition_whoosh").getByLabel("Offset (s)").inputValue()) === "-0.136", await playsText(page, "transition_whoosh"));
  await page.getByTestId("playhead").fill("12");
  await page.getByTestId("add-text").click();
  await page.locator("[data-overlay=text]").getByLabel("Text", { exact: true }).fill("Troponin I");
  await page.getByTestId("playhead").fill("0");
  await page.getByTestId("sfx-pick").selectOption("text_pop");
  await page.getByTestId("sfx-add").click();
  await clipLi(page, "text_pop").getByLabel("Follow").selectOption({ label: "text overlay (12.0 s)" });
  check("attached to the text overlay: starts on it", (await playsText(page, "text_pop")) === "plays 12.00–12.17 s", await playsText(page, "text_pop"));

  await page.getByTestId("sfx-pick").selectOption("correct_chime");
  await page.getByTestId("sfx-add").click();
  const chime = clipLi(page, "correct_chime");
  await chime.getByLabel("At (s)").fill("15");
  await chime.getByLabel("Trim end").fill("1");
  await chime.getByLabel("Volume").fill("0.5");
  await chime.getByLabel("Fade out").fill("0.3");
  check("clip editing: fixed time, trim, volume, fade", (await playsText(page, "correct_chime")) === "plays 15.00–16.00 s", await playsText(page, "correct_chime"));

  await page.getByLabel("Segment 1 out").fill("6");
  check("trimming segment 1 moves the cut → the whoosh follows (6 − 0.136)", (await playsText(page, "transition_whoosh")) === "plays 5.86–6.92 s", await playsText(page, "transition_whoosh"));
  await page.locator("[data-overlay=text]").getByLabel("From").fill("10");
  check("moving the overlay → the pop follows", (await playsText(page, "text_pop")) === "plays 10.00–10.17 s", await playsText(page, "text_pop"));
  check("fixed-time clip does not move", (await playsText(page, "correct_chime")) === "plays 15.00–16.00 s");

  await page.getByTestId("playhead").fill("4");
  await page.getByTestId("add-diagram").click();
  await page.getByTestId("sfx-pick").selectOption("bullet_tick");
  await page.getByTestId("sfx-add").click();
  await clipLi(page, "bullet_tick").getByLabel("Follow").selectOption({ label: "diagram overlay (4.0 s)" });
  await page.locator("[data-overlay=diagram]").getByLabel("Delete overlay").click();
  const orphanMsg = await page.getByTestId("sfx-checks").textContent().catch(() => "");
  check("deleting the anchored overlay → orphan warning, clip keeps its time", orphanMsg.includes("no longer exists") && (await playsText(page, "bullet_tick")) === "plays 4.00–4.13 s", { orphanMsg, t: await playsText(page, "bullet_tick") });

  await page.getByTestId("save-edit").click();
  await page.getByTestId("editor-notice").waitFor({ timeout: 15000 });
  const saved = JSON.parse(sql(`SELECT edit->'sfx' FROM "VideoJob" WHERE id='${eid}'`));
  check("saved: 4 clips, anchors stored (cut + overlay), orphan kept", saved.length === 4 && saved.find((c) => c.key === "transition_whoosh")?.anchor?.kind === "cut" && saved.find((c) => c.key === "text_pop")?.anchor?.kind === "overlay" && saved.find((c) => c.key === "bullet_tick")?.anchor !== null, saved);
  await page.reload();
  await page.getByTestId("sfx-clips").waitFor();
  check("after reload the panel shows the same timeline", (await playsText(page, "transition_whoosh")) === "plays 5.86–6.92 s" && (await playsText(page, "text_pop")) === "plays 10.00–10.17 s" && (await playsText(page, "correct_chime")) === "plays 15.00–16.00 s");
  await page.screenshot({ path: `${SHOTS}/sfx-01-panel.png`, fullPage: true });

  console.log("\nD. Play edit (preview playback)");
  await page.evaluate(() => (window.__plays.length = 0));
  await page.getByTestId("play-sequence").click();
  await page.waitForFunction(() => window.__plays.some((p) => p.src.includes("text_pop")), null, { timeout: 25000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const plays = await page.evaluate(() => window.__plays.map((p) => ({ src: p.src.split("/").pop(), at: p.at, ok: p.ok })));
  const at = (k) => plays.find((p) => p.src.startsWith(k));
  const sec = (s) => {
    const m = /(\d+):(\d+)(?:\.(\d))?/.exec(s ?? "");
    return m ? +m[1] * 60 + +m[2] + (m[3] ? +m[3] / 10 : 0) : NaN;
  };
  check("Play edit: the recording plays", plays.some((p) => p.src.endsWith(".mp4") && p.ok === true), plays.slice(0, 3));
  check("Play edit: tick, whoosh and pop start in order as the playhead passes them (±0.6 s, timeupdate ~4 Hz)", ["bullet_tick", "transition_whoosh", "text_pop"].every((k) => at(k) && at(k).ok === true) && Math.abs(sec(at("bullet_tick").at) - 4) <= 0.6 && Math.abs(sec(at("transition_whoosh").at) - 5.86) <= 0.6 && Math.abs(sec(at("text_pop").at) - 10) <= 0.6, plays);
  await page.locator("[data-testid=editor-preview]").evaluate((v) => v.pause());

  console.log("\nE. Export: effects placed sample-accurately");
  await page.getByTestId("export-edit").click();
  const st = await waitStatus(page, eid, ["COMPLETED", "FAILED"]);
  check("export → COMPLETED", st === "COMPLETED" && (await page.getByTestId("output-video").count()) === 1, sql(`SELECT coalesce("failedStage",'') || ': ' || coalesce("errorMessage",'') FROM "VideoJob" WHERE id='${eid}'`));
  const startedMsg = sql(`SELECT message FROM "VideoJobEvent" WHERE "jobId"='${eid}' AND type='export_started' ORDER BY "createdAt" DESC LIMIT 1`);
  check("export log counts 4 sound effects", startedMsg.includes("4 sound effect(s)"), startedMsg);
  const report = JSON.parse(sql(`SELECT data FROM "VideoJobEvent" WHERE "jobId"='${eid}' AND type='audio_checked' ORDER BY "createdAt" DESC LIMIT 1`) || "null");
  check("audio report: audio and video lengths match (≤ 0.05 s), peak ≤ −0.5 dBTP", report && Math.abs(report.audioSec - report.videoSec) <= 0.05 && report.truePeakDb !== null && report.truePeakDb <= -0.5, report);
  const out = pcm(path.join(ROOT, eid, "out/edit.mp4"));
  const want = [
    { key: "bullet_tick", start: 4.0, trimIn: 0 },
    { key: "transition_whoosh", start: 5.864, trimIn: 0 },
    { key: "text_pop", start: 10.0, trimIn: 0 },
    { key: "correct_chime", start: 15.0, trimIn: 0 },
  ];
  const found = want.map((w) => ({ ...w, ...locate(out, pcm(path.join(SFX_DIR, `${w.key}.wav`)), w.trimIn, w.start) }));
  for (const f of found) check(`${f.key} sits at ${f.start.toFixed(3)} s in the export (±2 ms)`, Math.abs(f.sec - f.start) <= 0.002 && f.corr > 0.8, { found: Math.round(f.sec * 1000) / 1000, errMs: Math.round((f.sec - f.start) * 10000) / 10, corr: Math.round(f.corr * 1000) / 1000 });
  const rms = (a, b) => Math.sqrt(out.subarray(a * 48000, b * 48000).reduce((s, x) => s + x * x, 0) / ((b - a) * 48000));
  check("silence between effects (0–3.9 s, 7–9.9 s) and after the trimmed chime (16.1–end)", rms(0.2, 3.9) < 1e-4 && rms(7, 9.9) < 1e-4 && rms(16.1, out.length / 48000 - 0.05) < 1e-4, [rms(0.2, 3.9), rms(7, 9.9), rms(16.1, out.length / 48000 - 0.05)]);
  await page.screenshot({ path: `${SHOTS}/sfx-02-exported.png`, fullPage: true });

  console.log("\nF. Read-only");
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  await login(p2, "igfull");
  await p2.goto(`${BASE}/admin/video-studio/jobs/${eid}`);
  const fullSees = await p2.getByTestId("sfx-clips").count();
  check("Full Admin: no Add, and clip controls disabled (if the panel is shown)", (await p2.getByTestId("sfx-add").count()) === 0 && (fullSees === 0 || (await p2.getByTestId("sfx-remove").first().isDisabled())), { fullSees });
  await ctx2.close();

  check("no page errors or console errors", errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
