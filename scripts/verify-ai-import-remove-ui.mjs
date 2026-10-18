/**
 * AI Question Importer — the per-file Remove button in every job state
 * (Uploading, linked answer key, Awaiting confirmation, Processing, Ready to
 * import, Cancelled, shared stored file), desktop + mobile, plus raw Server
 * Action calls (signed-in Master Admin against a locked job, signed out).
 * Scratch DB + synthetic jobs from scripts/ai-import-remove-states-fixture.ts.
 *
 *   BASE=http://localhost:3431 STATES=/tmp/states.json APP_DIR=<built app> ADMIN_USER=… ADMIN_PASS=… \
 *   DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-ai-import-remove-ui.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

if (/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
const BASE = process.env.BASE;
const S = JSON.parse(readFileSync(process.env.STATES, "utf8"));
const APP = process.env.APP_DIR ?? ".";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = $1`, [process.env.ADMIN_USER]);
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
const browser = await chromium.launch();
const errors = [];
async function newPage(mobile = false) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  page.on("dialog", (d) => d.dismiss().catch(() => {}));
  return page;
}
async function login(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", process.env.ADMIN_USER);
  await page.fill("input[name=password]", process.env.ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const row = (page, name) => page.locator("[data-testid=file-row]", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
/** Polls until fn() is truthy (the notice shows before the refreshed page data arrives). */
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const fileCount = async (jobId) => (await db.query(`select count(*)::int n from "AiImportFile" where "jobId"=$1`, [jobId])).rows[0].n;
const inPage = (page, url, init) => page.evaluate(async ([u, i]) => { const r = await fetch(u, { ...i, redirect: "manual" }); return { status: r.status, type: r.type, text: await r.text() }; }, [url, init ?? {}]);

/** Visual + behavioural state of one file's Remove control. */
async function removeState(page, name) {
  const btn = row(page, name).locator("[data-testid=file-remove]");
  return btn.evaluate((b) => {
    const cs = getComputedStyle(b);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = root.getPropertyValue("--color-error");
    document.body.appendChild(probe);
    const errorColor = getComputedStyle(probe).color;
    probe.remove();
    const why = b.closest("td")?.querySelector("[data-testid=file-remove-why]");
    const whyVisible = !!why && why.getBoundingClientRect().height > 0 && getComputedStyle(why).position !== "absolute" && !why.classList.contains("sr-only");
    const wrapper = b.parentElement;
    return {
      text: b.textContent.trim(),
      disabled: b.disabled,
      ariaDisabled: b.getAttribute("aria-disabled"),
      redText: cs.color === errorColor,
      opacity: Number(cs.opacity),
      whyVisible,
      why: why?.textContent?.trim() ?? null,
      describedBy: b.getAttribute("aria-describedby"),
      cursor: getComputedStyle(wrapper).cursor,
    };
  });
}
async function lockedChecks(page, label, jobId, names, reasonRe) {
  for (const n of names) {
    const st = await removeState(page, n);
    check(`${label}: “${n}” Remove is natively disabled (click + keyboard blocked)`, st.disabled === true, st);
    check(`${label}: “${n}” looks disabled — neutral “Locked”, not the red destructive style`, !st.redText && /Locked/.test(st.text) && st.ariaDisabled === "true", st);
    check(`${label}: “${n}” shows its reason next to the button`, st.whyVisible && !!st.describedBy, st);
    check(`${label}: “${n}” not-allowed cursor`, st.cursor === "not-allowed", st.cursor);
  }
  const note = (await page.locator("[data-testid=files-remove-blocked]").textContent().catch(() => "")) ?? "";
  check(`${label}: the page explains why removal is unavailable`, reasonRe.test(note), note);
  // A forced click and keyboard activation must not open the confirmation.
  const btn = row(page, names[0]).locator("[data-testid=file-remove]");
  await btn.click({ force: true, timeout: 3000 }).catch(() => {});
  await btn.focus().catch(() => {});
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);
  check(`${label}: forced click / Enter / Space open nothing`, (await page.locator("[data-testid=remove-file-dialog]").count()) === 0);
  const focusable = await btn.evaluate((b) => { b.focus(); return document.activeElement === b; });
  check(`${label}: the locked button cannot take keyboard focus`, !focusable);
  check(`${label}: no file was removed`, (await fileCount(jobId)) === names.length);
}

const page = await newPage();
await login(page);

