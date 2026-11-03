/**
 * Phase 1 question safety — browser checks against a local production build on
 * a DISPOSABLE database (fixture: scripts/question-safety-ui-fixture.ts).
 *
 *   BASE=http://localhost:3621 FIXTURE=fx.json DATABASE_URL=<scratch> SHOTS=<dir> \
 *     NODE_PATH=<dir containing playwright> node scripts/verify-question-safety-ui.mjs
 *
 * A student keeps a test open while the Master Admin replaces one of its
 * questions in the admin UI (dependencies → preview → one confirmation). The
 * student's next save lands on "This attempt was reset", a fresh start serves
 * the corrected question at the same position, and another student's old
 * result is gone from History. Also: paper dependency page + CSV, history,
 * retired badge, and no sideways scroll at 360 px.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3621";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? "qsui-shots";
mkdirSync(SHOTS, { recursive: true });
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const sql = (q) => execFileSync("psql", [process.env.DATABASE_URL.replace(/\?schema=public$/, ""), "-Atc", q], { encoding: "utf8" }).trim();

async function studentLogin(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
}
async function adminLogin(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", F.adminUsername);
  await page.fill("input[name=password]", F.password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const noSidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const option = (page, label) => page.locator(`[data-testid=option][data-label="${label}"]`);

async function main() {
  const browser = await chromium.launch();
  try {
    // ---- the open session (student A)
    const sCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const s = await sCtx.newPage();
    await studentLogin(s, F.emailA);
    await s.goto(`${BASE}/student/attempt/${F.openAttemptId}/run`);
    await s.waitForSelector("[data-testid=test-player]");
    await option(s, "A").click();
    await s.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
    check("open session: first answer saved", sql(`select "selectedOptionLabel" from "Answer" where "attemptId"='${F.openAttemptId}' and "selectedOptionLabel" is not null`).includes("A"));
    await s.getByRole("button", { name: "Go to question 4" }).click();
    check("open session: position 4 shows the OLD paper question 3", /QSUI paper question 3 \(OLD\)/.test(await s.locator("[data-testid=test-player]").innerText()));
    await s.getByRole("button", { name: "Go to question 1" }).click();

    // ---- admin: dependencies, preview, one confirmation
    const aCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const a = await aCtx.newPage();
    await adminLogin(a);
    await a.goto(`${BASE}/admin/exams/previous-year-papers/${F.paperId}/dependencies`);
    const depText = await a.locator("body").innerText();
    // Positions sit inside a collapsed <details>: open it the way an admin would.
    await a.locator("tr", { hasText: F.oldQ3.code }).locator("summary").click();
    const usesText = await a.locator("tr", { hasText: F.oldQ3.code }).innerText();
    check("dependencies page lists the paper's questions with their test position", depText.includes(F.oldQ3.code) && /Grand Test[^\n]*Q4/.test(usesText), usesText);
    const csv = await a.evaluate(async (u) => {
      const r = await fetch(u);
      return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
    }, `${BASE}/api/admin/questions/dependencies?paperId=${F.paperId}`);
    check("CSV export: 200 text/csv with the question code", csv.status === 200 && /text\/csv/.test(csv.type ?? "") && csv.body.includes(F.oldQ3.code), csv.status);
    await a.screenshot({ path: `${SHOTS}/dependencies.png`, fullPage: true });

    await a.goto(`${BASE}/admin/questions/${F.oldQ3.id}/replace`);
    check("replace page shows the Grand Test use at position Q4", /Grand Test/.test(await a.locator("body").innerText()) && /Q4/.test(await a.locator("body").innerText()));
    await a.fill("#replacement-ref", F.corrected.code);
    await a.fill("#replacement-reason", "Wrong answer key (UI fixture)");
    await a.getByRole("button", { name: "Preview changes" }).click();
    await a.waitForSelector("[data-testid=replacement-preview]");
    const prev = await a.locator("[data-testid=replacement-preview]").innerText();
    check("preview: replaced in place at Q4, 2 attempts reset", /Replaced in place/.test(prev) && /Attempts reset:\s*2/.test(prev), prev.slice(0, 400));
    await a.screenshot({ path: `${SHOTS}/preview.png`, fullPage: true });
    const applyBtn = a.getByRole("button", { name: "Replace question" });
    check("apply stays disabled until the code is typed", await applyBtn.isDisabled());
    await a.fill("#confirm-code", F.oldQ3.code);
    await applyBtn.click();
    await a.getByText(/Done\. 2 attempt\(s\) were reset/).waitFor({ timeout: 30000 });
    check("apply: done message", true);
    check("DB: old Q3 retired, corrected published", sql(`select (select "retiredAt" is not null from "Question" where id='${F.oldQ3.id}')::text || (select status from "Question" where id='${F.corrected.id}')`) === "truePUBLISHED");

    // ---- student A's open tab: next save → reset notice
    await option(s, "B").click();
    await s.waitForURL((u) => u.pathname === `/student/attempt/${F.openAttemptId}`, { timeout: 30000 });
    check("open session: the next save lands on the reset notice", await s.getByText("This attempt was reset").isVisible());
    check("open session: unsent answers cleared from this tab", (await s.evaluate((id) => sessionStorage.getItem(`mts-pending-answers:${id}`), F.openAttemptId)) === null);
    check("DB: the open attempt is ABANDONED (invalidated), never graded", sql(`select status || ':' || ("invalidatedAt" is not null) || ':' || coalesce(score::text,'null') from "TestAttempt" where id='${F.openAttemptId}'`) === "ABANDONED:true:null");
    await s.goto(`${BASE}/student/attempt/${F.openAttemptId}/run`);
    check("refresh / resume of the old attempt shows the reset notice again", await s.getByText("This attempt was reset").isVisible());
    await s.screenshot({ path: `${SHOTS}/reset-notice.png` });
    // Fresh start → corrected question at the same position.
    await s.goto(`${BASE}/student/attempt/resume?mockTest=${F.mockId}`);
    await s.getByRole("button", { name: /Start Test/ }).click();
    await s.waitForSelector("[data-testid=test-player]");
    check("fresh attempt is a new attempt", !s.url().includes(F.openAttemptId));
    await s.getByRole("button", { name: "Go to question 4" }).click();
    const q4 = await s.locator("[data-testid=test-player]").innerText();
    check("fresh attempt: position 4 is the CORRECTED question; the old one is nowhere", /\(CORRECTED\)/.test(q4) && !/\(OLD\)[^]*question 3|question 3 \(OLD\)/.test(q4));
    const html = await s.evaluate(async () => (await fetch(location.href)).text());
    check("fresh attempt payload carries no old Q3 text", !html.includes("QSUI paper question 3 (OLD)"));

    // ---- student B: the old result is gone
    const bCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const b = await bCtx.newPage();
    await studentLogin(b, F.emailB);
    await b.goto(`${BASE}/student/history`);
    check("History no longer lists the invalidated attempt", !(await b.locator(`a[href*="${F.doneAttemptId}"]`).count()));
    await b.goto(`${BASE}/student/attempt/${F.doneAttemptId}/result`);
    check("old result link shows the reset notice, not a score", await b.getByText("This attempt was reset").isVisible());

    // ---- admin views after the change
    await a.goto(`${BASE}/admin/questions/replacements`);
    check("replacement history lists the change with its rollback", /Replaced/.test(await a.locator("body").innerText()) && (await a.getByRole("button", { name: "Roll back" }).count()) >= 1);
    await a.goto(`${BASE}/admin/exams/previous-year-papers/${F.paperId}`);
    const paperText = await a.locator("body").innerText();
    check("paper page: RETIRED badge, paper numbers, Retire / Replace links", /RETIRED/.test(paperText) && (await a.getByRole("link", { name: "Retire / Replace" }).count()) >= 1);
    await a.goto(`${BASE}/admin/questions/${F.oldQ3.id}/replace`);
    check("retired question page is read-only (no Retire / Replace panel)", /Retired questions are read-only/.test(await a.locator("body").innerText()) && !(await a.getByRole("button", { name: "Preview changes" }).count()));

    // ---- 360 px
    const mCtx = await browser.newContext({ viewport: { width: 360, height: 780 }, storageState: await aCtx.storageState() });
    const m = await mCtx.newPage();
    for (const path of [`/admin/exams/previous-year-papers/${F.paperId}/dependencies`, `/admin/questions/${F.corrected.id}/replace`, `/admin/questions/replacements`]) {
      await m.goto(`${BASE}${path}`);
      check(`360 px: no sideways page scroll on ${path.split("/").slice(2, 4).join("/")}`, await noSidewaysScroll(m));
    }
    await m.screenshot({ path: `${SHOTS}/history-360.png`, fullPage: true });
  } finally {
    await browser.close();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
