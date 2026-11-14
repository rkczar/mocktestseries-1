/**
 * Phase 10 — distraction-free / full-screen CBT mode, real browser (Chromium desktop + Pixel 7 + iPhone 14 emulation)
 * against a LOCAL production build on a DISPOSABLE database. Fixture: scripts/test-engine-ui-fixture.ts setup.
 *
 *   BASE=http://127.0.0.1:3671 FIXTURE=<engine-fixture.json> DATABASE_URL=<scratch> SHOTS=<dir> NODE_PATH=<playwright dir> \
 *     node scripts/verify-exam-fullscreen-ui.mjs
 *
 * Proves: Start Test enters fullscreen; minimal toolbar; Esc / exit keeps the attempt, question and timer; re-entry;
 * Leave dialog (exact copy) — Continue keeps state, Yes saves and leaves WITHOUT submitting; Back opens the dialog and
 * never traps (2nd Back passes); tab close/reload warns (beforeunload); resume = same attempt + same question + no timer
 * reset; denied / unsupported fullscreen (iPhone) keeps a usable test; offline answer is saved after reconnect; links in
 * question content open a new tab; theme + text size; keyboard (Enter/Esc) in the dialog; normal submit; one attempt.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:3671";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS || "";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("Local disposable server only.");
  process.exit(2);
}
const db = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? "").replace(/\?schema=[^&]*/, "") });
await db.connect();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
const secs = (t) => {
  const m = /(\d+):(\d+)/.exec(t ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const attemptRow = async (id) => (await db.query(`select status, "studentId", "mockTestId", "previousYearPaperId" from "TestAttempt" where id=$1`, [id])).rows[0];

async function ctxFor(browser, device, init) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: "student-session-token", value: F.token, url: BASE }]);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  return { ctx, page };
}
const inFs = (page) => page.evaluate(() => Boolean(document.fullscreenElement));
async function startFromInstructions(page, attemptId) {
  await page.goto(`${BASE}/student/attempt/${attemptId}`);
  await page.getByTestId("start-test-link").click();
  await page.waitForSelector("[data-testid=test-player]", { timeout: 30000 });
  // Bilingual fixtures ask for a language first.
  const gate = page.getByTestId("language-gate");
  if (await gate.count()) await gate.getByRole("button").first().click();
}
const option = (page, n = 0) => page.locator("[data-testid=option]").nth(n);
async function settled(page) {
  await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 20000 });
}

