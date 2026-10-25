/**
 * Motion Workflow Studio + AI Video Editor + Generator PDF / image sources —
 * browser checks on a SCRATCH server (never production), with the real worker
 * (kicked by the server, scratch lock) and the real render container.
 *
 *   Run AFTER scripts/verify-video-studio-ui.mjs (that suite expects no worker
 *   heartbeat; this one writes one). Fixture: scripts/video-studio-fixture.ts setup.
 *   BASE=http://localhost:3651 SHOTS=<dir> RECORDING=<an .mp4> NODE_PATH=<dir with playwright> \
 *     node scripts/verify-motion-editor-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3651";
const SHOTS = process.env.SHOTS ?? "/tmp/motion-ui-shots";
const RECORDING = process.env.RECORDING ?? "/root/mts-scratch/video-studio/shots/pipeline/A-topic.mp4";
const PASSWORD = "IgStudio#Fixture2026";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const noHorizontalOverflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
/** Waits (reloading every 4 s) until a job reaches one of the statuses. */
async function waitStatus(page, id, statuses, timeoutMs = 6 * 60_000) {
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

// Fixture additions: voice approval, transcription model, and a fresh worker heartbeat (the server kicks the worker).
sql(`UPDATE "Setting" SET value = jsonb_set(value, '{approvedModels}', '["microsoft/mai-voice-2.1"]') WHERE key='video.voices'`);
sql(`INSERT INTO "Setting"(key, value, "updatedAt") VALUES ('video.studio', '{"transcriptionModel":"openai/whisper-large-v3"}', now()) ON CONFLICT (key) DO UPDATE SET value = "Setting".value || '{"transcriptionModel":"openai/whisper-large-v3"}'`);
sql(`DELETE FROM "VideoJob" WHERE kind IN ('MOTION','EDIT')`);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of 404/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await login(page, "igmaster");

  console.log("\nA. Motion Workflow Studio — dashboard and style library");
  await page.goto(`${BASE}/admin/video-studio`);
  check("subnav has Motion Workflow Studio", (await page.getByRole("link", { name: "Motion Workflow Studio" }).count()) === 1);
  await page.goto(`${BASE}/admin/video-studio/motion`);
  check("workflow lists all 11 steps", (await page.locator("[data-testid=motion-workflow] li").count()) === 11);
  check("motion skills listed (with Builds on …)", (await page.locator("[data-testid=motion-skills] li").count()) >= 16 && (await page.getByTestId("motion-skills").textContent()).includes("Builds on"));
  await page.screenshot({ path: `${SHOTS}/m01-dashboard.png`, fullPage: true });
  await page.goto(`${BASE}/admin/video-studio/motion/styles`);
  check("style library: 6 styles × 3 live previews", (await page.locator("[data-style]").count()) === 6 && (await page.getByTestId("motion-preview").count()) === 18);
  const f0 = await (await page.getByTestId("motion-preview").first().elementHandle()).contentFrame();
  await f0.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 15000 });
  check("preview: no scripts, Devanagari font loaded", (await f0.evaluate(() => document.scripts.length)) === 0 && (await f0.evaluate(() => [...document.fonts].some((f) => f.family === "MTSDev" && f.status === "loaded"))));
  await page.screenshot({ path: `${SHOTS}/m02-styles.png`, fullPage: true });
  await page.goto(`${BASE}/admin/video-studio/skills`);
  check("Skill Library shows the Motion Workflow category; motion skills cannot be added to Generator presets", (await page.locator('[data-skill="kinetic_typography"]').count()) === 1 && (await page.locator('[data-skill="kinetic_typography"] input[type=checkbox]').count()) === 0);

  console.log("\nB. Create → own script (free) → storyboard edit → narration (confirm) → MP4");
  await page.goto(`${BASE}/admin/video-studio/motion/new`);
  await page.getByTestId("mw-type").selectOption("clinical_case");
  check("video type proposes its style (Clinical Case Story)", (await page.locator('[data-style="case_story"]').getAttribute("aria-checked")) === "true");
  await page.getByTestId("mw-topic").fill("Chest pain with ST elevation");
  await page.getByTestId("mw-length").fill("30");
  await Promise.all([page.waitForURL(/\/admin\/video-studio\/motion\/[a-z0-9]{20,}$/, { timeout: 30000 }), page.getByTestId("mw-create").click()]);
  const id = page.url().split("/").pop();
  check("motion job created as DRAFT (kind MOTION)", sql(`SELECT kind || ':' || status FROM "VideoJob" WHERE id='${id}'`) === "MOTION:DRAFT");
  const chatBefore = Number(sql(`SELECT count(*) FROM "AiGatewayCall"`));
  await page.getByTestId("motion-estimate").click();
  await page.getByTestId("motion-script-estimate").waitFor({ timeout: 30000 });
  check("AI script price shown in ₹ before anything paid", /₹/.test(await page.getByTestId("motion-script-inr").textContent()) && (await page.getByTestId("motion-confirm-script").isDisabled()));
  await page.getByTestId("motion-own-script").fill("55 साल के patient को सीने में तेज़ दर्द है। ECG में ST elevation दिख रहा है। Troponin I 6 घंटे में बढ़ता है। Diagnosis है acute myocardial infarction। अगला कदम है तुरंत reperfusion। MockTestSeries.in पर ऐसे cases practice कीजिए।");
  await page.getByTestId("motion-plan-own").click();
  await page.getByTestId("motion-frames").waitFor({ timeout: 30000 });
  check("own script → 6 frames, no AI call, quote cancelled", (await page.locator("[data-testid=motion-frames] > li").count()) === 6 && Number(sql(`SELECT count(*) FROM "AiGatewayCall"`)) === chatBefore && sql(`SELECT count(*) FROM "AiCostQuote" WHERE status='OPEN'`) === "0");
  check("every frame has a live preview; QA panel lists checks", (await page.getByTestId("motion-preview").count()) === 6 && (await page.locator("[data-testid=motion-qa] [data-check]").count()) >= 12);
  const f1 = page.locator('[data-frame="1"]');
  await f1.getByLabel("On-screen text of frame 2").fill("ST elevation on ECG");
  await f1.getByLabel("Highlight of frame 2").fill("ST");
  await f1.getByTestId("motion-save-frame").click();
  await page.getByTestId("motion-notice").waitFor({ timeout: 15000 });
  check("frame edit saved", sql(`SELECT "onScreenText" FROM "VideoScene" WHERE "jobId"='${id}' AND index=1`) === "ST elevation on ECG");
  await page.screenshot({ path: `${SHOTS}/m03-storyboard.png`, fullPage: true });
  await page.getByTestId("motion-sync").selectOption("precise");
  await page.getByTestId("motion-estimate-voice").click();
  await page.getByTestId("motion-voice-estimate").waitFor({ timeout: 30000 });
  check("narration + precise sync price shown; confirm disabled until approved", /₹/.test(await page.getByTestId("motion-voice-inr").textContent()) && (await page.getByTestId("motion-confirm-voice").isDisabled()));
  await page.getByTestId("motion-approve-voice").check();
  await page.getByTestId("motion-confirm-voice").click();
  const st = await waitStatus(page, id, ["COMPLETED", "FAILED"]);
  check("worker (kicked by the server) recorded, synced and rendered → COMPLETED", st === "COMPLETED", sql(`SELECT "failedStage" || ': ' || "errorMessage" FROM "VideoJob" WHERE id='${id}'`));
  check("one speech + one transcription call recorded in the ledger", sql(`SELECT count(*) FROM "AiGatewayCall" WHERE feature='video_voice'`) === "1" && sql(`SELECT count(*) FROM "AiGatewayCall" WHERE feature='video_transcribe'`) === "1");
  check("MP4 player and download shown; render QA passed", (await page.getByTestId("motion-video").count()) === 1 && (await page.locator('[data-testid=motion-qa] [data-check="out_duration"][data-status="pass"]').count()) === 1);
  check("timing is precise (word timestamps)", sql(`SELECT config->'timing'->>'mode' FROM "VideoJob" WHERE id='${id}'`) === "precise");
  const dl = page.waitForEvent("download", { timeout: 30000 });
  await page.getByTestId("motion-download").click();
  const d = await dl;
  check("Download MP4 works and marks the job delivered", (await d.suggestedFilename()).endsWith(".mp4") && sql(`SELECT ("deliveredAt" IS NOT NULL)::text FROM "VideoJob" WHERE id='${id}'`) === "true");
  await page.screenshot({ path: `${SHOTS}/m04-completed.png`, fullPage: true });
  await page.goto(`${BASE}/admin/video-studio/jobs/${id}`);
  check("old /jobs/<id> link redirects to the motion workspace", page.url().endsWith(`/admin/video-studio/motion/${id}`));

  console.log("\nC. Style switch + free re-render");
  const voiceCalls = sql(`SELECT count(*) FROM "AiGatewayCall"`);
  await page.getByTestId("motion-style").selectOption("time_course");
  await page.getByTestId("motion-notice").waitFor({ timeout: 15000 });
  await page.getByTestId("motion-rerender").click();
  const st2 = await waitStatus(page, id, ["COMPLETED", "FAILED"]);
  check("re-render in another style completes with no new AI call", st2 === "COMPLETED" && sql(`SELECT count(*) FROM "AiGatewayCall"`) === voiceCalls && sql(`SELECT config->>'styleKey' FROM "VideoJob" WHERE id='${id}'`) === "time_course");

  console.log("\nD. AI Video Editor — upload → check → edit → export");
  await page.goto(`${BASE}/admin/video-studio/editor`);
  check("editor is available once the render worker is running", (await page.getByTestId("editor-unavailable").count()) === 0 && (await page.getByTestId("create-edit").count()) === 1);
  await page.getByTestId("edit-title").fill("Lecture clip");
  await Promise.all([page.waitForURL(/\/admin\/video-studio\/jobs\/[a-z0-9]{20,}$/, { timeout: 30000 }), page.getByTestId("create-edit").click()]);
  const eid = page.url().split("/").pop();
  await page.locator("[data-testid=editor-assets] [data-testid=asset-input]").setInputFiles(RECORDING);
  await page.getByTestId("process-uploads").waitFor({ timeout: 60000 });
  await page.getByTestId("process-uploads").click();
  await waitStatus(page, eid, ["REVIEW_REQUIRED", "FAILED"]);
  check("upload checked + preview proxy made by the worker", sql(`SELECT assets->0->>'state' FROM "VideoJob" WHERE id='${eid}'`) === "ready");
  // The worker creates the edit from the full recording once the upload is checked ("Start editing" is only a fallback).
  if (await page.getByTestId("start-edit").count()) await page.getByTestId("start-edit").click();
  await page.getByTestId("segments").waitFor({ timeout: 30000 });
  check("timeline shows one segment for the full recording", (await page.locator("[data-testid=segments] [data-segment]").count()) === 1);
  await page.getByTestId("playhead").fill("8");
  await page.getByTestId("split").click();
  check("split at the playhead → 2 segments", (await page.locator("[data-testid=segments] [data-segment]").count()) === 2);
  await page.getByTestId("add-text").click();
  await page.locator("[data-overlay=text]").getByLabel("Text", { exact: true }).fill("Troponin I — सबसे specific");
  await page.getByTestId("add-cue").click();
  await page.getByTestId("save-edit").click();
  await page.getByTestId("editor-notice").waitFor({ timeout: 15000 });
  check("edit saved (2 segments, 1 overlay, 1 cue)", sql(`SELECT jsonb_array_length(edit->'segments') || ':' || jsonb_array_length(edit->'overlays') || ':' || jsonb_array_length(edit->'subtitles'->'cues') FROM "VideoJob" WHERE id='${eid}'`) === "2:1:1");
  await page.screenshot({ path: `${SHOTS}/m05-editor.png`, fullPage: true });
  await page.getByTestId("estimate-transcribe").click();
  await page.getByTestId("transcribe-estimate").waitFor({ timeout: 30000 });
  check("subtitle price shown before the paid transcription; confirm disabled until approved", /₹/.test(await page.getByTestId("transcribe-inr").textContent()) && (await page.getByTestId("confirm-transcribe").isDisabled()));
  await page.getByTestId("export-edit").click();
  const st3 = await waitStatus(page, eid, ["COMPLETED", "FAILED"]);
  check("export → COMPLETED with the MP4 player", st3 === "COMPLETED" && (await page.getByTestId("output-video").count()) === 1, sql(`SELECT "failedStage" || ': ' || "errorMessage" FROM "VideoJob" WHERE id='${eid}'`));
  await page.screenshot({ path: `${SHOTS}/m06-editor-done.png`, fullPage: true });

  console.log("\nE. Generator: PDF and image sources");
  await page.goto(`${BASE}/admin/video-studio/new`);
  await page.getByTestId("source-pdf").click();
  check("PDF source explains the upload step", (await page.getByTestId("upload-next").count()) === 1 && (await page.getByTestId("auto-configure").textContent()).includes("Continue to upload"));
  await Promise.all([page.waitForURL(/\/admin\/video-studio\/jobs\/[a-z0-9]{20,}$/, { timeout: 30000 }), page.getByTestId("auto-configure").click()]);
  check("PDF job waits for its upload (no Auto Configure yet)", (await page.locator("[data-testid=assets-panel] [data-testid=asset-input]").getAttribute("accept"))?.includes("application/pdf") && (await page.getByTestId("auto-configure-job").count()) === 1);

  console.log("\nF. Mobile layout (390 px) + read-only admin");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ["/admin/video-studio/motion", "/admin/video-studio/motion/new", `/admin/video-studio/motion/${id}`, "/admin/video-studio/motion/styles", `/admin/video-studio/jobs/${eid}`, "/admin/video-studio/editor"]) {
    await page.goto(`${BASE}${p}`);
    check(`no horizontal page scroll at 390 px: ${p}`, await noHorizontalOverflow(page));
  }
  await page.goto(`${BASE}/admin/video-studio/motion/${id}`);
  await page.screenshot({ path: `${SHOTS}/m07-motion-mobile.png`, fullPage: true });
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  await login(p2, "igfull");
  await p2.goto(`${BASE}/admin/video-studio/motion/${id}`);
  check("Full Admin sees the motion video read-only (no paid or edit controls)", (await p2.getByTestId("motion-workspace").count()) === 1 && (await p2.getByTestId("motion-estimate-voice").count()) === 0 && (await p2.getByTestId("motion-save-frame").count()) === 0);
  await p2.goto(`${BASE}/admin/video-studio/motion/new`);
  check("Full Admin cannot create motion videos", (await p2.getByTestId("mw-create").count()) === 0);
  await ctx2.close();

  check("no page errors or console errors", errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
