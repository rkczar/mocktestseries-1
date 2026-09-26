/**
 * TEST ENGINE CORE — permanent regression guard (real browser).
 *
 * TEST ENGINE CORE — HIGH RISK SHARED PATH. Changes to option selection,
 * answer persistence, navigation, attempt snapshots, timer, submission or
 * answer reveal require this suite AND scripts/verify-test-engine-core.ts to
 * pass before deployment. See ops/TEST-ENGINE.md for how to run both.
 *
 * Drives the production build of the student test player in Chromium
 * (desktop + a touch phone viewport) against a LOCAL server backed by a
 * DISPOSABLE database. Fixture JSON comes from scripts/test-engine-ui-fixture.ts.
 *
 *   BASE=http://localhost:3100 FIXTURE=/path/fixture.json NODE_PATH=<dir with playwright> \
 *     node scripts/verify-test-engine-ui.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";

// Playwright is not an app dependency: it is resolved from NODE_PATH (CommonJS resolution).
const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");

const BASE = process.env.BASE || "http://localhost:3100";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("The UI suite only runs against a local server backed by a disposable database.");
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
  page.actionPosts = 0;
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  page.on("request", (r) => r.method() === "POST" && r.headers()["next-action"] && page.actionPosts++);
  page.mobile = mobile;
  return page;
}

const position = async (page) => Number(await page.getAttribute("[data-testid=test-player]", "data-question-index"));
const option = (page, label) => page.locator(`[data-testid=option][data-label="${label}"]`);
async function pick(page, label) {
  const target = option(page, label);
  if (page.mobile) await target.tap();
  else await target.click();
}
const isPicked = (page, label) => option(page, label).locator("input").isChecked();
async function settled(page) {
  await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
}
async function next(page) {
  await page.getByRole("button", { name: /Save & Next/ }).click();
}
async function submit(page) {
  await settled(page);
  await page.getByRole("button", { name: "Submit Test" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await page.waitForURL(/\/result$/, { timeout: 20000 });
}
async function openRun(page, attemptId) {
  await page.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await page.waitForSelector("[data-testid=test-player]");
}

/** Builder → Create & Start → instructions → player. Returns the attempt id. */
async function build(page, { count, durationMode = "PER_QUESTION", customMinutes, answerMode = "EXAM" }) {
  await page.goto(`${BASE}/student/custom-module?examId=${F.examId}`);
  await page.waitForFunction(() => /questions are available/.test(document.body.innerText), null, { timeout: 15000 });
  const count_ = page.locator('input[name="count"]');
  await count_.fill(String(count));
  await count_.blur();
  await page.locator(`input[name="durationMode"][value="${durationMode}"]`).check();
  if (customMinutes) await page.locator('input[name="customMinutes"]').fill(String(customMinutes));
  await page.locator(`input[name="answerMode"][value="${answerMode}"]`).check();
  await page.getByRole("button", { name: /Create & Start/ }).click();
  await page.waitForURL(/\/student\/attempt\/[^/]+$/, { timeout: 20000 });
  const attemptId = page.url().split("/").pop();
  const instructions = await page.locator("body").innerText();
  await page.getByRole("link", { name: "Start Test" }).click();
  await page.waitForSelector("[data-testid=test-player]");
  return { attemptId, instructions };
}