section("1. Uploading — files removable, unfinished upload separate");
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.draft}`);
for (const n of ["digital-clean.pdf", "key.csv"]) {
  const st = await removeState(page, n);
  check(`uploading: “${n}” Remove enabled and red (destructive)`, !st.disabled && st.redText && st.text === "Remove", st);
}
check("uploading: unfinished upload offers “Remove upload”", /Remove upload/.test((await row(page, "half-uploaded.pdf").locator("[data-testid=file-remove]").textContent()) ?? ""));
check("uploading: no blanket “removal unavailable” note", (await page.locator("[data-testid=files-remove-blocked]").count()) === 0);
await row(page, "key.csv").locator("[data-testid=file-remove]").click();
const dlg = page.locator("[data-testid=remove-file-dialog]");
await dlg.waitFor({ timeout: 5000 }).catch(() => {});
check("confirmation names the exact file and its type", (await dlg.locator("[data-testid=remove-file-name]").textContent().catch(() => "")) === "key.csv" && /Answer key/.test((await dlg.locator("[data-testid=remove-file-type]").textContent().catch(() => "")) ?? ""));
await dlg.getByRole("button", { name: "Keep file" }).click().catch(() => {});
check("“Keep file” removes nothing", (await fileCount(S.draft)) === 3);
await row(page, "key.csv").locator("[data-testid=file-remove]").focus();
await page.keyboard.press("Enter");
await dlg.waitFor({ timeout: 5000 }).catch(() => {});
check("keyboard Enter on an enabled Remove opens the confirmation", (await dlg.count()) === 1);
await dlg.locator("[data-testid=remove-file-confirm]").click().catch(() => {});
await page.locator("[data-testid=job-notice]").waitFor({ timeout: 15000 }).catch(() => {});
check("removal confirmed: only key.csv removed; paper + unfinished upload kept", (await fileCount(S.draft)) === 2 && (await db.query(`select count(*)::int n from "AiImportFile" where "jobId"=$1 and "originalName"='key.csv'`, [S.draft])).rows[0].n === 0);
check("totals updated: 1 question paper · 0 answer keys", await until(async () => /1 question paper · 0 answer keys/.test((await page.locator("[data-testid=files-totals]").textContent()) ?? "")));
const ev = (await db.query(`select count(*)::int n from "AiImportEvent" where "jobId"=$1 and type='FILE_REMOVED'`, [S.draft])).rows[0].n;
const au = (await db.query(`select count(*)::int n from "AuditLog" where "entityId"=$1 and action='AI_IMPORT_FILE_REMOVED'`, [S.draft])).rows[0].n;
check("activity log + admin audit log recorded the removal", ev === 1 && au === 1, { ev, au });

section("2. Uploading — paper with a linked answer key");
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.linked}`);
const lp = await removeState(page, "scanned.pdf");
check("paper with a linked key: locked, reason “Remove its answer key first” visible", lp.disabled && !lp.redText && lp.whyVisible && /answer key/.test(lp.why ?? ""), lp);
const lk = await removeState(page, "scanned-key.png");
check("its answer key: Remove enabled", !lk.disabled && lk.redText, lk);

section("3. Awaiting confirmation — removable; the analysis is cleared");
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.awaiting}`);
check("awaiting: both files removable", !(await removeState(page, "digital-clean.pdf")).disabled && !(await removeState(page, "key-digital.pdf")).disabled);
await row(page, "key-digital.pdf").locator("[data-testid=file-remove]").click();
await dlg.waitFor({ timeout: 5000 }).catch(() => {});
check("awaiting: confirmation warns that the analysis and estimate are cleared", /analysis report and cost estimate are cleared/.test((await dlg.textContent().catch(() => "")) ?? ""));
await dlg.locator("[data-testid=remove-file-confirm]").click().catch(() => {});
await page.locator("[data-testid=job-notice]").waitFor({ timeout: 15000 }).catch(() => {});
const aw = (await db.query(`select status, analysis is null as a, estimate is null as e from "AiImportJob" where id=$1`, [S.awaiting])).rows[0];
check("awaiting: job back to Uploading, analysis + estimate cleared (fresh analysis required)", aw.status === "DRAFT" && aw.a && aw.e, aw);
check("awaiting: page shows Uploading and offers Analyze again", await until(async () => /Uploading/.test((await page.locator("[data-testid=job-status]").textContent()) ?? "") && (await page.locator("[data-testid=analyze]").count()) === 1));
check("awaiting: no Confirm button until re-analysis", (await page.locator("[data-testid=confirm-start]").count()) === 0);

section("4. Processing / Ready to import / Cancelled — locked, with the reason");
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.processing}`);
await lockedChecks(page, "processing", S.processing, ["formula.pdf"], /Processing has started \(processing\)/);
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.ready}`);
await lockedChecks(page, "ready to import", S.ready, ["digital-clean.pdf", "key-digital.pdf"], /Processing has started \(ready to import\)/);
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.cancelled}`);
await lockedChecks(page, "cancelled", S.cancelled, ["photo.png"], /cancelled/);

