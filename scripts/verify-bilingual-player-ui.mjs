/**
 * Bilingual Test Player — real browser (Chromium, desktop + phone) against a LOCAL production build on a DISPOSABLE
 * database (fixture: scripts/bilingual-player-ui-fixture.ts). Checks that the English / हिंदी switch changes only the
 * text shown: never the selected answer, timer, position, mark-for-review state or the attempt; that the choice is asked
 * before the test; that review shows both languages; and that English-only exams show no language controls.
 *
 *   BASE=http://localhost:3561 FIXTURE=fx.json DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-bilingual-player-ui.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");
const BASE = process.env.BASE || "http://localhost:3561";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Runs only against a local server on a scratch mts_* database.");
  process.exit(2);
}

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
const answers = (attemptId) => JSON.parse(execFileSync("npx", ["tsx", "scripts/bilingual-player-ui-fixture.ts", "answers", attemptId], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }).trim().split("\n").pop());

async function newPage(browser, token, mobile = false) {
  const ctx = await browser.newContext(mobile ? { ...devices["Pixel 7"] } : { viewport: { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: "student-session-token", value: token, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  return page;
}
const qText = (page) => page.locator("[data-testid=test-player] p.text-question").innerText();
const option = (page, l) => page.locator(`[data-testid=option][data-label="${l}"]`);
const picked = (page, l) => option(page, l).locator("input").isChecked();
const position = async (page) => Number(await page.getAttribute("[data-testid=test-player]", "data-question-index"));
async function timerSeconds(page) {
  const m = /(\d+):(\d+)/.exec(await page.locator("[data-testid=timer]").innerText());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
async function settled(page) {
  await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
}

const browser = await chromium.launch();
try {
  console.log("\n--- English-only exam: no language controls ---");
  {
    const page = await newPage(browser, F.enToken);
    await page.goto(`${BASE}/student/attempt/${F.enAttemptId}/run`);
    await page.waitForSelector("[data-testid=test-player]");
    check("no language switch", (await page.locator("[data-testid=language-switch]").count()) === 0);
    check("no language chooser", (await page.locator("[data-testid=language-gate]").count()) === 0);
    check("English text shown as before", /English-only question 1/.test(await qText(page)));
    check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
    await page.context().close();
  }

  console.log("\n--- Bilingual attempt: choose, switch, state preserved ---");
  {
    const page = await newPage(browser, F.token);
    await page.goto(`${BASE}/student/attempt/${F.attemptId}/run`);
    await page.waitForSelector("[data-testid=test-player]");
    check("first open asks for the language (nothing stored yet)", await page.locator("[data-testid=language-gate]").isVisible());
    await page.locator("[data-testid=choose-lang-hi]").click();
    check("chooser closes after a choice", (await page.locator("[data-testid=language-gate]").count()) === 0);
    check("Hindi question shown", /जैल का उदाहरण है/.test(await qText(page)), await qText(page));
    check("Hindi options shown", /कोहरा/.test(await option(page, "B").innerText()));
    await page.evaluate(() => (window.__noReload = 1));
    await option(page, "B").click();
    await settled(page);
    const t0 = await timerSeconds(page);
    await page.locator("[data-testid=lang-en]").click();
    check("instant switch to English (same question)", /Example of Gel is/.test(await qText(page)) && (await position(page)) === 0);
    check("selected option kept (B) after switching", await picked(page, "B"));
    check("English options shown", /Fog/.test(await option(page, "B").innerText()));
    check("no page reload on switch", (await page.evaluate(() => window.__noReload)) === 1);
    const t1 = await timerSeconds(page);
    check("timer continues (not reset)", t0 !== null && t1 !== null && t1 <= t0 && t0 - t1 < 30, [t0, t1]);
    await page.getByRole("button", { name: /Mark for Review & Next/ }).first().click();
    // settled() can return before the save starts, so wait for the move itself.
    await page.waitForFunction(() => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === "1", null, { timeout: 15000 }).catch(() => {});
    await settled(page);
    check("Mark for Review & Next → question 2", (await position(page)) === 1);
    await page.locator("[data-testid=lang-hi]").click();
    const q2 = await page.locator("[data-testid=test-player] p.text-question").innerHTML();
    check("Hindi formula question rendered with KaTeX", /katex/.test(q2) && /बराबर होगा/.test(q2), q2.slice(0, 200));
    await option(page, "D").click();
    await settled(page);
    await page.locator("[data-testid=lang-en]").click();
    check("Q2 selection kept across switch (D)", await picked(page, "D"));
    await page.getByRole("button", { name: /Previous/ }).first().click();
    check("back on Q1: still B", (await position(page)) === 0 && (await picked(page, "B")));
    const a = answers(F.attemptId);
    check("exactly one Answer row per question; Q1=B marked for review, Q2=D", a.every((r) => r.answers <= 1) && a[0].label === "B" && a[0].status === "ANSWERED_AND_MARKED" && a[1].label === "D", a);
    await page.reload();
    await page.waitForSelector("[data-testid=test-player]");
    check("after reload: no chooser (choice remembered), English kept", (await page.locator("[data-testid=language-gate]").count()) === 0 && /Example of Gel is/.test(await qText(page)));
    check("after reload: answer restored from the server", await picked(page, "B"));
    check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
    // Submit, then review in both languages.
    await settled(page);
    await page.getByRole("button", { name: "Submit Test" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
    await page.waitForURL(/\/result$/, { timeout: 20000 });
    await page.goto(`${BASE}/student/attempt/${F.attemptId}/review`);
    await page.waitForSelector("[data-testid=language-switch]");
    const reviewText = () => page.locator("main").innerText();
    check("review opens in the remembered language (English)", /Example of Gel is/.test(await reviewText()));
    await page.locator("[data-testid=lang-hi]").click();
    check("review switches to Hindi", /जैल का उदाहरण है/.test(await reviewText()) && /कोहरा/.test(await reviewText()));
    check("review keeps the result (correct answer marked) in Hindi", /Correct|सही/i.test(await reviewText()));
    check("no client errors (review)", page.errors.length === 0, page.errors.slice(0, 3));
    await page.context().close();
  }

  console.log("\n--- Pre-test setup asks for the language (phone) ---");
  {
    const page = await newPage(browser, F.setupToken, true);
    await page.goto(`${BASE}/student/attempt/resume?paper=${F.paperId}`);
    await page.waitForSelector("[data-testid=pre-test-setup]");
    check("setup shows 'Select Your Preferred Language'", await page.locator("[data-testid=language-choice]").isVisible());
    await page.locator("[data-testid=choose-lang-hi]").tap();
    check("choice marked", (await page.locator("[data-testid=choose-lang-hi]").getAttribute("aria-pressed")) === "true");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("phone: no horizontal scroll on setup", overflow <= 1, overflow);
    await page.getByRole("button", { name: /Start Test/ }).tap();
    await page.waitForURL(/\/run$/, { timeout: 20000 });
    await page.waitForSelector("[data-testid=test-player]");
    check("player opens directly in Hindi, no second question", (await page.locator("[data-testid=language-gate]").count()) === 0 && /जैल का उदाहरण है/.test(await qText(page)));
    check("switch visible in the phone header", await page.locator("[data-testid=language-switch]").isVisible());
    const pOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("phone: player has no horizontal scroll", pOverflow <= 1, pOverflow);
    check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
    await page.context().close();
  }
} finally {
  await browser.close();
}
console.log(failures === 0 ? "\nALL BILINGUAL PLAYER UI CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
if (failures) process.exitCode = 1;