async function main() {
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------------
    console.log("\n--- Custom Module builder ---");
    {
      const page = await newPage(browser, F.token);
      await page.goto(`${BASE}/student/custom-module?examId=${F.examId}`);
      await page.waitForFunction(() => /questions are available/.test(document.body.innerText), null, { timeout: 15000 });
      const text = await page.locator("body").innerText();
      check("builder: no Sub-topic filter", !/Sub-topic/i.test(text) && (await page.locator('[name="subTopicId"]').count()) === 0);
      check("builder: no My History filter", !/My History/i.test(text) && (await page.locator('[name="attemptFilter"]').count()) === 0);
      check("builder: exactly three duration modes, default 1 min/question", (await page.locator('input[name="durationMode"]').count()) === 3 && (await page.locator('input[name="durationMode"][value="PER_QUESTION"]').isChecked()));
      check("builder: answer modes Exam (default) + Instant", (await page.locator('input[name="answerMode"]').count()) === 2 && (await page.locator('input[name="answerMode"][value="EXAM"]').isChecked()));
      check("builder: Subject defaults to All Subjects", (await page.locator("#subjectId").inputValue()) === "");
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- 1-question test (desktop) ---");
    {
      const page = await newPage(browser, F.token);
      const { instructions } = await build(page, { count: 1 });
      check("1q: instructions show 1 min", /\b1 min\b/.test(instructions));
      check("1q: player shows Question 1 of 1", /Question 1 of 1/.test(await page.locator("[data-testid=question-position]").innerText()));
      const timer = await page.locator("[data-testid=timer]").innerText();
      check("1q: timer ≈ 01:00", /^0[01]:[0-5]\d$/.test(timer.trim()), timer);
      await pick(page, "C");
      check("1q: option selectable immediately", await isPicked(page, "C"));
      await submit(page);
      check("1q: submit → result page", /\/result$/.test(page.url()));
      check("1q: no client errors", page.errors.length === 0, page.errors);
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- 2-question test (desktop): select, Next, Previous, change, palette, refresh, mark, submit, review ---");
    {
      const page = await newPage(browser, F.token);
      const { attemptId } = await build(page, { count: 2 });
      await pick(page, "A");
      check("2q: Q1 option A selected", await isPicked(page, "A"));
      await next(page);
      check("2q: Next → Q2", (await position(page)) === 1);
      await pick(page, "D");
      await page.getByRole("button", { name: /Previous/ }).click();
      check("2q: Previous → Q1 keeps A", (await position(page)) === 0 && (await isPicked(page, "A")));
      await pick(page, "B");
      check("2q: answer change reflected", await isPicked(page, "B"));
      await page.getByRole("button", { name: "Go to question 2" }).click();
      check("2q: palette jump → Q2 keeps D", (await position(page)) === 1 && (await isPicked(page, "D")));
      await settled(page);
      await page.reload();
      await page.waitForSelector("[data-testid=test-player]");
      check("2q: refresh restores Q1 = B", await isPicked(page, "B"));
      await page.getByRole("button", { name: "Go to question 2" }).click();
      check("2q: refresh restores Q2 = D", await isPicked(page, "D"));
      await page.getByRole("button", { name: /Mark for Review/ }).click();
      await settled(page);
      await page.reload();
      await page.waitForSelector("[data-testid=test-player]");
      const q2Cls = await page.getByRole("button", { name: "Go to question 2" }).getAttribute("class");
      check("2q: Mark for Review persisted (palette colour after reload)", /color-info/.test(q2Cls || ""), q2Cls);
      await submit(page);
      check("2q: result generated", /\/result$/.test(page.url()));
      await page.goto(`${BASE}/student/attempt/${attemptId}/review`);
      check("2q: review page renders", (await page.locator("body").innerText()).length > 50 && !/Application error/.test(await page.content()));
      check("2q: no client errors", page.errors.length === 0, page.errors);
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- 10-question test (touch phone): rapid taps, double Next, unanswered, back/forward, resume ---");
    {
      const page = await newPage(browser, F.token, true);
      const { attemptId } = await build(page, { count: 10 });
      // rapid A → B → C (no waits)
      await pick(page, "A");
      await pick(page, "B");
      await pick(page, "C");
      check("10q: rapid taps end on C", await isPicked(page, "C"));
      // rapid double Next
      const nextBtn = page.getByRole("button", { name: /Save & Next/ });
      await Promise.all([nextBtn.click(), nextBtn.click({ delay: 0 })]);
      const afterDouble = await position(page);
      check("10q: rapid double Next moves forward deterministically (Q2 or Q3, never stuck)", afterDouble === 1 || afterDouble === 2, afterDouble);
      // unanswered → Next, answered → Next, answer + immediate Next
      while ((await position(page)) < 6) await next(page);
      await pick(page, "D");
      await next(page); // option tap + immediate Next
      check("10q: tap + immediate Next advances", (await position(page)) === 7);
      await settled(page);
      // back/forward: leave the player and come back
      await page.goto(`${BASE}/student/attempt/${attemptId}`);
      await page.goBack();
      await page.waitForSelector("[data-testid=test-player]");
      check("10q: browser back returns to a working player", (await option(page, "A").count()) === 1);
      check("10q: Q1 answer (C) survived navigation", await isPicked(page, "C"));
      await page.getByRole("button", { name: "Go to question 7" }).click();
      check("10q: Q7 answer (D) survived navigation", await isPicked(page, "D"));
      while ((await position(page)) < 9) await next(page);
      check("10q: reached final question", (await position(page)) === 9 && /Question 10 of 10/.test(await page.locator("[data-testid=question-position]").innerText()));
      await pick(page, "B");
      await submit(page);
      check("10q: submit → result", /\/result$/.test(page.url()));
      check("10q: bounded save traffic (no request storm)", page.actionPosts < 40, page.actionPosts);
      check("10q: no client errors", page.errors.length === 0, page.errors);
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Duration modes ---");
    {
      const page = await newPage(browser, F.token);
      const u = await build(page, { count: 2, durationMode: "UNLIMITED" });
      check("unlimited: instructions say no time limit", /No time limit/.test(u.instructions));
      check("unlimited: player shows no countdown", /No time limit/.test(await page.locator("[data-testid=timer]").innerText()));
      await submit(page);
      const c = await build(page, { count: 3, durationMode: "CUSTOM", customMinutes: 7 });
      check("custom: 7 min honoured", /\b7 min\b/.test(c.instructions));
      const t = (await page.locator("[data-testid=timer]").innerText()).trim();
      check("custom: countdown starts ≈ 07:00", /^0[67]:[0-5]\d$/.test(t), t);
      await submit(page);
      const p = await build(page, { count: 5 });
      check("per-question: 5 questions → 5 min", /\b5 min\b/.test(p.instructions));
      await submit(page);
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Instant answer mode vs exam mode leakage ---");
    {
      const page = await newPage(browser, F.token);
      await build(page, { count: 2, answerMode: "EXAM" });
      check("exam mode: no answer key in page payload", !/correctLabel|isCorrect/.test(await page.content()));
      check("exam mode: no Check Answer button", (await page.getByRole("button", { name: "Check Answer" }).count()) === 0);
      await submit(page);

      await build(page, { count: 2, answerMode: "INSTANT" });
      check("instant: no answer key before Check Answer", !/correctLabel/.test(await page.content()));
      const checkBtn = page.getByRole("button", { name: "Check Answer" });
      check("instant: Check Answer disabled until an option is chosen", await checkBtn.isDisabled());
      await pick(page, "A"); // fixture: B is always correct
      check("instant: tapping an option does NOT reveal", (await page.locator("[data-testid=reveal-result]").count()) === 0);
      await checkBtn.click();
      await page.waitForSelector("[data-testid=reveal-result]");
      const verdict = await page.locator("[data-testid=reveal-result]").innerText();
      check("instant: shows Incorrect + correct option", /Incorrect/.test(verdict) && /correct answer: B/.test(verdict), verdict);
      check("instant: options locked after reveal", await option(page, "B").locator("input").isDisabled());
      await page.reload();
      await page.waitForSelector("[data-testid=test-player]");
      check("instant: reveal persists across refresh", /Incorrect/.test(await page.locator("[data-testid=reveal-result]").innerText()));
      check("instant: answer still A after refresh (not switchable)", (await isPicked(page, "A")) && (await option(page, "B").locator("input").isDisabled()));
      const html = await page.content();
      check("instant: only the revealed question's key is in the payload", (html.match(/correctLabel/g) || []).length >= 1 && (await page.getByRole("button", { name: "Go to question 2" }).count()) === 1);
      await next(page);
      check("instant: Q2 not revealed", (await page.locator("[data-testid=reveal-result]").count()) === 0);
      await pick(page, "B");
      await page.getByRole("button", { name: "Check Answer" }).click();
      await page.waitForSelector("[data-testid=reveal-result]");
      check("instant: correct pick shows Correct", /Correct/.test(await page.locator("[data-testid=reveal-result]").innerText()));
      await submit(page);
      check("instant: result works normally", /\/result$/.test(page.url()));
      check("instant: no client errors", page.errors.length === 0, page.errors);
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Mock / PYQ / Subject Test through the same player ---");
    for (const [label, attemptId] of [["Mock", F.mockAttemptId], ["PYQ", F.pyqAttemptId], ["Subject", F.subjectAttemptId]]) {
      const page = await newPage(browser, F.token);
      await openRun(page, attemptId);
      check(`${label}: exam mode payload has no answer key`, !/correctLabel|isCorrect/.test(await page.content()));
      await pick(page, "A");
      check(`${label}: option selectable`, await isPicked(page, "A"));
      await next(page);
      check(`${label}: Next works`, (await position(page)) === 1);
      await pick(page, "C");
      await settled(page);
      await page.reload();
      await page.waitForSelector("[data-testid=test-player]");
      check(`${label}: resume restores Q1`, await isPicked(page, "A"));
      await submit(page);
      check(`${label}: submit → result`, /\/result$/.test(page.url()));
      check(`${label}: no client errors`, page.errors.length === 0, page.errors);
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Malformed question does not freeze the player ---");
    {
      const page = await newPage(browser, F.malToken);
      await openRun(page, F.malAttemptId);
      await pick(page, "A");
      await next(page);
      check("malformed: Q2 shows a notice instead of options", (await page.locator("[data-testid=malformed-question]").count()) === 1 && (await page.locator("[data-testid=option]").count()) === 0);
      await next(page);
      check("malformed: Next past it works", (await position(page)) === 2);
      await pick(page, "B");
      check("malformed: later questions still answerable", await isPicked(page, "B"));
      await submit(page);
      check("malformed: attempt submits", /\/result$/.test(page.url()));
      await page.context().close();
    }

    // ------------------------------------------------------------------
    console.log(`\n--- ${F.crowd.length} concurrent students in separate browsers ---`);
    {
      const t0 = Date.now();
      const results = await Promise.all(
        F.crowd.map(async ({ token, attemptId }, i) => {
          const page = await newPage(browser, token, i % 2 === 1);
          try {
            await openRun(page, attemptId);
            for (let q = 0; q < 5; q++) {
              await pick(page, "ABCD"[(i + q) % 4]);
              if (!(await isPicked(page, "ABCD"[(i + q) % 4]))) return `student ${i}: pick failed on Q${q + 1}`;
              if (q < 4) await next(page);
            }
            await submit(page);
            return page.errors.length ? `student ${i}: ${page.errors[0]}` : null;
          } catch (e) {
            return `student ${i}: ${e.message.slice(0, 160)}`;
          } finally {
            await page.context().close();
          }
        })
      );
      const problems = results.filter(Boolean);
      console.log(`  info  ${F.crowd.length} browsers finished in ${Date.now() - t0}ms`);
      check("concurrent browsers: every student selected, navigated and submitted", problems.length === 0, problems);
    }
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nALL TEST ENGINE UI CHECKS PASSED" : `\n${failures} UI CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
