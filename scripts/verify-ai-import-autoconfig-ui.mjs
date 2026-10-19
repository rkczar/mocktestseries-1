/**
 * AI Question Importer — Import Settings → "AI Auto-Configure Everything" and the job page's
 * "Reconfigure Models for This Job" (browser). Preview before saving, Cancel, Apply after confirmation
 * (re-validated: a route that stops serving refuses the save), unsaved-changes guard, read-only view,
 * mobile, and the paused-job dialog. Scratch DB + mock OpenRouter (its chat counter proves no AI request).
 * Run scripts/ai-import-ui-fixture.ts setup and scripts/ai-import-autoconfig-ui-fixture.ts setup first.
 *
 *   BASE=http://localhost:3461 FIXTURE=/tmp/aiui.json AUTOCONF=/tmp/autoconf.json MOCK=http://127.0.0.1:3531 \
 *   ADMIN_USER=… ADMIN_PASS=… DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-ai-import-autoconfig-ui.mjs
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
const A = JSON.parse(readFileSync(process.env.AUTOCONF, "utf8"));
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
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const mockConfig = (c) => fetch(`${MOCK}/__mock/config`, { method: "POST", body: JSON.stringify(c) });
const chats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()).chat;
const saved = async () => (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value ?? null;
const otherSettings = async () => JSON.stringify((await db.query(`select key, value from "Setting" where key not in ('ai.importer','ai.importer.routes','api.openrouter','ai.fx') order by key`)).rows);
const globalFlags = async () => JSON.stringify((await db.query(`select id, approved, "medicallyApproved" from "AiModel" order by id`)).rows);
const job = async () => (await db.query(`select status, config, "pauseReason", "spentInr" from "AiImportJob" where id=$1`, [A.jobId])).rows[0];
const URL_SETTINGS = `${BASE}/admin/ai-importer/settings`;

await mockConfig({ routeStatus: {}, zdrStatus: null, rateLimit: {}, chatDelayMs: 0 });
const flags0 = await globalFlags();
const others0 = await otherSettings();
const chats0 = await chats();
const raw0 = JSON.stringify(await saved());
const page = await newPage();
await login(page, process.env.ADMIN_USER, process.env.ADMIN_PASS);

try {
  section("A. Preview — nothing saved, no AI request");
  await page.goto(URL_SETTINGS);
  const btn = page.locator("[data-testid=autoconfig-run]");
  check("the “AI Auto-Configure Everything” button is shown", (await btn.isVisible()) && /AI Auto-Configure Everything/.test(await btn.textContent()));
  await btn.click();
  const pv = page.locator("[data-testid=autoconfig-preview]");
  check("the AI Auto-Configuration Preview opens", !!(await until(() => pv.isVisible())) && /AI Auto-Configuration Preview/.test(await pv.textContent()));
  const tasks = page.locator("[data-testid=autoconfig-task]");
  check("eight tasks shown", (await tasks.count()) === 8, await tasks.count());
  const scanned = page.locator("[data-testid=autoconfig-task][data-task=scanned]");
  const model = await scanned.getAttribute("data-model");
  check("scanned OCR has a model with a verified route, a price and the reason", !!model && /Route verified/.test(await scanned.textContent()) && /per request/.test(await scanned.locator("[data-testid=autoconfig-price]").textContent()) && (await scanned.locator("[data-testid=autoconfig-reason]").textContent()).length > 40, model);
  check("quality is “Not tested” on every task", (await page.locator("[data-testid=autoconfig-quality]").allTextContents()).every((t) => /Not tested/.test(t)) && (await page.locator("[data-testid=autoconfig-quality]").count()) === 8);
  check("cost: estimate and conservative maximum shown", /₹/.test(await page.locator("[data-testid=autoconfig-est]").textContent()) && /₹/.test(await page.locator("[data-testid=autoconfig-max]").textContent()));
  check("current versus proposed table shown; Paid AI and budgets unchanged", (await page.locator("[data-testid=autoconfig-change][data-key=aiEnabled]").getAttribute("data-changed")) === "false" && /unchanged/.test(await page.locator("[data-testid=autoconfig-change][data-key=budget]").textContent()) && (await page.locator("[data-testid=autoconfig-change][data-changed=true]").count()) > 0);
  check("says 0 AI requests and Paid AI OFF (not switched on)", (await pv.getAttribute("data-ai-requests")) === "0" && (await pv.getAttribute("data-paid-ai")) === "off" && /does not switch it on/.test(await page.locator("[data-testid=autoconfig-method]").textContent()));
  check("nothing was saved by the preview", JSON.stringify(await saved()) === raw0);
  check("no AI (chat) request reached the mock", (await chats()) === chats0);

  section("B. Cancel");
  await page.locator("[data-testid=autoconfig-cancel]").click();
  check("Cancel closes the preview and saves nothing", (await pv.count()) === 0 && JSON.stringify(await saved()) === raw0);

  section("C. A failed re-check before saving keeps the previous settings");
  await btn.click();
  await until(() => pv.isVisible());
  await mockConfig({ routeStatus: { [model]: -5 } });
  await page.locator("[data-testid=autoconfig-apply]").click();
  const err = page.locator("[data-testid=autoconfig-error]");
  check("Apply is refused with the reason", !!(await until(() => err.isVisible())) && /re-check before saving/.test(await err.textContent()), await err.textContent().catch(() => null));
  check("…and the previous settings are unchanged", JSON.stringify(await saved()) === raw0);
  await mockConfig({ routeStatus: {} });

  section("D. Apply after confirmation");
  await btn.click();
  await until(async () => (await pv.isVisible()) && (await err.count()) === 0);
  const proposedModel = await page.locator("[data-testid=autoconfig-task][data-task=scanned]").getAttribute("data-model");
  await page.locator("[data-testid=autoconfig-apply]").click();
  const done = page.locator("[data-testid=autoconfig-applied]");
  check("saved message shown", !!(await until(() => done.isVisible())) && /Paid AI and budgets are unchanged/.test(await done.textContent()));
  const s = await saved();
  check("the saved settings pin the previewed models (manual) and keep Paid AI OFF and the budgets", s.selection.mode === "manual" && s.models.extract === proposedModel && s.aiEnabled === false && s.budget.maxRequestInr === 1 && s.budget.maxJobInr === 8 && s.budget.totalInr === 10 && s.budget.allowPricierFallback === false, { sel: s.selection, m: s.models, ai: s.aiEnabled });
  check("audited", (await db.query(`select count(*)::int n from "AuditLog" where action='AI_IMPORTER_AUTOCONFIG_APPLIED'`)).rows[0].n >= 1);
  check("the form shows the saved values (manual selection, 150 DPI) without a reload", await until(async () => (await page.locator("[data-testid=sel-manual]").isChecked()) && (await page.locator("[data-testid=l-dpi]").inputValue()) === "150"), await page.locator("[data-testid=l-dpi]").inputValue());
  check("no other setting and no AI → Models approval changed", (await otherSettings()) === others0 && (await globalFlags()) === flags0);
  check("the paused job kept its confirmed models", (await job()).status === "PAUSED" && (await job()).config.modelPlan.tasks.extract.model !== undefined);

  section("E. Unsaved changes block the run");
  await page.locator("[data-testid=l-conc]").fill("1");
  await page.locator("[data-testid=l-conc]").blur();
  check("with unsaved edits the button is disabled and says why", (await btn.isDisabled()) && (await page.locator("[data-testid=autoconfig-dirty]").isVisible()));

  section("F. Reconfigure Models for This Job (paused import)");
  const jp = await newPage();
  await login(jp, process.env.ADMIN_USER, process.env.ADMIN_PASS);
  await jp.goto(`${BASE}/admin/ai-importer/jobs/${A.jobId}`);
  const before = await job();
  const rb = jp.locator("[data-testid=job-reconfigure]");
  check("the paused import offers “Reconfigure Models for This Job”", await until(() => rb.isVisible()));
  await rb.click();
  const rpv = jp.locator("[data-testid=reconfigure-preview]");
  check("the dialog shows current → proposed models and the remaining cost, 0 AI requests", !!(await until(() => rpv.isVisible())) && (await jp.locator("[data-testid=reconfigure-task]").count()) === 4 && /conservative maximum/.test(await jp.locator("[data-testid=reconfigure-cost]").textContent()) && (await rpv.getAttribute("data-ai-requests")) === "0");
  check("the proposed page-reading model is the newly configured one", (await jp.locator("[data-testid=reconfigure-task][data-task=extract]").getAttribute("data-proposed")) === proposedModel);
  await jp.locator("[data-testid=reconfigure-cancel]").click();
  check("Cancel changes nothing", JSON.stringify(await job()) === JSON.stringify(before));
  await rb.click();
  await until(() => rpv.isVisible());
  await jp.locator("[data-testid=reconfigure-confirm]").click();
  const msg = jp.locator("[data-testid=job-notice]");
  check("confirmed: message says Paid AI is OFF and the import stays paused", !!(await until(() => msg.isVisible())) && /Paid AI is OFF/.test(await msg.textContent()), await msg.textContent().catch(() => null));
  const after = await job();
  check("…the job holds the new models, is still paused, nothing spent", after.status === "PAUSED" && after.config.modelPlan.tasks.extract.model === proposedModel && after.spentInr === 0 && /Paid AI is OFF/.test(after.pauseReason));
  check("…event and audit recorded", (await db.query(`select count(*)::int n from "AiImportEvent" where "jobId"=$1 and type='MODEL_RECONFIGURED'`, [A.jobId])).rows[0].n === 1 && (await db.query(`select count(*)::int n from "AuditLog" where action='AI_IMPORTER_JOB_RECONFIGURED' and "entityId"=$1`, [A.jobId])).rows[0].n === 1);
  // A saved manual choice that cannot read page images: the dialog proposes a substitute and says why.
  await db.query(`update "Setting" set value = jsonb_set(value, '{models,extract}', '"mocktext/classifier"') where key = 'ai.importer'`);
  await jp.reload();
  await rb.click();
  await until(() => rpv.isVisible());
  const ext = jp.locator("[data-testid=reconfigure-task][data-task=extract]");
  const why = ext.locator("[data-testid=reconfigure-task-reason]");
  check("substitution: the unusable manual choice is replaced, with the cause, the substitute and “Not tested” shown", (await ext.getAttribute("data-substituted")) === "mocktext/classifier" && !!(await ext.getAttribute("data-proposed")) && (await ext.getAttribute("data-proposed")) !== "mocktext/classifier" && /cannot read images/.test(await why.textContent()) && /Proposed instead/.test(await why.textContent()) && /Not tested/.test(await ext.textContent()), await ext.textContent().catch(() => null));
  await jp.locator("[data-testid=reconfigure-cancel]").click();

  section("G. Mobile and read-only");
  const m = await newPage(true);
  await login(m, process.env.ADMIN_USER, process.env.ADMIN_PASS);
  await m.goto(URL_SETTINGS);
  await m.locator("[data-testid=autoconfig-run]").click();
  await until(() => m.locator("[data-testid=autoconfig-preview]").isVisible());
  check("mobile 375 px: preview without horizontal page scroll", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  const full = await newPage();
  await login(full, F.fullAdmin, F.password);
  await full.goto(URL_SETTINGS);
  check("FULL_ADMIN (view only): no Auto-Configure card", (await full.locator("[data-testid=selection-card]").isVisible()) && (await full.locator("[data-testid=autoconfig]").count()) === 0);
  check("no page errors", errors.length === 0, errors);
  check("whole run: no AI (chat) request reached the mock", (await chats()) === chats0);
} finally {
  await mockConfig({ routeStatus: {} });
  await db.end();
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
  process.exit(fail ? 1 : 0);
}
