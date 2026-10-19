/**
 * AI Question Importer — Import Settings → Model Assistant and the saved / unsaved Paid AI status (browser).
 * "Find Best Models with AI" (deterministic, catalog-based), "Apply Recommended Models" (preview, explicit
 * confirmation, importer list only), "Test Models" (configuration checks only), read-only view, mobile.
 * Scratch DB + mock OpenRouter (the mock's chat counter proves no AI request is sent). Run
 * scripts/ai-import-ui-fixture.ts setup first (key, synced mock catalog, FULL_ADMIN). Never real AI.
 *
 *   BASE=http://localhost:3461 FIXTURE=/tmp/aiui.json MOCK=http://127.0.0.1:3531 ADMIN_USER=… ADMIN_PASS=… \
 *   DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-ai-import-assistant-ui.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const BASE = process.env.BASE;
const MOCK = process.env.MOCK;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = any($1)`, [[process.env.ADMIN_USER, F.fullAdmin]]);
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
const browser = await chromium.launch();
const errors = [];
async function newPage(mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  return page;
}
async function login(page, user, pw) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pw);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
async function until(fn, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const chats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()).chat;
const saved = async () => (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value ?? null;
const globalFlags = async () => JSON.stringify((await db.query(`select id, approved, "medicallyApproved" from "AiModel" order by id`)).rows);
const URL_SETTINGS = `${BASE}/admin/ai-importer/settings`;

await db.query(`delete from "Setting" where key in ('ai.importer', 'ai.importer.routes')`);
const START = ["mockvision/reader", "mocktext/classifier"];
await db.query(`insert into "Setting" (key, value, "updatedAt") values ('ai.importer', $1::jsonb, now())`, [JSON.stringify({ aiEnabled: false, importerModels: START, privacy: { zdr: false, dataCollection: "deny" }, selection: { mode: "auto" } })]);
const flags0 = await globalFlags();
const chats0 = await chats();
const page = await newPage();
await login(page, process.env.ADMIN_USER, process.env.ADMIN_PASS);

try {
  section("A. Paid AI status shows the SAVED switch; an unsaved tick is named as unsaved");
  await page.goto(URL_SETTINGS);
  const paid = () => page.locator("[data-testid=status-paid]").textContent();
  check("saved OFF → “OFF (saved)”", /OFF \(saved\)/.test(await paid()) && !/Unsaved change/.test(await paid()), await paid());
  await page.locator("[data-testid=ai-enabled]").check();
  check("ticked but not saved → still “OFF (saved)” plus “Unsaved change: it will be ON only after you save”", /OFF \(saved\)/.test(await paid()) && /Unsaved change: it will be ON only after you save/.test(await paid()), await paid());
  check("…and the database still says OFF", (await saved()).aiEnabled === false);

  section("B. Find Best Models with AI — deterministic, no AI request");
  check("Apply is not offered before recommendations exist", (await page.locator("[data-testid=assistant-apply]").count()) === 0);
  await page.locator("[data-testid=assistant-find]").click();
  await until(() => page.locator("[data-testid=assistant-result]").isVisible());
  check("result shown, method = catalog", (await page.locator("[data-testid=assistant-result]").getAttribute("data-method")) === "catalog");
  check("the method note says Paid AI is OFF and no AI request was sent", /Paid AI is OFF/.test(await page.locator("[data-testid=assistant-method]").textContent()) && /No AI request was sent/.test(await page.locator("[data-testid=assistant-method]").textContent()));
  for (const p of ["ocr", "mathematics", "chemistry", "diagrams", "answer_key", "verification", "classification"]) check(`purpose shown: ${p}`, (await page.locator(`[data-testid=assistant-purpose-${p}]`).count()) === 1);
  const cands = page.locator("[data-testid=assistant-candidate]");
  const n = await cands.count();
  check("candidates listed, every one labelled “Quality: Not tested”", n > 0 && (await page.locator("[data-testid=assistant-quality]").count()) === n && (await page.locator("[data-testid=assistant-quality]").allTextContents()).every((t) => t === "Quality: Not tested"), n);
  check("each candidate shows price, route, recent requests and test status", (await page.locator("[data-testid=assistant-price]").count()) === n && (await page.locator("[data-testid=assistant-route]").count()) === n && (await page.locator("[data-testid=assistant-history]").count()) === n && (await page.locator("[data-testid=assistant-test]").count()) === n);
  check("OCR has a recommended model", ((await page.locator("[data-testid=assistant-purpose-ocr]").getAttribute("data-recommended")) ?? "") !== "");
  check("verification recommends a different model than OCR", (await page.locator("[data-testid=assistant-purpose-verification]").getAttribute("data-recommended")) !== (await page.locator("[data-testid=assistant-purpose-ocr]").getAttribute("data-recommended")));
  check("no AI (chat) request reached the mock", (await chats()) === chats0);

  section("C. Apply needs saved settings, a preview and an explicit confirmation");
  check("with an unsaved change, Apply is disabled and says why", (await page.locator("[data-testid=assistant-apply]").isDisabled()) && (await page.locator("[data-testid=assistant-dirty]").isVisible()));
  await page.locator("[data-testid=ai-enabled]").uncheck();
  check("back to the saved state → Apply enabled", !(await page.locator("[data-testid=assistant-apply]").isDisabled()));
  await page.locator("[data-testid=assistant-apply]").click();
  check("preview lists what is added and what is not changed", (await page.locator("[data-testid=assistant-preview]").isVisible()) && /Add:/.test(await page.locator("[data-testid=assistant-preview-add]").textContent()) && /student Ask AI/.test(await page.locator("[data-testid=assistant-preview]").textContent()));
  const toAdd = (await page.locator("[data-testid=assistant-preview-add] code").allTextContents()).map((s) => s.trim());
  await page.locator("[data-testid=assistant-cancel]").click();
  check("Cancel → nothing saved", JSON.stringify((await saved()).importerModels) === JSON.stringify(START));
  await page.locator("[data-testid=assistant-apply]").click();
  await page.locator("[data-testid=assistant-confirm]").click();
  await until(() => page.locator("[data-testid=assistant-applied]").isVisible());
  const after = await saved();
  check("Confirm → exactly the previewed models were added to the importer list", toAdd.length > 0 && JSON.stringify(after.importerModels) === JSON.stringify([...START, ...toAdd]), { toAdd, list: after.importerModels });
  check("…Paid AI, privacy and selection unchanged", after.aiEnabled === false && after.privacy.zdr === false && after.selection.mode === "auto");
  check("…no global AI → Models approval changed", (await globalFlags()) === flags0);
  check("…re-validation per task shown after saving", (await page.locator("[data-testid=assistant-revalidated] li").count()) === 4);
  await until(async () => (await page.locator("[data-testid=importer-model]").count()) === START.length + toAdd.length);
  check("…the Importer models card shows the new list", (await page.locator("[data-testid=importer-model]").count()) === START.length + toAdd.length);
  check("…and the form is not left with an unsaved change", (await page.locator("[data-testid=assistant-dirty]").count()) === 0);
  check("no AI (chat) request reached the mock", (await chats()) === chats0);

  section("D. Test Models — configuration checks only");
  await page.locator("[data-testid=assistant-test-models]").click();
  await until(() => page.locator("[data-testid=assistant-report]").isVisible());
  check("report says 0 AI requests", (await page.locator("[data-testid=assistant-report]").getAttribute("data-ai-requests")) === "0");
  check("one entry per importer model", (await page.locator("[data-testid=assistant-model-test]").count()) === after.importerModels.length);
  check("quality test button is disabled, with the reason", (await page.locator("[data-testid=assistant-quality-test]").isDisabled()) && /separately/.test(await page.locator("[data-testid=assistant-quality-reason]").textContent()));
  check("no AI (chat) request reached the mock", (await chats()) === chats0);

  section("E. Mobile and read-only");
  const m = await newPage(true);
  await login(m, process.env.ADMIN_USER, process.env.ADMIN_PASS);
  await m.goto(URL_SETTINGS);
  await m.locator("[data-testid=assistant-find]").click();
  await until(() => m.locator("[data-testid=assistant-result]").isVisible());
  check("mobile 375 px: recommendations without horizontal page scroll", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const full = await newPage();
  await login(full, F.fullAdmin, F.password);
  await full.goto(URL_SETTINGS);
  await full.locator("[data-testid=assistant-find]").click();
  await until(() => full.locator("[data-testid=assistant-result]").isVisible());
  check("FULL_ADMIN (view only): can see recommendations but has no Apply", (await full.locator("[data-testid=assistant-result]").isVisible()) && (await full.locator("[data-testid=assistant-apply]").count()) === 0);
  check("no page errors", errors.length === 0, errors);
  check("whole run: no AI (chat) request reached the mock", (await chats()) === chats0);
} finally {
  await db.query(`delete from "Setting" where key in ('ai.importer', 'ai.importer.routes')`);
  await db.end();
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
  process.exit(fail ? 1 : 0);
}
