/**
 * AI Video Studio — browser checks on a SCRATCH server (never production).
 *
 *   node -e "import('./scripts/mock-openrouter.mjs').then(m => m.startMockOpenRouter(3195))" &
 *   set -a; . ./.env; set +a      # DATABASE_URL must be an *igstudio* scratch DB
 *   OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3195 FX_TEST_BASE_URL=http://127.0.0.1:3195 \
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/video-studio-fixture.ts setup
 *   (server started with the same OPENROUTER_TEST_BASE_URL / FX_TEST_BASE_URL)
 *   BASE=http://localhost:3651 SHOTS=<dir> NODE_PATH=<dir containing playwright> node scripts/verify-video-studio-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3651";
const SHOTS = process.env.SHOTS ?? "/tmp/video-studio-shots";
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

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource: the server responded with a status of 404/.test(m.text()) && errors.push(`console: ${m.text()}`));

  console.log("\nA. Master Admin — navigation and readiness");
  await login(page, "igmaster");
  check("sidebar has AI Video Studio", (await page.locator('a[href="/admin/video-studio"]').count()) > 0);
  await page.goto(`${BASE}/admin/video-studio`);
  const caps = await page.locator("[data-testid=capabilities] [data-capability]").evaluateAll((els) => Object.fromEntries(els.map((e) => [e.dataset.capability, e.dataset.state])));
  check("dashboard: script ready, voice missing (nothing approved), render awaiting approval", caps.script === "ready" && caps.voice === "missing" && caps.render === "pending_approval", caps);
  await page.screenshot({ path: `${SHOTS}/01-dashboard.png`, fullPage: true });

  console.log("\nB. Voice Studio — approvals");
  await page.goto(`${BASE}/admin/video-studio/voices`);
  await page.getByLabel("Language filter").selectOption("all");
  check("catalog lists the synced models", (await page.locator("[data-testid=speech-models] tbody tr").count()) === 3);
  check("model with an unknown price cannot be approved", await page.getByLabel("Approve Google: Gemini 3.8 Flash TTS").isDisabled());
  await page.getByLabel("Approve Microsoft: MAI-Voice-2.1").check();
  await page.getByTestId("save-approvals").click();
  await page.waitForFunction(() => !document.querySelector("[data-testid=save-approvals]"), null, { timeout: 15000 });
  check("approval saved", sql(`SELECT value->'approvedModels' FROM "Setting" WHERE key='video.voices'`).includes("microsoft/mai-voice-2.1"));
  await page.screenshot({ path: `${SHOTS}/02-voices.png`, fullPage: true });

  console.log("\nC. Design Gallery — free live previews with real Devanagari shaping");
  await page.goto(`${BASE}/admin/video-studio/designs`);
  const cards = await page.locator("[data-testid=design-gallery] [data-design]").count();
  const ready = await page.locator('[data-testid=design-gallery] [data-status="ready"]').count();
  // Previews mount after hydration (they need the page origin for their CSP).
  await page.waitForFunction((n) => document.querySelectorAll("[data-testid=scene-preview]").length >= n, ready, { timeout: 15000 }).catch(() => undefined);
  check("gallery shows every design; ready ones have a preview", cards >= 15 && (await page.getByTestId("scene-preview").count()) === ready, { cards, ready });
  const frame = await (await page.getByTestId("scene-preview").first().elementHandle()).contentFrame();
  await frame.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 15000 });
  const fontOk = await frame.evaluate(() => document.fonts.check('700 40px MTSDev', "क्ष") && [...document.fonts].some((f) => f.family === "MTSDev" && f.status === "loaded"));
  check("preview loads the bundled Devanagari font", fontOk);
  const scriptsInFrame = await frame.evaluate(() => document.scripts.length);
  check("preview document contains no script", scriptsInFrame === 0);
  await page.locator('[data-design="medical_classroom"]').screenshot({ path: `${SHOTS}/03-design-card.png` });
  await page.screenshot({ path: `${SHOTS}/03-gallery.png`, fullPage: true });
  check("not-available designs offer no Select button", (await page.locator('[data-status="later"] a', { hasText: "Select" }).count()) === 0);

  console.log("\nD. Create Video → Auto Configure → price → confirm");
  await page.goto(`${BASE}/admin/video-studio/new?design=clinical_case`);
  check("gallery selection is carried over", (await page.getByTestId("preselected-design").textContent())?.includes("Clinical Case"));
  await page.fill("#vs-topic", "Cardiac markers in myocardial infarction");
  await page.fill("#vs-custom", "Create a 60-second Hinglish teaching Reel for NEET PG students with readable subtitles.");
  await Promise.all([page.waitForURL(/\/admin\/video-studio\/jobs\/[a-z0-9]+$/, { timeout: 30000 }), page.getByTestId("auto-configure").click()]);
  const jobId = page.url().split("/").pop();
  check("job created in CONFIGURING", (await page.getByTestId("job-workspace").getAttribute("data-job-status")) === "CONFIGURING");
  const reasons = await page.getByTestId("config-reasons").textContent();
  check("Auto Configure used the prompt's duration and the pre-selected design", reasons.includes("Duration 60s taken from your prompt") && (await page.getByTestId("design-select").inputValue()) === "clinical_case", reasons);
  check("Hindi voice proposed from the approved model", (await page.locator("#c-voice").inputValue()).includes("hi-IN-"));
  check("Confirm is not offered before a price review", (await page.getByTestId("confirm-generate").count()) === 0);
  await page.getByTestId("review-price").click();
  await page.getByTestId("estimate-table").waitFor({ timeout: 30000 });
  const total = await page.getByTestId("estimate-total").textContent();
  check("estimate shows a rupee total", /₹/.test(total), total);
  const states = await page.locator("[data-testid=estimate-table] [data-line]").evaluateAll((els) => Object.fromEntries(els.map((e) => [e.dataset.line, e.dataset.state])));
  check("script included; voice later; render no charge", states.script === "included" && states.voice === "later" && states.render === "none", states);
  check("Confirm & Generate is disabled until the cost is approved", await page.getByTestId("confirm-generate").isDisabled());
  await page.screenshot({ path: `${SHOTS}/04-job-estimate.png`, fullPage: true });
  const callsBefore = Number(sql(`SELECT count(*) FROM "AiGatewayCall"`));
  await page.getByTestId("approve-cost").check();
  await page.getByTestId("confirm-generate").click();
  await page.waitForFunction(() => document.querySelector("[data-testid=job-workspace]")?.getAttribute("data-job-status") === "QUEUED", null, { timeout: 30000 });
  check("confirmed → QUEUED; quote USED; no AI request made", sql(`SELECT status FROM "VideoJob" WHERE id='${jobId}'`) === "QUEUED" && sql(`SELECT count(*) FROM "AiCostQuote" WHERE status='USED'`) === "1" && Number(sql(`SELECT count(*) FROM "AiGatewayCall"`)) === callsBefore);
  check("configuration is locked after confirmation", await page.locator("#c-lang").isDisabled());
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("cancel-job").click();
  await page.waitForFunction(() => document.querySelector("[data-testid=job-workspace]")?.getAttribute("data-job-status") === "CANCELLED", null, { timeout: 30000 });
  check("cancel → CANCELLED", sql(`SELECT status FROM "VideoJob" WHERE id='${jobId}'`) === "CANCELLED");

  console.log("\nE. Question Bank source");
  await page.goto(`${BASE}/admin/video-studio/new`);
  await page.getByTestId("source-questions").click();
  await page.getByRole("button", { name: /Search/ }).click();
  await page.getByTestId("question-hits").waitFor({ timeout: 15000 });
  await page.getByTestId("question-hits").locator("input[type=checkbox]").first().check();
  check("picked question shown", (await page.getByTestId("picked").locator("span").count()) === 1);
  await Promise.all([page.waitForURL(/\/jobs\//, { timeout: 30000 }), page.getByTestId("auto-configure").click()]);
  const qReasons = await page.getByTestId("config-reasons").textContent();
  check("exam label comes from the selected question", /Exam label “.+” comes from the selected questions/.test(qReasons), qReasons);

  console.log("\nF. Skill Library + Settings");
  await page.goto(`${BASE}/admin/video-studio/skills`);
  await page.getByLabel("Add Hook Writer to a preset").check();
  await page.getByLabel("Add MCQ Explainer to a preset").check();
  await page.getByLabel("Preset name").fill("Hinglish MCQ Reel");
  await page.getByTestId("save-preset").click();
  await page.getByTestId("presets").waitFor({ timeout: 15000 });
  check("preset saved", (await page.getByTestId("presets").textContent()).includes("Hinglish MCQ Reel"));
  await page.goto(`${BASE}/admin/video-studio/settings`);
  await page.getByTestId("run-cleanup").click();
  await page.getByTestId("settings-msg").waitFor({ timeout: 30000 });
  const cleanupMsg = await page.getByTestId("settings-msg").textContent();
  check("cleanup runs from Settings", cleanupMsg.startsWith("Cleanup done"), cleanupMsg);
  // Precondition: no render worker. (Confirming a job above makes the server start the worker, which writes a fresh heartbeat.)
  sql(`DELETE FROM "Setting" WHERE key='video.worker'`);
  await page.goto(`${BASE}/admin/video-studio/editor`);
  check("AI Video Editor states it is not available yet (no fake upload)", (await page.getByTestId("editor-unavailable").count()) === 1 && (await page.locator("input[type=file]").count()) === 0);

  console.log("\nG. Mobile layout (390 px)");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ["/admin/video-studio", "/admin/video-studio/new", `/admin/video-studio/jobs/${jobId}`, "/admin/video-studio/designs", "/admin/video-studio/history"]) {
    await page.goto(`${BASE}${p}`);
    check(`no horizontal page scroll at 390 px: ${p}`, await noHorizontalOverflow(page));
  }
  await page.goto(`${BASE}/admin/video-studio/jobs/${jobId}`);
  await page.screenshot({ path: `${SHOTS}/05-job-mobile.png`, fullPage: true });

  console.log("\nH. Full Admin — read only");
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  await login(p2, "igfull");
  await p2.goto(`${BASE}/admin/video-studio`);
  check("Full Admin can open the studio", (await p2.getByTestId("capabilities").count()) === 1);
  await p2.goto(`${BASE}/admin/video-studio/new`);
  check("Full Admin cannot create videos", (await p2.getByTestId("auto-configure").count()) === 0 && (await p2.getByText("Read-only access").count()) > 0);
  await p2.goto(`${BASE}/admin/video-studio/jobs/${jobId}`);
  check("Full Admin sees no cancel / price / confirm controls", (await p2.getByTestId("cancel-job").count()) === 0 && (await p2.getByTestId("review-price").count()) === 0);
  await p2.goto(`${BASE}/admin/video-studio/settings`);
  check("Full Admin settings are read only", (await p2.getByTestId("run-cleanup").count()) === 0);
  await ctx2.close();

  check("no page errors or console errors", errors.length === 0, errors.slice(0, 5));
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