const browser = await chromium.launch();
try {
  const attemptId = F.mockAttemptId;
  const countBefore = (await db.query(`select count(*)::int n from "TestAttempt" where "studentId"=$1`, [(await attemptRow(attemptId)).studentId])).rows[0].n;

  // ---------------------------------------------------------------- desktop: entry + toolbar
  console.log("Desktop Chrome");
  const { ctx, page } = await ctxFor(browser);
  await startFromInstructions(page, attemptId);
  check("D1 Start Test → browser fullscreen on", await inFs(page));
  check("D2 player marks fullscreen", (await page.getAttribute("[data-testid=test-player]", "data-fullscreen")) === "on");
  const header = page.locator("header").first();
  check("D3 toolbar: brand, timer, Leave Full Screen", (await header.innerText()).includes("MockTestSeries") && (await page.getByTestId("timer").count()) === 1 && (await page.getByTestId("leave-exam").innerText()).includes("Leave Full Screen"));
  check("D4 no site header/footer/dashboard nav links in the player", (await page.locator("a[href='/student/dashboard'], a[href='/'], footer").count()) === 0);
  await shot(page, "01-desktop-fullscreen");

  // answer Q1, move to Q3, remember timer
  await option(page, 0).click();
  await settled(page);
  await page.getByRole("button", { name: /Save & Next/ }).click();
  await page.getByRole("button", { name: /Save & Next/ }).click();
  const qBefore = Number(await page.getAttribute("[data-testid=test-player]", "data-question-index"));
  const t1 = secs(await page.getByTestId("timer").innerText());

  // ---------------------------------------------------------------- Esc / exit
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForSelector("[data-testid=fullscreen-notice]");
  check("E1 exit fullscreen (Esc) → notice, exam continues", !(await inFs(page)) && page.url().endsWith("/run"));
  check("E2 same question after exit", Number(await page.getAttribute("[data-testid=test-player]", "data-question-index")) === qBefore);
  const t2 = secs(await page.getByTestId("timer").innerText());
  check("E3 timer not reset (keeps counting down)", t1 !== null && t2 !== null && t2 <= t1 && t1 - t2 < 15, { t1, t2 });
  check("E4 toolbar button reads Leave Exam when not fullscreen", (await page.getByTestId("leave-exam").innerText()).includes("Leave Exam"));
  await shot(page, "02-desktop-fullscreen-off-notice");
  await page.getByTestId("enter-fullscreen").click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  check("E5 Enter full screen (click) → fullscreen again, notice gone", (await inFs(page)) && (await page.getByTestId("fullscreen-notice").count()) === 0);

  // ---------------------------------------------------------------- theme + text size
  const theme0 = await page.evaluate(() => document.documentElement.dataset.theme);
  await header.getByRole("button", { name: /Mode\. Switch to/ }).first().click();
  const theme1 = await page.evaluate(() => document.documentElement.dataset.theme);
  check("T1 theme switch works in exam mode", theme0 !== theme1, { theme0, theme1 });
  const size0 = await page.evaluate(() => document.documentElement.dataset.textSize);
  await header.getByRole("button", { name: /^Text size:/ }).first().click();
  const items = page.getByRole("menuitem");
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const label = await items.nth(i).innerText();
    if (!label.toLowerCase().includes(String(size0 ?? "").toLowerCase()) || i === n - 1) {
      await items.nth(i === 0 ? n - 1 : i).click();
      break;
    }
  }
  const size1 = await page.evaluate(() => document.documentElement.dataset.textSize);
  check("T2 text size control works in exam mode", size0 !== size1, { size0, size1 });

  // ---------------------------------------------------------------- Leave dialog: Continue
  await page.getByTestId("leave-exam").click();
  const dialog = page.getByTestId("leave-dialog");
  await dialog.waitFor();
  const dtext = await dialog.innerText();
  check("L1 exact confirmation copy", dtext.includes("Are you sure you want to leave the exam?") && dtext.includes("Leaving the exam may end your current test session. Your saved answers, remaining time and submission status will be handled according to the exam rules.") && dtext.includes("No, Continue Exam") && dtext.includes("Yes, Leave Exam"));
  check("L2 'No, Continue Exam' has focus (keyboard safe default)", await page.getByTestId("leave-continue").evaluate((el) => el === document.activeElement));
  await shot(page, "03-leave-dialog");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" }).catch(() => {});
  check("L3 Esc closes the dialog, still in the exam on the same question", page.url().endsWith("/run") && Number(await page.getAttribute("[data-testid=test-player]", "data-question-index")) === qBefore);
  await page.getByTestId("leave-exam").focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await page.getByTestId("leave-continue").click();
  check("L4 Continue keeps the exam (no submit)", page.url().endsWith("/run") && (await attemptRow(attemptId)).status === "IN_PROGRESS");

  // ---------------------------------------------------------------- Back protection (no trap)
  await page.goBack();
  await dialog.waitFor({ timeout: 5000 }).catch(() => {});
  check("B1 browser Back → Leave dialog, still on the exam", (await dialog.count()) === 1 && page.url().endsWith("/run"));
  await page.getByTestId("leave-continue").click();
  await page.goBack();
  await dialog.waitFor({ timeout: 5000 }).catch(() => {});
  check("B2 Back again after Continue → dialog again (guard re-armed once)", (await dialog.count()) === 1);
  await page.goBack();
  await page.goBack();
  await page.waitForURL((u) => !u.pathname.endsWith("/run"), { timeout: 15000 }).catch(() => {});
  check("B3 Back while the dialog is open passes through (no history trap)", !page.url().endsWith("/run"), page.url());
  check("B4 leaving by Back never submits", (await attemptRow(attemptId)).status === "IN_PROGRESS");

  // ---------------------------------------------------------------- resume
  await page.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await page.waitForSelector("[data-testid=test-player]");
  await page.waitForTimeout(500);
  check("R1 resume → same question", Number(await page.getAttribute("[data-testid=test-player]", "data-question-index")) === qBefore, await page.getAttribute("[data-testid=test-player]", "data-question-index"));
  const t3 = secs(await page.getByTestId("timer").innerText());
  check("R2 resume → server time, not reset", t3 !== null && t1 !== null && t3 <= t1, { t1, t3 });
  check("R3 resume (no click) → fullscreen off + offer to re-enter", (await page.getByTestId("enter-fullscreen").count()) === 1);
  for (let i = 0; i < 5 && Number(await page.getAttribute("[data-testid=test-player]", "data-question-index")) > 0; i++) {
    await page.getByRole("navigation", { name: "Question navigation" }).getByRole("button").first().click();
  }
  check("R4 answer from before is still selected on question 1", await option(page, 0).locator("input").isChecked().catch(() => false), await page.getAttribute("[data-testid=test-player]", "data-question-index"));

  // ---------------------------------------------------------------- links inside question content open a new tab
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/student/dashboard";
    a.textContent = "content link";
    a.id = "qlink";
    document.querySelector("[data-testid=test-player] main, [data-testid=test-player]")?.appendChild(a);
  });
  const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null), page.click("#qlink")]);
  check("K1 link in question content opens a new tab, exam stays", Boolean(popup) && page.url().endsWith("/run"));
  if (popup) await popup.close();

  // ---------------------------------------------------------------- offline answer → saved after reconnect
  await ctx.setOffline(true);
  await option(page, 1).click();
  await page.waitForTimeout(1500);
  await ctx.setOffline(false);
  await settled(page);
  check("O1 offline answer saved after reconnect", (await page.locator("[data-testid=save-status]").innerText().catch(() => "")) === "");

  // ---------------------------------------------------------------- tab close / reload warning
  let beforeUnload = false;
  page.on("dialog", async (d) => {
    if (d.type() === "beforeunload") beforeUnload = true;
    await d.dismiss().catch(() => {});
  });
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 1500));
  check("U1 closing/reloading an active exam → browser leave warning", beforeUnload);

  // ---------------------------------------------------------------- Leave → Yes: saves, leaves, does not submit
  const p2 = await ctx.newPage();
  p2.errors = [];
  p2.on("pageerror", (e) => p2.errors.push(e.message));
  await p2.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await p2.waitForSelector("[data-testid=test-player]");
  await p2.getByTestId("leave-exam").click();
  await p2.getByTestId("leave-confirm").click();
  await p2.waitForURL(/\/student\/dashboard/, { timeout: 20000 });
  check("Y1 Yes, Leave Exam → dashboard", p2.url().includes("/student/dashboard"));
  check("Y2 attempt still IN_PROGRESS (leaving never submits)", (await attemptRow(attemptId)).status === "IN_PROGRESS");
  const saved = (await db.query(`select count(*)::int n from "Answer" where "attemptId"=$1 and ("selectedOption" is not null or "selectedLabels" is not null)`, [attemptId]).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
  check("Y3 answers persisted on the server", saved !== 0, saved);

  // ---------------------------------------------------------------- normal submit still works
  await p2.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await p2.waitForSelector("[data-testid=test-player]");
  let warnedOnSubmit = false;
  p2.on("dialog", async (d) => {
    if (d.type() === "beforeunload") warnedOnSubmit = true;
    await d.accept().catch(() => {});
  });
  await p2.getByRole("button", { name: "Submit Test" }).first().click();
  await p2.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await p2.waitForURL(/\/result/, { timeout: 30000 });
  check("S1 normal submit → result page", p2.url().includes("/result"));
  check("S2 no leave warning on a real submit", !warnedOnSubmit);
  check("S3 attempt SUBMITTED", (await attemptRow(attemptId)).status === "SUBMITTED");
  const countAfter = (await db.query(`select count(*)::int n from "TestAttempt" where "studentId"=$1`, [(await attemptRow(attemptId)).studentId])).rows[0].n;
  check("S4 no extra attempt created by exits/resumes", countAfter === countBefore, { countBefore, countAfter });
  check("S5 no page errors (desktop)", page.errors.length + p2.errors.length === 0, [...page.errors, ...p2.errors].slice(0, 3));
  await ctx.close();

  // ---------------------------------------------------------------- fullscreen denied (desktop)
  console.log("Fullscreen denied");
  const denied = await ctxFor(browser, null, () => {
    Element.prototype.requestFullscreen = function () {
      return Promise.reject(new Error("denied"));
    };
  });
  await startFromInstructions(denied.page, F.pyqAttemptId);
  check("N1 denied → test still opens, notice shown", (await denied.page.getByTestId("fullscreen-notice").count()) === 1 && (await denied.page.getByTestId("timer").count()) === 1);
  await denied.page.getByTestId("enter-fullscreen").click();
  await denied.page.waitForTimeout(300);
  check("N2 re-try denied → explains, no Enter button loop", (await denied.page.getByTestId("fullscreen-notice").innerText()).includes("isn't available") && (await denied.page.getByTestId("enter-fullscreen").count()) === 0);
  await option(denied.page, 0).click();
  await settled(denied.page);
  check("N3 answering works without fullscreen (answer saved)", (await denied.page.locator("[data-testid=save-status]").innerText().catch(() => "x")) === "");
  await shot(denied.page, "04-fullscreen-denied");
  await denied.ctx.close();

  // ---------------------------------------------------------------- Android Chrome (Pixel 7)
  console.log("Android Chrome (Pixel 7 emulation)");
  const android = await ctxFor(browser, "Pixel 7");
  await startFromInstructions(android.page, F.subjectAttemptId);
  check("A1 Android: Start Test → fullscreen", await inFs(android.page));
  check("A2 Android: Leave control present (icon on small screens)", (await android.page.getByTestId("leave-exam").count()) === 1);
  await android.page.goBack();
  check("A3 Android Back → Leave dialog", (await android.page.getByTestId("leave-dialog").count()) === 1);
  await shot(android.page, "05-android-back-dialog");
  await android.ctx.close();

  // ---------------------------------------------------------------- iPhone Safari fallback (no element fullscreen)
  console.log("iPhone Safari fallback (emulated: requestFullscreen absent)");
  const iphone = await ctxFor(browser, "iPhone 14", () => {
    delete Element.prototype.requestFullscreen;
    delete Element.prototype.webkitRequestFullscreen;
    Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false });
  });
  await startFromInstructions(iphone.page, F.pyqAttemptId);
  check("I1 iPhone: test opens in the protected layout", (await iphone.page.getByTestId("timer").count()) === 1);
  check("I2 iPhone: honest notice, no Enter button", (await iphone.page.getByTestId("fullscreen-notice").innerText()).includes("isn't available") && (await iphone.page.getByTestId("enter-fullscreen").count()) === 0);
  await shot(iphone.page, "06-iphone-fallback");
  await iphone.ctx.close();
} finally {
  await browser.close();
  await db.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