section("5. The server refuses independently (raw Server Action calls)");
const manifest = JSON.parse(readFileSync(path.join(APP, ".next/server/server-reference-manifest.json"), "utf8"));
const actionId = Object.entries(manifest.node).find(([, v]) => JSON.stringify(v).includes("removeFileAction"))?.[0];
check("removeFileAction id found in the build manifest", !!actionId);
for (const [label, jobId] of [["processing", S.processing], ["ready to import", S.ready], ["cancelled", S.cancelled]]) {
  const fid = (await db.query(`select id from "AiImportFile" where "jobId"=$1 limit 1`, [jobId])).rows[0].id;
  const r = await inPage(page, `/admin/ai-importer/jobs/${jobId}`, { method: "POST", headers: { "Next-Action": actionId, Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([jobId, fid]) });
  check(`Master Admin raw call on a ${label} job: refused with the reason`, /Processing has started|cancelled/.test(r.text) && /"ok":false/.test(r.text), { status: r.status, text: r.text.slice(-200) });
  check(`…${label} file still there`, (await db.query(`select count(*)::int n from "AiImportFile" where id=$1`, [fid])).rows[0].n === 1);
}
const anon = await newPage();
await anon.goto(`${BASE}/admin/login`);
const fidR = (await db.query(`select id from "AiImportFile" where "jobId"=$1 limit 1`, [S.draft])).rows[0].id;
const ra = await inPage(anon, `/admin/ai-importer/jobs/${S.draft}`, { method: "POST", headers: { "Next-Action": actionId, Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([S.draft, fidR]) });
check("signed-out raw call: refused (redirect to login / no permission)", ra.type === "opaqueredirect" || [303, 307, 308, 401, 403].includes(ra.status) || /do not have permission/.test(ra.text), { status: ra.status, type: ra.type, text: ra.text.slice(0, 120) });
check("…file still there", (await db.query(`select count(*)::int n from "AiImportFile" where id=$1`, [fidR])).rows[0].n === 1);

section("6. A stored file shared with another job");
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.sharedB}`);
check("shared: job B says its file is identical to job A's upload (stored once)", /Identical to/.test((await row(page, "paper.docx").textContent()) ?? ""));
await page.goto(`${BASE}/admin/ai-importer/jobs/${S.sharedA}`);
await row(page, "paper.docx").locator("[data-testid=file-remove]").click();
await dlg.waitFor({ timeout: 5000 }).catch(() => {});
await dlg.locator("[data-testid=remove-file-confirm]").click().catch(() => {});
await page.locator("[data-testid=job-notice]").waitFor({ timeout: 15000 }).catch(() => {});
const sb = (await db.query(`select "storageKey" from "AiImportFile" where "jobId"=$1`, [S.sharedB])).rows;
const sharedEv = (await db.query(`select data from "AiImportEvent" where "jobId"=$1 and type='FILE_REMOVED'`, [S.sharedA])).rows[0]?.data;
check("shared: removed from job A only; job B keeps its file; stored copy kept", (await fileCount(S.sharedA)) === 0 && sb.length === 1 && sharedEv?.storedFileDeleted === false && sharedEv?.sharedWith === 1, { a: await fileCount(S.sharedA), b: sb.length, sharedEv });

section("7. Mobile (375 px)");
const m = await newPage(true);
await login(m);
await m.goto(`${BASE}/admin/ai-importer/jobs/${S.ready}`);
const mst = await removeState(m, "digital-clean.pdf");
check("mobile ready-to-import: locked button + visible reason", mst.disabled && /Locked/.test(mst.text) && mst.whyVisible, mst);
check("mobile: no horizontal page scroll", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await m.goto(`${BASE}/admin/ai-importer/jobs/${S.linked}`);
check("mobile uploading: Remove usable on the answer key", !(await removeState(m, "scanned-key.png")).disabled);
check("mobile: no horizontal page scroll (uploading)", await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

check("no page errors", errors.length === 0, errors);
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
