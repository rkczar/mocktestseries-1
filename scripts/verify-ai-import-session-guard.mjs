/**
 * AI Question Importer — every screen survives a thrown Server Action call: an expired admin session
 * (the proxy redirects the action to the login page) and a dropped connection are reported in the
 * screen's own message instead of crashing the page, and nothing is changed. Also checks the AI Cost
 * Center renders its ledger summary. Scratch DB + the scratch server; run after the remove-states
 * fixture (jobs with Cancel / Delete). Never real AI.
 *
 *   BASE=http://localhost:3461 ADMIN_USER=… ADMIN_PASS=… DATABASE_URL=<scratch> NODE_PATH=<playwright> \
 *   node scripts/verify-ai-import-session-guard.mjs
 */
import { createRequire } from "node:module";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const BASE = process.env.BASE;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/\?.*$/, "") });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = $1`, [process.env.ADMIN_USER]);
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const SESSION = /^Your admin session has expired\. Reload the page to sign in again — nothing was changed\.$/;
const NETWORK = /^The server could not be reached, so it is not known whether this step ran\./;

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("dialog", (d) => d.accept());
async function login() {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", process.env.ADMIN_USER);
  await page.fill("input[name=password]", process.env.ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const text = async (sel) => ((await page.locator(sel).first().textContent().catch(() => "")) ?? "").trim();
const jobsState = async () => JSON.stringify((await db.query(`select id, status from "AiImportJob" order by id`)).rows);

await login();

section("A. Storage Manager");
await page.goto(`${BASE}/admin/ai-importer/storage`);
await page.locator("[data-testid=scan-storage]").click();
check("signed in: scan works", await until(async () => (await page.locator("[data-testid=storage-report]").count()) === 1));
await page.route("**/admin/ai-importer/storage", (r) => (r.request().method() === "POST" ? r.abort() : r.continue()));
await page.locator("[data-testid=scan-storage]").click();
check("dropped connection: says the server could not be reached (no crash)", await until(async () => NETWORK.test(await text("[data-testid=storage-msg]"))), await text("[data-testid=storage-msg]"));
await page.unroute("**/admin/ai-importer/storage");
await ctx.clearCookies();
await page.locator("[data-testid=scan-storage]").click();
check("expired session: says so, nothing changed (no crash)", await until(async () => SESSION.test(await text("[data-testid=storage-msg]"))), await text("[data-testid=storage-msg]"));
check("…the Storage Manager is still on the page", (await page.locator("[data-testid=storage-manager]").count()) === 1);

section("B. Job controls (Cancel, Delete) on the job list");
await login();
await page.goto(`${BASE}/admin/ai-importer/jobs`);
const before = await jobsState();
const cancel = page.locator("[data-testid=job-cancel]").first();
check("a job with Cancel exists (remove-states fixture)", (await cancel.count()) === 1);
await ctx.clearCookies();
await cancel.click();
check("expired session: Cancel reports it in the job's message", await until(async () => SESSION.test(await text("[data-testid=job-controls-message]"))), await text("[data-testid=job-controls-message]"));
const del = page.locator("[data-testid=job-delete]").first();
if ((await del.count()) === 1) {
  await del.click();
  check("expired session: Delete's preview reports it in the dialog", await until(async () => SESSION.test(await text("[data-testid=delete-error]"))), await text("[data-testid=delete-error]"));
} else check("a job with Delete exists", false);
check("no job changed", (await jobsState()) === before);

section("C. AI Cost Center");
await login();
await page.goto(`${BASE}/admin/ai-importer/costs`);
const summary = await text("[data-testid=cost-summary]");
check("summary: estimated today, actual today, total actual, budget remaining", ["Estimated cost today", "Actual spend today", "Total actual importer spend", "Budget remaining"].every((s) => summary.includes(s)), summary.slice(0, 300));
check("no NaN / undefined anywhere", !/NaN|undefined/.test(await page.locator("main").innerText()));
check("direct Gemini API shown with 0 calls (not used by the importer)", /Gemini \(direct API\): 0 calls — not used by the importer/.test(await text("[data-testid=cost-gemini-direct]")));
check("limits shown: ₹10 all-time, ₹10 monthly, ₹8 per job, ₹1 per request; paid AI state shown", /of ₹10\.00[\s\S]*of ₹10\.00[\s\S]*₹8\.00[\s\S]*₹1\.00/.test(await text("[data-testid=cost-limits]")) && /^(On|Off)$/.test(await text("[data-testid=cost-paid]")));

check("no page errors", errors.length === 0, errors);
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
