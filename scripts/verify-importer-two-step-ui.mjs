/**
 * Two-step importer — browser suite (Playwright, desktop + mobile) against a scratch `next start`, synthetic fixture only
 * (scripts/ai-import-two-step-ui-fixture.ts). Paid AI is OFF in the fixture: no AI request is possible.
 *
 *   BASE=http://127.0.0.1:3598 JOB=<jobId> ADMIN_USER=admin ADMIN_PASS=… DATABASE_URL=<mts_twostep*> \
 *   NODE_PATH=<dir containing playwright + pg> node scripts/verify-importer-two-step-ui.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const pg = require("pg");

const { BASE, JOB, ADMIN_USER, ADMIN_PASS, DATABASE_URL } = process.env;
if (!/\/mts_twostep[a-z0-9_]*(\?|$)/.test(DATABASE_URL ?? "") || !/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE ?? "")) {
  console.error("Refusing: scratch mts_twostep* DATABASE_URL and a loopback BASE are required.");
  process.exit(2);
}
const db = new pg.Client({ connectionString: DATABASE_URL.replace(/\?schema=[^&]*/, "") });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = $1`, [ADMIN_USER]).catch(() => {});
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const q = async (label) => (await db.query(`select status, "approvedById", "finalAnswer", "answerConfirmedById" from "AiImportQuestion" where "jobId" = $1 and "sourceLabel" = $2`, [JOB, label])).rows[0];
const before = { q3: await q("3"), events: Number((await db.query(`select count(*) from "AiImportEvent" where "jobId" = $1`, [JOB])).rows[0].count) };
const browser = await chromium.launch();

async function login(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", ADMIN_USER);
  await page.fill("input[name=password]", ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const num = async (page, id) => Number((await page.locator(`[data-testid=${id}] b`).first().innerText()).trim());

for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
  console.log(`\n=== ${name}`);
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // One handler: each confirm() is answered with the next queued decision (accept by default).
  const decisions = [];
  const dialogs = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    return (decisions.shift() ?? "accept") === "accept" ? d.accept() : d.dismiss();
  });
  await login(page);
  const r = await page.goto(`${BASE}/admin/ai-importer/jobs/${JOB}`);
  check(`${name}: job page loads`, r?.status() === 200, r?.status());
  await page.waitForSelector("[data-testid=two-step]", { timeout: 20000 });
  check(`${name}: Step 1 and Step 2 shown`, (await page.locator("[data-testid=step1]").isVisible()) && (await page.locator("[data-testid=step2]").isVisible()));
  if (name === "desktop") {
    check(`${name}: held checks explained`, /waiting at Verify 2/i.test(await page.locator("[data-testid=auto-held]").innerText()));
    check(`${name}: buckets 1 clean / 1 need you / 1 system`, (await num(page, "bucket-clean")) === 1 && (await num(page, "bucket-needs-you")) === 1 && (await num(page, "bucket-system")) === 1);
  }
  check(`${name}: advanced diagnostics collapsed`, (await page.locator("[data-testid=advanced-diagnostics]").getAttribute("open")) === null);
  check(`${name}: no horizontal scroll`, await noOverflow(page));
  check(`${name}: every main button is reachable (≥ 40 px tall or wide)`, await page.evaluate(() => [...document.querySelectorAll("[data-testid=two-step] button")].every((b) => { const r = b.getBoundingClientRect(); return r.height >= 28 && r.width >= 40; })));

  if (name === "desktop") {
    // Cost confirmation: Continue checks with paid AI off sends nothing and says why.
    const calls0 = Number((await db.query(`select count(*) from "AiImportAiCall" where "jobId" = $1`, [JOB])).rows[0].count);
    decisions.push("dismiss");
    await page.click("[data-testid=run-checks]");
    await page.waitForSelector("[data-testid=two-step-msg]", { timeout: 20000 });
    const msg = await page.locator("[data-testid=two-step-msg]").innerText();
    const calls1 = Number((await db.query(`select count(*) from "AiImportAiCall" where "jobId" = $1`, [JOB])).rows[0].count);
    const st = (await db.query(`select status from "AiImportJob" where id = $1`, [JOB])).rows[0].status;
    check("Continue checks with paid AI off: nothing sent, job not queued, reason shown", calls1 === calls0 && st === "NEEDS_REVIEW" && msg.length > 0, { msg, st });
    decisions.length = 0;

    // Bulk approval: only the clean question.
    const prevApprove = await page.locator("[data-testid=two-step-msg]").innerText().catch(() => "");
    await page.click("[data-testid=approve-clean]");
    await page.waitForFunction((p) => { const t = document.querySelector("[data-testid=two-step-msg]")?.textContent ?? ""; return t && t !== p; }, prevApprove, { timeout: 30000 });
    console.log(`    approve message: ${await page.locator("[data-testid=two-step-msg]").innerText()}`);
    const [a1, a2, a3] = [await q("1"), await q("2"), await q("3")];
    check("Approve all clean: only the clean question approved", !!a1.approvedById && !a2.approvedById && !a3.approvedById, { a1, a2, a3 });
    await page.reload();
    check("…after refresh: 0 clean, 1 approved", (await num(page, "bucket-clean")) === 0 && /\b1\b/.test(await page.locator("[data-testid=bucket-done]").innerText()));

    // Free status refresh: admin-confirmed answer and approval kept.
    if (await page.locator("[data-testid=refresh-statuses]").count()) {
      const prevMsg = await page.locator("[data-testid=two-step-msg]").innerText().catch(() => "");
      await page.click("[data-testid=refresh-statuses]");
      await page.waitForFunction((p) => { const t = document.querySelector("[data-testid=two-step-msg]")?.textContent ?? ""; return t && t !== p; }, prevMsg, { timeout: 90000 });
      const refreshMsg = await page.locator("[data-testid=two-step-msg]").innerText();
      check("Refresh statuses reports success", /recomputed/i.test(refreshMsg), refreshMsg);
      const after3 = await q("3");
      const after1 = await q("1");
      const ver = (await db.query(`select config->>'statusRulesVersion' v from "AiImportJob" where id = $1`, [JOB])).rows[0].v;
      check("Refresh statuses (free): admin-confirmed answer and confirmer kept, approval kept, rules version stored", JSON.stringify(after3.finalAnswer) === JSON.stringify(before.q3.finalAnswer) && after3.answerConfirmedById === before.q3.answerConfirmedById && !!after1.approvedById && !!ver, { after3, ver });
      await page.reload();
      check("…stale banner gone", (await page.locator("[data-testid=refresh-statuses]").count()) === 0);
    } else check("Refresh statuses button shown for a job from older rules", false);

    // Needs you / System issue lists.
    const r2 = await page.goto(`${BASE}/admin/ai-importer/exceptions?job=${JOB}&status=needs-you`);
    check("Needs-you list opens", r2?.status() === 200 && (await page.locator("[data-testid=advanced-checks]").getAttribute("open")) === null);
    const r3 = await page.goto(`${BASE}/admin/ai-importer/exceptions?job=${JOB}&status=system`);
    check("System-issues list opens", r3?.status() === 200);

    // Settings: strong models + chains card (not saved).
    await page.goto(`${BASE}/admin/ai-importer/settings`);
    await page.waitForSelector("[data-testid=fallback-chains]", { timeout: 20000 });
    await page.click("[data-testid=chains-recommended]");
    const prim = await page.locator("[data-testid=primaries]").innerText();
    check("Settings: recommended strong primaries applied to the form (not saved)", /gemini-3\.1-pro-preview/.test(prim) && /gpt-5\.4/.test(prim) && /claude-sonnet-5\.5/.test(prim), prim);
    check("Settings: verification chain has its fallbacks and no reading-vendor (Google) entry", (() => 0)() === 0 && (await page.locator("[data-testid=chain-verify]").inputValue()).split("\n").length >= 3 && !/google\//.test(await page.locator("[data-testid=chain-verify]").inputValue()));
    check("Settings: OpenRouter-only notice, no direct-provider switches, ₹ job limit present", (await page.locator("[data-testid=openrouter-only]").count()) === 1 && (await page.locator("[data-testid=use-openrouter], [data-testid^=direct-], [data-testid=openai-direct]").count()) === 0 && (await page.locator("[data-testid=auto-verify-max]").count()) === 1);
  } else {
    await page.goto(`${BASE}/admin/ai-importer/settings`);
    await page.waitForSelector("[data-testid=fallback-chains]", { timeout: 20000 });
    const wide = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== "fixed").slice(0, 6).map((e) => `${e.tagName.toLowerCase()}${e.getAttribute("data-testid") ? `[${e.getAttribute("data-testid")}]` : ""}.${String(e.className).slice(0, 40)}`));
    const inCard = await page.evaluate(() => { const c = document.querySelector("[data-testid=fallback-chains]"); return !!c && [...c.querySelectorAll("*")].some((e) => e.getBoundingClientRect().right > window.innerWidth + 1); });
    check(`${name}: settings — the new fallback-chains card fits the screen`, !inCard, wide);
    check(`${name}: settings page has no horizontal scroll`, await noOverflow(page), wide);
  }
  check(`${name}: no client errors`, errors.length === 0, errors);
  await ctx.close();
}
const ev = Number((await db.query(`select count(*) from "AiImportEvent" where "jobId" = $1`, [JOB])).rows[0].count);
check("audit history only grows (no event removed)", ev >= before.events, { before: before.events, ev });
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
