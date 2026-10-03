/**
 * Pre-Test Setup — real browser (TEST ENGINE CORE).
 *
 * Drives the production build against a LOCAL server on a DISPOSABLE
 * database, with the fixture from scripts/test-engine-ui-fixture.ts:
 *  - Mock details page asks answer review first (after the test default);
 *    only "after the test" shows Standard / 1 min per question / Custom, and
 *    nothing is created until Start;
 *  - "after each question": no Time section, no timer notes, no countdown;
 *    no answer key reaches the page before an option is tapped; the tap
 *    commits it and the same question shows the verdict, correct answer,
 *    Ask AI (authorized) and share tools; refresh keeps the reveal; the
 *    setup is gone while running;
 *  - after-test mode never shows a key;
 *  - PYQ setup page with Custom time; phone viewport has no sideways scroll.
 *
 *   BASE=http://127.0.0.1:3111 FIXTURE=/path/fixture.json NODE_PATH=<dir with playwright> \
 *     node scripts/verify-pre-test-setup-ui.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");

const BASE = process.env.BASE || "http://127.0.0.1:3111";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS || null;
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

async function newPage(browser, token, mobile = false) {
  const ctx = await browser.newContext(mobile ? { ...devices["Pixel 7"] } : { viewport: { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: "student-session-token", value: token, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  return page;
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const timerSeconds = async (page) => {
  const t = (await page.locator("[data-testid=timer]").innerText()).trim();
  const m = t.match(/(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
// The hydrated DOM no longer holds the serialized player payload: fetch the
// raw server HTML through the same browser context (same session + device).
const noKeyInPage = async (page) => {
  const html = await page.evaluate(async (u) => (await fetch(u, { credentials: "same-origin" })).text(), page.url());
  return /reveal\\?"\s*:\s*null/.test(html) && !/correctLabel|isCorrect/.test(html);
};
const option = (page, label) => page.locator(`[data-testid=option][data-label="${label}"]`);

async function main() {
  const browser = await chromium.launch();
  try {
    console.log("\n--- Mock: setup → show answer after each question (practice mode) ---");
    if (process.env.ONLY !== "pyq") {
      const page = await newPage(browser, F.setupToken);
      await page.goto(`${BASE}/student/test-series/${F.mockId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await shot(page, "mock-setup-desktop");
      check("answer review is asked first, 'after the test' selected by default", await page.locator('input[name="answerMode"][value="EXAM"]').isChecked());
      const time = page.locator('input[name="durationMode"]');
      check("exam mode: three durations, Standard selected by default", (await time.count()) === 3 && (await page.locator('input[name="durationMode"][value="FIXED"]').isChecked()));
      check("1 min/question hint shows the real count", /5 questions = 5 minutes/.test(await page.locator("[data-testid=time-mode-field]").innerText()));
      check("Standard hint shows the configured duration (30)", /configured for this test \(30 minutes\)/.test(await page.locator("[data-testid=time-mode-field]").innerText()));
      await page.locator('input[name="durationMode"][value="CUSTOM"]').check();
      check("custom minutes input appears", await page.locator("#customMinutes").isVisible());
      check("exam mode notes: timer rule shown", /auto-submits when time runs out/.test(await page.locator("[data-testid=setup-notes]").innerText()));
      await page.locator('input[name="answerMode"][value="INSTANT"]').check();
      check("practice mode: Time section disappears", (await page.locator("[data-testid=time-mode-field]").count()) === 0 && (await time.count()) === 0);
      const notes = await page.locator("[data-testid=setup-notes]").innerText();
      check("practice mode: no timer instruction, tap-to-check rule shown", !/timer|auto-submit/i.test(notes) && /Select an option to check your answer/.test(notes), notes);
      await page.getByRole("button", { name: /Start Test/ }).click();
      await page.waitForURL(/\/run$/, { timeout: 20000 });
      await page.waitForSelector("[data-testid=test-player]");
      const attemptId = page.url().split("/attempt/")[1].split("/")[0];

      check("practice mode: no countdown", (await timerSeconds(page)) === null && /No time limit/.test(await page.locator("[data-testid=timer]").innerText()));
      check("no answer key in the page before an option is tapped", await noKeyInPage(page));
      check("no Check Answer button", (await page.getByRole("button", { name: "Check Answer" }).count()) === 0);
      await option(page, "A").click();
      await page.waitForSelector("[data-testid=reveal-result]");
      check("tapping A commits + same question shows Incorrect (key B)", /Incorrect/.test(await page.locator("[data-testid=reveal-result]").innerText()) && (await page.getAttribute("[data-testid=test-player]", "data-question-index")) === "0");
      const tools = page.locator("[data-testid=revealed-review-tools]");
      check("correct answer line shown", /Correct Answer: B\./.test(await tools.innerText()));
      check("options locked after commit", await option(page, "C").locator("input").isDisabled());
      const askAi = tools.getByRole("button", { name: /Ask AI/ });
      check("Ask AI offered after commit", (await askAi.count()) === 1);
      await askAi.click();
      await page.waitForTimeout(2500);
      const toolsText = await tools.innerText();
      check("Ask AI is authorized for the committed question (no 'after submit' lock)", !/once you've submitted|from your submitted tests/i.test(toolsText), toolsText.slice(0, 200));
      check("Save and Report still available", (await page.getByRole("button", { name: /Save/ }).count()) > 0 && (await page.getByRole("button", { name: /Report/ }).count()) > 0);
      if (F.whatsappEnabled) check("WhatsApp share offered after commit", (await tools.getByRole("link", { name: /WhatsApp/ }).count()) === 1);
      await shot(page, "mock-instant-revealed");

      await page.getByRole("button", { name: /^Next/ }).click();
      await page.waitForTimeout(300);
      check("next question: not revealed", (await page.locator("[data-testid=reveal-result]").count()) === 0 && (await page.locator("[data-testid=practice-hint]").count()) === 1);

      await page.reload();
      await page.waitForSelector("[data-testid=test-player]");
      check("refresh: still no countdown", (await timerSeconds(page)) === null);
      check("refresh: reveal of Q1 persists", (await page.locator("[data-testid=reveal-result]").count()) === 1);

      await page.goto(`${BASE}/student/test-series/${F.mockId}`);
      check("while running: details page offers Resume, no setup", (await page.locator("[data-testid=pre-test-setup]").count()) === 0 && (await page.getByRole("button", { name: /Resume Test/ }).count()) === 1);
      await page.goto(`${BASE}/student/attempt/resume?mockTest=${F.mockId}`);
      await page.waitForURL(new RegExp(`/attempt/${attemptId}$`));
      check("resume link lands in the SAME attempt", true);
      check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
      await page.context().close();
    }

    console.log("\n--- Mock: answers after the test (exam mode) ---");
    if (process.env.ONLY !== "pyq") {
      const page = await newPage(browser, F.examModeToken);
      await page.goto(`${BASE}/student/test-series/${F.mockId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await page.getByRole("button", { name: /Start Test/ }).click();
      await page.waitForURL(/\/run$/, { timeout: 20000 });
      await page.waitForSelector("[data-testid=test-player]");
      const t = await timerSeconds(page);
      check("Standard time = configured 30 minutes", t !== null && t <= 1800 && t > 1780, t);
      check("exam mode: no reveal panel", (await page.locator("[data-testid=practice-hint]").count()) === 0 && (await page.locator("[data-testid=reveal-result]").count()) === 0);
      await option(page, "B").click();
      await page.waitForTimeout(500);
      check("exam mode: no key in the page after answering", (await noKeyInPage(page)) && (await page.locator("[data-testid=revealed-review-tools]").count()) === 0);
      await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
      await page.getByRole("button", { name: "Submit Test" }).first().click();
      await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
      await page.waitForURL(/\/result$/, { timeout: 20000 });
      check("submit → result", true);
      await page.goto(page.url().replace(/\/result$/, "/review"));
      check("review after submit shows the answer", /Correct Answer: B\./.test(await page.locator("body").innerText()));
      check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
      await page.context().close();
    }

    console.log("\n--- PYQ: setup page with Custom time (phone) ---");
    {
      // The exam-mode student (its mock is submitted): one student may run a test on only one device at a time.
      const page = await newPage(browser, F.examModeToken, true);
      await page.goto(`${BASE}/student/attempt/resume?paper=${F.paperId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await shot(page, "pyq-setup-phone");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone: no horizontal scroll on the setup page", overflow <= 1, overflow);
      check("PYQ: 1 min/question hint = 10 questions", /10 questions = 10 minutes/.test(await page.locator("[data-testid=time-mode-field]").innerText()));
      await page.locator('input[name="durationMode"][value="CUSTOM"]').check();
      await page.locator("#customMinutes").fill("0");
      await page.getByRole("button", { name: /Start Test/ }).tap();
      await page.waitForTimeout(800);
      check("custom 0 blocked (no attempt started)", /\/attempt\/resume/.test(page.url()));
      await page.locator("#customMinutes").fill("7");
      await page.getByRole("button", { name: /Start Test/ }).tap();
      await page.waitForURL(/\/run$/, { timeout: 20000 });
      await page.waitForSelector("[data-testid=test-player]", { timeout: 15000 }).catch(async () => {
        await shot(page, "pyq-run-failure");
        console.log((await page.locator("body").innerText()).slice(0, 400));
      });
      const t = await timerSeconds(page);
      check("PYQ custom: timer = 7 minutes", t !== null && t <= 420 && t > 400, t);
      check("PYQ exam mode default: no reveal panel", (await page.locator("[data-testid=practice-hint]").count()) === 0);
      const pOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("phone: player has no horizontal scroll", pOverflow <= 1, pOverflow);
      check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
      await page.context().close();
    }
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nALL PRE-TEST SETUP UI CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main();
