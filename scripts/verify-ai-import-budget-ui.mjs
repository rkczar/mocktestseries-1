/**
 * AI Question Importer — job budget on the job page (Playwright), against a scratch `next start` with the
 * mock OpenRouter. Synthetic fixtures only; the background worker loop must run (it analyzes the upload). Any
 * mock AI request before a budget is accepted fails the suite.
 *
 *   BASE=http://localhost:3461 FX_DIR=… FIXTURE=<ai-import-ui-fixture.json> ADMIN_USER=… ADMIN_PASS=… \
 *   DATABASE_URL=<scratch> MOCK=http://127.0.0.1:3531 NODE_PATH=<playwright> node scripts/verify-ai-import-budget-ui.mjs
 *
 * Regression for: Confirm / Resume stayed clickable for budgets the server always refuses, the refusal was
 * printed far above the button (out of view), the remaining all-time / monthly budgets were not shown, and an
 * empty Resume budget re-queued a paused job with ₹0.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { BASE, FX_DIR: FX, MOCK } = process.env;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against what looks like the production database.");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = $1`, [process.env.ADMIN_USER]);
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
const chats = async () => (await (await fetch(`${MOCK}/__mock/stats`)).json()).chat;
const browser = await chromium.launch();
const created = { jobs: [], reservations: [] };

async function newPage(mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e).slice(0, 200)));
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", process.env.ADMIN_USER);
  await page.fill("input[name=password]", process.env.ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  return page;
}
const inView = (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
const problems = (page, id = "confirm") => page.locator(`[data-testid=${id}-budget-problem]`).allTextContents();
const fingerprint = async (id) => JSON.stringify((await db.query(`select status, "budgetInr", "estCostInr", "confirmedAt", "updatedAt", "spentInr" from "AiImportJob" where id=$1`, [id])).rows[0]);

try {
  const chats0 = await chats();
  const page = await newPage();
  section("A. Setup (synthetic scanned paper, paid AI on with mock models)");
  const settingsRow = (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value ?? null;
  await db.query(`delete from "Setting" where key in ('ai.importer','ai.importer.routes')`);
  await db.query(`delete from "AiBudgetReservation" where feature like 'qimport_%'`);
  await page.goto(`${BASE}/admin/ai-importer/settings`);
  await page.locator("[data-testid=ai-enabled]").check();
  for (const id of ["mockvision/reader", "mockvision/checker", "mockvision/mid", "mocktext/classifier"]) {
    await page.locator("[data-testid=importer-model-search]").fill(id);
    await page.locator(`[data-testid=importer-model-hits] li[data-model-id="${id}"] [data-testid=importer-model-add]`).click();
  }
  await page.locator("[data-testid=routes-refresh]").click();
  await page.waitForTimeout(4000);
  await page.locator("[data-testid=settings-save]").click();
  await page.locator("[data-testid=settings-msg]").waitFor();
  const settingsSaved = JSON.stringify((await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value);
  await page.goto(`${BASE}/admin/ai-importer`);
  await page.selectOption("[data-testid=op-exam]", F.examId);
  await page.selectOption("[data-testid=op-pyq]", F.paperId);
  await page.fill("[data-testid=op-expected]", "10");
  await Promise.all([page.waitForURL(/job=/, { timeout: 90000 }), page.locator("[data-testid=op-upload-input]").setInputFiles({ name: `AIUI budget ${F.suffix}.pdf`, mimeType: "application/pdf", buffer: readFileSync(path.join(FX, "scanned.pdf")) })]);
  const jobId = new URL(page.url()).searchParams.get("job");
  created.jobs.push(jobId);
  for (let i = 0; i < 60 && (await db.query(`select status from "AiImportJob" where id=$1`, [jobId])).rows[0]?.status !== "AWAITING_CONFIRMATION"; i++) await page.waitForTimeout(1000);
  const est = (await db.query(`select analysis->'estimate'->>'totalInr' t, analysis->'estimate'->>'maxInr' m from "AiImportJob" where id=$1`, [jobId])).rows[0];
  const max = Number(est.m);
  check("synthetic scanned job awaiting confirmation with a priced estimate", max > 0, est);

  section("B. Every limit is shown separately");
  await page.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
  await page.locator("[data-testid=confirm-budget]").waitFor();
  const lim = async (id) => (await page.locator(`[data-testid=${id}]`).textContent()) ?? "";
  check("estimate and conservative maximum", /Current estimated cost: ₹/.test(await lim("limit-estimate")) && (await lim("limit-max")).includes(`₹${max.toFixed(2)}`), [await lim("limit-estimate"), await lim("limit-max")]);
  check("hard limit per job, limit per AI request", /Hard limit per job: ₹8\.00/.test(await lim("limit-job")) && /Limit per AI request: ₹1\.00/.test(await lim("limit-request")), [await lim("limit-job"), await lim("limit-request")]);
  check("all-time and this month's importer budget left", /All-time importer budget left: ₹10\.00 of ₹10\.00/.test(await lim("limit-alltime")) && /This month's importer budget left: ₹10\.00 of ₹10\.00/.test(await lim("limit-month")), [await lim("limit-alltime"), await lim("limit-month")]);

  section("C. Changing the budget: immediate value, reasons and Confirm state (no reload)");
  const before = await fingerprint(jobId);
  const btn = page.locator("[data-testid=confirm-start]");
  const cases = [
    ["10", false, /above the hard limit per job \(₹8\.00/],
    ["8.01", false, /above the hard limit per job/],
    ["", false, /Enter a job budget/],
    ["1..5", false, /up to 2 decimals/],
    ["0", false, /conservative maximum AI cost .* is above the job budget \(₹0\.00\)/],
    [(Math.floor(max * 100 - 1e-9) / 100).toFixed(2), false, /conservative maximum/],
  ];
  for (const [v, enabled, re] of cases) {
    await page.fill("[data-testid=confirm-budget]", v);
    const shown = await page.locator("[data-testid=confirm-budget]").inputValue();
    const p = (await problems(page)).join(" | ");
    check(`budget "${v}": shown at once, Confirm ${enabled ? "enabled" : "disabled"}, reason shown`, shown === v && (await btn.isEnabled()) === enabled && re.test(p), { shown, enabled: await btn.isEnabled(), p });
  }
  const minOk = (Math.ceil(max * 100 - 1e-9) / 100).toFixed(2);
  await page.fill("[data-testid=confirm-budget]", "0");
  check("an invalid budget shows the accepted range", (await page.locator("[data-testid=confirm-budget-range]").textContent())?.includes(`at least ₹${minOk} and at most ₹8.00`), await page.locator("[data-testid=confirm-budget-range]").textContent());
  for (const v of [minOk, "8"]) {
    await page.fill("[data-testid=confirm-budget]", v);
    check(`budget "${v}": Confirm enabled, 'within every limit' shown, no reasons`, (await btn.isEnabled()) && (await page.locator("[data-testid=confirm-budget-ok]").count()) === 1 && (await problems(page)).length === 0);
  }
  check("typing budgets changed nothing on the job and sent no AI request", (await fingerprint(jobId)) === before && (await chats()) === chats0);

  section("D. Budgets that cannot help: all-time budget nearly used");
  await db.query(`insert into "AiBudgetReservation" (id, "requestKey", feature, "reservedInr", "settledInr", status, "istDay", "istMonth", "createdAt", "settledAt", "costKnown") values ('budget-ui-spent', 'qi:budget-ui:1', 'qimport_extract', $1, $1, 'SETTLED', '2000-01-01', '2000-01', now(), now(), true)`, [10 - max / 2]);
  created.reservations.push("budget-ui-spent");
  await page.reload();
  await page.locator("[data-testid=confirm-budget]").fill("8");
  check("all-time budget left is shown", (await lim("limit-alltime")).includes(`₹${(max / 2).toFixed(2)} of ₹10.00`), await lim("limit-alltime"));
  check("any budget: Confirm disabled, reason names the all-time budget, and says changing the budget cannot fix it", (await btn.isDisabled()) && /all-time budget/.test((await problems(page)).join()) && (await page.locator("[data-testid=confirm-budget-impossible]").count()) === 1);
  await db.query(`delete from "AiBudgetReservation" where id='budget-ui-spent'`);

  section("E. A server refusal is shown next to the button (stale estimate re-priced by the server)");
  await db.query(`update "AiImportJob" set analysis = jsonb_set(jsonb_set(analysis::jsonb, '{estimate,maxInr}', '0.002'), '{estimate,totalInr}', '0.001') where id=$1`, [jobId]);
  await page.reload();
  await page.locator("[data-testid=confirm-budget]").fill("0.01");
  check("the stale estimate lets the page enable Confirm for ₹0.01", await btn.isEnabled());
  const before2 = await fingerprint(jobId);
  await btn.click();
  await page.locator("[data-testid=confirm-error]").waitFor({ timeout: 30000 });
  const errText = await page.locator("[data-testid=confirm-error]").textContent();
  check("the server's refusal appears right under the button, inside the viewport", /conservative maximum|estimated AI cost/.test(errText) && (await inView(page.locator("[data-testid=confirm-error]"))), errText);
  check("…the job is unchanged and no AI request was sent", (await fingerprint(jobId)) === before2 && (await chats()) === chats0);
  await db.query(`update "AiImportJob" set analysis = jsonb_set(jsonb_set(analysis::jsonb, '{estimate,maxInr}', to_jsonb($2::float8)), '{estimate,totalInr}', to_jsonb($3::float8)) where id=$1`, [jobId, max, Number(est.t)]);

  section("F. Expired admin session while confirming");
  await page.reload();
  await page.locator("[data-testid=confirm-budget]").fill("8");
  await page.context().clearCookies();
  await btn.click();
  await page.locator("[data-testid=confirm-error]").waitFor({ timeout: 30000 });
  check("expired session: the message is shown next to the button, nothing changed", /session has expired/.test(await page.locator("[data-testid=confirm-error]").textContent()) && (await fingerprint(jobId)) === before2);

  check("no AI request before a budget was accepted", (await chats()) === chats0);

  section("G. A valid budget starts processing");
  const page2 = await newPage();
  await page2.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
  await page2.locator("[data-testid=confirm-budget]").fill(minOk);
  await page2.locator("[data-testid=confirm-start]").click();
  await page2.locator("[data-testid=job-notice]").waitFor({ timeout: 60000 });
  const row = (await db.query(`select status, "budgetInr" from "AiImportJob" where id=$1`, [jobId])).rows[0];
  check("confirmed: queued with the entered budget, 'Processing queued.' shown", row.status !== "AWAITING_CONFIRMATION" && row.budgetInr === Number(minOk) && /Processing queued/.test(await page2.locator("[data-testid=job-notice]").textContent()), row);
  check("the job budget did not change the importer's global settings", JSON.stringify((await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value) === settingsSaved);

  section("H. Resume with a budget");
  const admin = (await db.query(`select id from "AdminUser" where username=$1`, [process.env.ADMIN_USER])).rows[0].id;
  const exam = (await db.query(`select "examId" from "AiImportJob" where id=$1`, [jobId])).rows[0].examId;
  const pausedId = `budgetui${Date.now().toString(36)}`;
  await db.query(`insert into "AiImportJob" (id, title, status, "examId", "createdById", "budgetInr", "spentInr", "pauseReason", "createdAt", "updatedAt") values ($1, 'AIUI budget paused', 'PAUSED', $2, $3, 8, 0.4, 'Paused by an administrator', now(), now())`, [pausedId, exam, admin]);
  created.jobs.push(pausedId);
  await page2.goto(`${BASE}/admin/ai-importer/jobs/${pausedId}`);
  const rb = page2.locator("[data-testid=resume]");
  const pausedBefore = await fingerprint(pausedId);
  for (const [v, re] of [["", /Enter a job budget/], ["0.40", /above what this import has already spent \(₹0\.40\)/], ["9", /above the hard limit per job/]]) {
    await page2.locator("[data-testid=resume-budget]").fill(v);
    const p = (await problems(page2, "resume")).join(" | ");
    check(`resume budget "${v}": Resume disabled with the reason`, (await rb.isDisabled()) && re.test(p), p);
  }
  check("spent, hard limit and budgets left are shown beside Resume", /Spent so far ₹0\.40 · hard limit per job ₹8\.00/.test(await page2.locator("[data-testid=resume-budget-limit]").textContent()));
  check("nothing changed on the paused job", (await fingerprint(pausedId)) === pausedBefore);
  await page2.locator("[data-testid=resume-budget]").fill("5");
  await rb.click();
  await page2.locator("[data-testid=job-notice]").waitFor({ timeout: 30000 });
  const pr = (await db.query(`select status, "budgetInr" from "AiImportJob" where id=$1`, [pausedId])).rows[0];
  check("resume with ₹5: resumed (no longer paused) with ₹5", pr.status !== "PAUSED" && pr.budgetInr === 5, pr);

  section("I. Phone width");
  const m = await newPage(true);
  const job3 = `budgetui3${Date.now().toString(36)}`;
  await db.query(`insert into "AiImportJob" (id, title, status, "examId", "createdById", "budgetInr", "spentInr", "createdAt", "updatedAt", analysis, "estCostInr") select $1, 'AIUI budget mobile', 'AWAITING_CONFIRMATION', "examId", "createdById", 8, 0, now(), now(), analysis, "estCostInr" from "AiImportJob" where id=$2`, [job3, jobId]);
  created.jobs.push(job3);
  await m.goto(`${BASE}/admin/ai-importer/jobs/${job3}`);
  await m.locator("[data-testid=confirm-budget]").fill("10");
  check("phone: limits and reasons shown, Confirm disabled, no horizontal overflow", (await m.locator("[data-testid=confirm-limits]").isVisible()) && (await m.locator("[data-testid=confirm-start]").isDisabled()) && (await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)));
  check("no page errors", page.errors.length + page2.errors.length + m.errors.length === 0, [...page.errors, ...page2.errors, ...m.errors]);
  if (settingsRow) await db.query(`update "Setting" set value=$1 where key='ai.importer'`, [settingsRow]);
} catch (e) {
  fail++;
  console.error(e);
} finally {
  await db.query(`delete from "AiBudgetReservation" where id = any($1)`, [created.reservations]);
  await db.query(`delete from "AiImportJob" where id = any($1)`, [created.jobs]);
  await browser.close();
  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
  process.exit(fail ? 1 : 0);
}
