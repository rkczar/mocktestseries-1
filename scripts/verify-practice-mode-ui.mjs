/**
 * Practice Mode vs Exam Mode — real browser release gate (TEST ENGINE CORE).
 *
 * Drives a LOCAL production build on a DISPOSABLE database with the fixture
 * from scripts/practice-mode-ui-fixture.ts. Phone first (Pixel 7, 412px):
 *  - Mock setup asks answer review first; "Show answer after each question"
 *    hides the Time section and the timer rules; Start needs no duration;
 *  - the player has no countdown; tapping an option (no Check Answer button)
 *    commits it on the server, the SAME question shows Incorrect/Correct, the
 *    correct answer and the review tools; the answer is locked; Next is
 *    manual; untouched / skipped questions carry no key in the page payload;
 *  - refresh, a second tab and concurrent taps keep one authoritative answer;
 *  - submit scores the committed answers (checked in the database);
 *  - Exam Mode Standard / 1 min per question / Custom: countdowns, no reveal,
 *    refresh keeps the timer, timeout auto-submits, review after submit, and
 *    only Standard ranks;
 *  - PYQ, Subject Test and Custom Module: the same practice semantics;
 *  - held-answer-key mock: no setup, and a tampered form can't force practice;
 *  - 320 / 375 / 430 / 768 / 1366 px × Day / Night / Eye Saver: no sideways scroll.
 *
 *   BASE=http://127.0.0.1:3111 FIXTURE=/path/fixture.json DATABASE_URL=<scratch> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-practice-mode-ui.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to inspect what looks like the production database.");
  process.exit(2);
}

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
const inspect = (attemptId) =>
  JSON.parse(
    execFileSync("npx", ["tsx", "scripts/practice-mode-ui-fixture.ts", "inspect", attemptId], {
      env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
      encoding: "utf8",
    }).trim().split("\n").pop()
  );

async function newContext(browser, token, { mobile = true, width, theme } = {}) {
  const opts = mobile ? { ...devices["Pixel 7"] } : { viewport: { width: 1366, height: 900 } };
  if (width) opts.viewport = { width, height: 860 };
  const ctx = await browser.newContext(opts);
  const cookies = [{ name: "student-session-token", value: token, url: BASE }];
  if (theme) cookies.push({ name: "mts-theme", value: theme, url: BASE });
  await ctx.addCookies(cookies);
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  return page;
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const option = (page, label) => page.locator(`[data-testid=option][data-label="${label}"]`);
const position = async (page) => Number(await page.getAttribute("[data-testid=test-player]", "data-question-index"));
const isPicked = (page, label) => option(page, label).locator("input").isChecked();
const timerText = async (page) => (await page.locator("[data-testid=timer]").innerText()).trim();
const timerSeconds = async (page) => {
  const m = (await timerText(page)).match(/(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const verdict = async (page) => ((await page.locator("[data-testid=reveal-result]").count()) ? await page.locator("[data-testid=reveal-result]").innerText() : null);
const wrongOf = (key) => ["A", "B", "C", "D"].find((l) => l !== key);
/**
 * How many questions in the run page's server-rendered player payload carry
 * a revealed answer vs none. The hydrated DOM no longer holds the payload,
 * so this fetches the raw HTML through the SAME browser context (same
 * session + device). Each PlayerQuestion serializes `reveal: null` or
 * `reveal: {correctLabel}`.
 */
async function payloadReveals(page, total) {
  const attemptId = page.url().split("/attempt/")[1].split("/")[0];
  // In-page fetch: the browser's own cookies (the device cookie is Secure; Playwright's
  // request API would drop it over http and register a different device).
  const html = await page.evaluate(async (u) => (await fetch(u, { credentials: "same-origin" })).text(), `${BASE}/student/attempt/${attemptId}/run`);
  const revealed = (html.match(/reveal\\?"\s*:\s*\{/g) || []).length;
  const hidden = (html.match(/reveal\\?"\s*:\s*null/g) || []).length;
  return { revealed, hidden, total: revealed + hidden === total, isCorrect: /isCorrect/.test(html) };
}
async function tap(page, label) {
  await option(page, label).tap();
  await page.waitForSelector("[data-testid=reveal-result]", { timeout: 15000 });
}
async function startFromSetup(page, { answerMode, durationMode, customMinutes }) {
  await page.locator(`input[name="answerMode"][value="${answerMode}"]`).check();
  if (durationMode) await page.locator(`input[name="durationMode"][value="${durationMode}"]`).check();
  if (customMinutes) await page.locator("#customMinutes").fill(String(customMinutes));
  await page.getByRole("button", { name: /Start Test|Practice Again/ }).click();
  await page.waitForURL(/\/run$/, { timeout: 30000 });
  await page.waitForSelector("[data-testid=test-player]");
  return page.url().split("/attempt/")[1].split("/")[0];
}
async function submit(page) {
  await page.getByRole("button", { name: "Submit Test" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await page.waitForURL(/\/result$/, { timeout: 30000 });
}

async function main() {
  const browser = await chromium.launch();
  const ids = {};
  try {
    // ------------------------------------------------------------------
    console.log("\n--- MOCK (100 questions) · phone · Show answer after each question ---");
    {
      const ctx = await newContext(browser, F.tokens.practice);
      const page = await newPage(ctx);
      await page.goto(`${BASE}/student/test-series/${F.mockId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await shot(page, "01-setup-default-phone");
      const setup = page.locator("[data-testid=pre-test-setup]");
      const box = async (sel) => (await page.locator(sel).boundingBox()) ?? { x: 0, y: 0 };
      const [ans, time] = [await box("[data-testid=answer-mode-field]"), await box("[data-testid=time-mode-field]")];
      check("1. setup: answer review first, duration below it (not side by side)", ans.y < time.y && Math.abs(ans.x - time.x) < 5, { ans, time });
      check("1. setup: 'How do you want to review answers?' asked", /How do you want to review answers\?/.test(await setup.innerText()));
      await page.locator('input[name="answerMode"][value="INSTANT"]').check();
      await shot(page, "02-setup-practice-phone");
      check("3-4. practice: Time section absent", (await page.locator("[data-testid=time-mode-field]").count()) === 0 && (await page.locator('input[name="durationMode"]').count()) === 0);
      const body = await page.locator("body").innerText();
      check("5. practice: no timer instruction anywhere on the page", !/timer starts|auto-submits/i.test(body));
      check("5. practice: real behavior described", /Select an option to check your answer/.test(body) && /locked/.test(body));
      check("phone: setup has no horizontal scroll", (await overflow(page)) <= 1, await overflow(page));
      check("6. Start Test available without a duration", await page.getByRole("button", { name: /Start Test/ }).isEnabled());
      await page.getByRole("button", { name: /Start Test/ }).click();
      await page.waitForURL(/\/run$/, { timeout: 30000 });
      await page.waitForSelector("[data-testid=test-player]");
      ids.practice = page.url().split("/attempt/")[1].split("/")[0];
      await shot(page, "03-player-q1-untouched");

      const frozen = inspect(ids.practice);
      check("7. started: INSTANT + UNLIMITED, no deadline", frozen.answerMode === "INSTANT" && frozen.durationMode === "UNLIMITED" && frozen.durationMinutes === 0, frozen);
      check("8. no countdown (no mm:ss anywhere in the header)", (await timerSeconds(page)) === null && /No time limit/.test(await timerText(page)));
      const p0 = await payloadReveals(page, 100);
      check("Q1 untouched: NO answer key in the page payload (0 of 100)", p0.revealed === 0 && p0.hidden === 100 && !p0.isCorrect, p0);
      check("10. no Check Answer button", (await page.getByRole("button", { name: /Check Answer/ }).count()) === 0);

      // 9. Q1: tap a WRONG answer.
      const k1 = F.keys[0];
      const w1 = wrongOf(k1);
      const commit = page.waitForResponse((r) => r.request().method() === "POST" && !!r.request().headers()["next-action"]);
      await option(page, w1).tap();
      const res = await commit;
      check("9. the tap is sent to the server", res.status() === 200);
      await page.waitForSelector("[data-testid=reveal-result]");
      await shot(page, "04-q1-revealed-wrong");
      check("11. SAME question in review state (still Q1)", (await position(page)) === 0);
      check("13. Incorrect + correct answer shown", new RegExp(`Incorrect — correct answer: ${k1}`).test(await verdict(page)), await verdict(page));
      check("13. wrong pick marked, correct option marked", (await option(page, w1).locator('[aria-label="Your answer"]').count()) === 1 && (await option(page, k1).locator('[aria-label="Correct answer"]').count()) === 1);
      const tools = page.locator("[data-testid=revealed-review-tools]");
      check("14. Correct Answer line", new RegExp(`Correct Answer: ${k1}\\.`).test(await tools.innerText()));
      check("14. Ask AI offered (student-initiated, nothing auto-fetched)", (await tools.getByRole("button", { name: /Ask AI/ }).count()) === 1);
      check("14. Save + Report available", (await page.getByRole("button", { name: /Save/ }).count()) > 0 && (await page.getByRole("button", { name: /Report/ }).count()) > 0);
      const wa = tools.getByRole("link", { name: /WhatsApp/ });
      if ((await wa.count()) === 1) {
        const text = decodeURIComponent(new URL(await wa.getAttribute("href")).searchParams.get("text") ?? "");
        check("15. WhatsApp: question + options + site link", text.includes(F.questionTexts[0]) && /Drug A/.test(text) && /Drug D/.test(text) && /https?:\/\//.test(text), text);
        check("15. WhatsApp: no answer, explanation, student answer, score or ids", !/correct|answer:|explanation|score|your answer/i.test(text) && !text.includes(ids.practice) && !text.includes(F.mockId), text);
      } else check("15. WhatsApp share offered", false, "no WhatsApp link (is question.whatsapp_share enabled on the scratch DB?)");
      check("12. locked: every option disabled", (await page.locator("[data-testid=option] input:not([disabled])").count()) === 0);
      await option(page, k1).tap({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      check("12. tapping the correct option afterwards changes nothing", (await isPicked(page, w1)) && !(await isPicked(page, k1)));
      check("no auto-advance", (await position(page)) === 0);

      // 16-19. Next (manual) → Q2 untouched, skip it.
      await page.getByRole("button", { name: /^Next/ }).tap();
      check("16. manual Next → Q2", (await position(page)) === 1);
      check("17. Q2: no reveal, no correct marks", (await verdict(page)) === null && (await page.locator('[aria-label="Correct answer"]').count()) === 0 && (await page.locator("[data-testid=revealed-review-tools]").count()) === 0);
      check("17. Q2 options still open", (await page.locator("[data-testid=option] input:not([disabled])").count()) === 4);
      await page.getByRole("button", { name: /^Next/ }).tap();
      check("18. skipped Q2 → Q3", (await position(page)) === 2);
      const p1 = await payloadReveals(page, 100);
      check("19. payload: only Q1 revealed (Q2–Q100 protected)", p1.revealed === 1 && p1.hidden === 99, p1);

      // Q3: correct answer.
      await tap(page, F.keys[2]);
      check("Q3 correct → Correct", /^\s*Correct/.test(await verdict(page)), await verdict(page));

      // 20-21. back to Q1 via the palette.
      await page.getByRole("button", { name: "Go to question 1", exact: true }).tap();
      check("20-21. Q1 still locked + revealed", new RegExp(`Incorrect — correct answer: ${k1}`).test((await verdict(page)) ?? "") && (await isPicked(page, w1)));
      await page.getByRole("button", { name: "Go to question 2", exact: true }).tap();
      check("Q2 still unrevealed after navigating around", (await verdict(page)) === null);

      // 22-23. refresh.
      await page.reload();
      await page.waitForSelector("[data-testid=test-player]");
      check("23. refresh: still no countdown", (await timerSeconds(page)) === null);
      const p2 = await payloadReveals(page, 100);
      check("23. refresh payload: exactly Q1 + Q3 revealed", p2.revealed === 2 && p2.hidden === 98, p2);
      check("23. refresh: Q1 locked + revealed", new RegExp(`Incorrect — correct answer: ${k1}`).test((await verdict(page)) ?? "") && (await isPicked(page, w1)) && (await option(page, k1).locator("input").isDisabled()));
      await page.getByRole("button", { name: "Go to question 2", exact: true }).tap();
      check("23. refresh: Q2 unrevealed + open", (await verdict(page)) === null && (await page.locator("[data-testid=option] input:not([disabled])").count()) === 4);
      await page.getByRole("button", { name: "Go to question 3", exact: true }).tap();
      check("23. refresh: Q3 Correct persists", /^\s*Correct/.test((await verdict(page)) ?? ""));

      // Another tab (same device/session): same authoritative state.
      const tab2 = await newPage(ctx);
      await tab2.goto(`${BASE}/student/attempt/${ids.practice}/run`);
      await tab2.waitForSelector("[data-testid=test-player]");
      check("other tab: Q1 locked + revealed", new RegExp(`correct answer: ${k1}`).test((await verdict(tab2)) ?? "") && (await isPicked(tab2, w1)));
      // Both tabs tap DIFFERENT options on untouched Q4 at the same time.
      for (const p of [page, tab2]) await p.getByRole("button", { name: "Go to question 4", exact: true }).tap();
      const k4 = F.keys[3];
      await Promise.all([option(page, k4).tap(), option(tab2, wrongOf(k4)).tap()]);
      await Promise.all([page.waitForSelector("[data-testid=reveal-result]"), tab2.waitForSelector("[data-testid=reveal-result]")]);
      const stored4 = inspect(ids.practice).answers[3];
      const shown = [(await isPicked(page, k4)) ? k4 : wrongOf(k4), (await isPicked(tab2, k4)) ? k4 : wrongOf(k4)];
      check("concurrent taps (2 tabs): both tabs show the ONE committed answer", stored4.revealed && shown.every((l) => l === stored4.selected), { stored4, shown });
      await tab2.close();
      check("phone: player has no horizontal scroll", (await overflow(page)) <= 1, await overflow(page));
      check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));

      await submit(page);
      const r = inspect(ids.practice);
      const q4Right = stored4.selected === k4;
      const expected = { correct: 1 + (q4Right ? 1 : 0), incorrect: 1 + (q4Right ? 0 : 1) };
      check("submit: scored from the committed answers (Q1 wrong, Q3 right, Q4 first commit, 96 blank)",
        r.status === "SUBMITTED" && r.correctCount === expected.correct && r.incorrectCount === expected.incorrect && r.unansweredCount === 100 - 3 && r.answers[0].selected === w1 && r.answers[2].selected === F.keys[2], r);
      check("submit: score uses the same negative marking (+1 / −0.25)", Math.abs(r.score - (expected.correct - 0.25 * expected.incorrect)) < 1e-9, r.score);
      check("practice attempt: not ranked", r.isLeaderboardAttempt === false);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- MOCK · Exam Mode (answers after the test): Standard / 1 min / Custom ---");
    {
      const runs = [
        ["examStd", { answerMode: "EXAM", durationMode: "FIXED" }, 120 * 60, true],
        ["examPerQ", { answerMode: "EXAM", durationMode: "PER_QUESTION" }, 100 * 60, false],
        ["examCustom", { answerMode: "EXAM", durationMode: "CUSTOM", customMinutes: 1 }, 60, false],
      ];
      for (const [flow, choice, seconds, ranks] of runs) {
        const ctx = await newContext(browser, F.tokens[flow], { mobile: flow !== "examPerQ" });
        const page = await newPage(ctx);
        await page.goto(`${BASE}/student/test-series/${F.mockId}`);
        await page.waitForSelector("[data-testid=pre-test-setup]");
        check(`${flow}: 25-26. exam mode shows three durations`, (await page.locator('input[name="durationMode"]').count()) === 3);
        const notes = await page.locator("[data-testid=setup-notes]").innerText();
        check(`${flow}: exam mode notes keep the timer rule`, /auto-submits when time runs out/.test(notes));
        ids[flow] = await startFromSetup(page, choice);
        const t0 = await timerSeconds(page);
        check(`${flow}: 28. countdown ≈ ${seconds / 60} min`, t0 !== null && t0 <= seconds && t0 > seconds - 25, t0);
        await option(page, "A").click();
        await page.waitForTimeout(600);
        check(`${flow}: 30. answering reveals nothing`, (await verdict(page)) === null && (await page.locator("[data-testid=revealed-review-tools]").count()) === 0 && (await page.locator("[data-testid=practice-hint]").count()) === 0);
        check(`${flow}: answers stay editable`, await option(page, "B").locator("input").isEnabled());
        const p = await payloadReveals(page, 100);
        check(`${flow}: no answer key in the payload`, p.revealed === 0 && !p.isCorrect, p);
        await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
        await page.waitForTimeout(1500);
        await page.reload();
        await page.waitForSelector("[data-testid=test-player]");
        const t1 = await timerSeconds(page);
        check(`${flow}: refresh does not reset the timer`, t1 !== null && t1 <= t0, { t0, t1 });
        check(`${flow}: refresh keeps the saved answer`, await isPicked(page, "A"));
        if (flow === "examCustom") {
          // Timeout: the 1-minute attempt auto-submits on its own.
          await page.waitForURL(/\/result$/, { timeout: 90000 });
          check(`${flow}: timeout auto-submits → result`, true);
        } else {
          await submit(page);
        }
        const r = inspect(ids[flow]);
        check(`${flow}: submitted, frozen ${choice.durationMode}`, r.status === "SUBMITTED" && r.answerMode === "EXAM" && r.durationMode === choice.durationMode, r.durationMode);
        check(`${flow}: leaderboard ${ranks ? "eligible" : "NOT ranked"}`, r.isLeaderboardAttempt === ranks, r.isLeaderboardAttempt);
        await page.goto(page.url().replace(/\/result$/, "/review"));
        check(`${flow}: review after submit shows the key`, new RegExp(`Correct Answer: ${F.keys[0]}\\.`).test(await page.locator("body").innerText()));
        check(`${flow}: no client errors`, page.errors.length === 0, page.errors.slice(0, 3));
        await ctx.close();
      }
    }

    // ------------------------------------------------------------------
    console.log("\n--- PYQ · phone · practice mode ---");
    {
      const ctx = await newContext(browser, F.tokens.pyq);
      const page = await newPage(ctx);
      await page.goto(`${BASE}/student/attempt/resume?paper=${F.paperId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await page.locator('input[name="answerMode"][value="INSTANT"]').check();
      check("PYQ: Time section absent in practice mode", (await page.locator("[data-testid=time-mode-field]").count()) === 0);
      check("PYQ: no timer instruction", !/timer starts|auto-submits/i.test(await page.locator("body").innerText()));
      ids.pyq = await startFromSetup(page, { answerMode: "INSTANT" });
      check("PYQ: no countdown", (await timerSeconds(page)) === null);
      check("PYQ: no key before a tap", (await payloadReveals(page, 10)).revealed === 0);
      await tap(page, wrongOf(F.pyqKeys[0]));
      check("PYQ: tap → same question Incorrect + key", (await position(page)) === 0 && new RegExp(`correct answer: ${F.pyqKeys[0]}`).test(await verdict(page)));
      await page.getByRole("button", { name: /^Next/ }).tap();
      check("PYQ: next question unrevealed", (await verdict(page)) === null && (await payloadReveals(page, 10)).revealed === 1);
      const r = inspect(ids.pyq);
      check("PYQ: INSTANT + UNLIMITED, Q1 committed", r.answerMode === "INSTANT" && r.durationMode === "UNLIMITED" && r.answers[0].revealed);
      check("PYQ: no client errors", page.errors.length === 0, page.errors.slice(0, 3));
      await ctx.close();
    }

    // ------------------------------------------------------------------
    for (const [flow, url, button] of [
      ["subject", `/student/subject-test/${F.examId}`, /Start Subject Test/],
      ["custom", `/student/custom-module?examId=${F.examId}`, /Create & Start/],
    ]) {
      console.log(`\n--- ${flow === "subject" ? "Subject Test" : "Custom Module"} · phone · practice mode ---`);
      const ctx = await newContext(browser, F.tokens[flow]);
      const page = await newPage(ctx);
      await page.goto(`${BASE}${url}`);
      await page.waitForFunction(() => /questions are available/.test(document.body.innerText), null, { timeout: 20000 });
      check(`${flow}: exam mode (default) offers durations`, (await page.locator('input[name="durationMode"]').count()) === 3);
      await page.locator('input[name="answerMode"][value="INSTANT"]').check();
      check(`${flow}: practice mode hides the Time section`, (await page.locator('input[name="durationMode"]').count()) === 0);
      const count = page.locator('input[name="count"]');
      await count.fill("5");
      await count.blur();
      check(`${flow}: no horizontal scroll`, (await overflow(page)) <= 1, await overflow(page));
      await page.getByRole("button", { name: button }).tap();
      await page.waitForURL(/\/student\/attempt\/[^/]+$/, { timeout: 30000 });
      ids[flow] = page.url().split("/").pop();
      const landing = await page.locator("body").innerText();
      check(`${flow}: landing says no time limit, tap-to-check, no timer rule`, /No time limit/.test(landing) && /Select an option to check your answer/.test(landing) && !/timer starts/i.test(landing));
      await page.getByRole("link", { name: "Start Test" }).tap();
      await page.waitForSelector("[data-testid=test-player]");
      check(`${flow}: no countdown`, (await timerSeconds(page)) === null);
      check(`${flow}: no Check Answer button, no key before a tap`, (await page.getByRole("button", { name: /Check Answer/ }).count()) === 0 && (await payloadReveals(page, 5)).revealed === 0);
      await tap(page, "A");
      check(`${flow}: tap → same question in review state`, (await position(page)) === 0 && /Correct|Incorrect/.test(await verdict(page)) && (await page.locator("[data-testid=revealed-review-tools]").count()) === 1);
      check(`${flow}: locked`, (await page.locator("[data-testid=option] input:not([disabled])").count()) === 0);
      await page.getByRole("button", { name: /^Next/ }).tap();
      check(`${flow}: next question unrevealed`, (await verdict(page)) === null && (await payloadReveals(page, 5)).revealed === 1);
      await page.reload();
      await page.waitForSelector("[data-testid=test-player]");
      check(`${flow}: refresh keeps Q1 revealed only`, (await payloadReveals(page, 5)).revealed === 1 && (await verdict(page)) !== null);
      const r = inspect(ids[flow]);
      check(`${flow}: INSTANT + UNLIMITED frozen`, r.answerMode === "INSTANT" && r.durationMode === "UNLIMITED" && r.answers[0].revealed && r.answers[0].selected === "A", r);
      await submit(page);
      check(`${flow}: submit → result`, /\/result$/.test(page.url()));
      check(`${flow}: no client errors`, page.errors.length === 0, page.errors.slice(0, 3));
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Held answer key: practice mode cannot be forced ---");
    {
      const ctx = await newContext(browser, F.tokens.held);
      const page = await newPage(ctx);
      await page.goto(`${BASE}/student/test-series/${F.heldMockId}?answerMode=INSTANT`);
      check("held key: no setup / no answer-mode choice on the details page", (await page.locator("[data-testid=pre-test-setup]").count()) === 0 && (await page.locator('input[name="answerMode"]').count()) === 0);
      // A stale/tampered setup form: the free mock's setup re-pointed at the held mock, Practice Mode chosen.
      await page.goto(`${BASE}/student/test-series/${F.mockId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await page.locator('input[name="answerMode"][value="INSTANT"]').check();
      await page.evaluate((heldId) => {
        document.querySelector('[data-testid=pre-test-setup] input[name="testId"]').value = heldId;
      }, F.heldMockId);
      await page.getByRole("button", { name: /Start Test/ }).click();
      await page.waitForURL(/\/run$/, { timeout: 30000 });
      await page.waitForSelector("[data-testid=test-player]");
      const heldAttempt = page.url().split("/attempt/")[1].split("/")[0];
      const r = inspect(heldAttempt);
      check("held key: tampered form still creates a formal EXAM + FIXED attempt", r.answerMode === "EXAM" && r.durationMode === "FIXED", r);
      check("held key: countdown, no practice panel, no key", (await timerSeconds(page)) !== null && (await page.locator("[data-testid=practice-hint]").count()) === 0 && (await payloadReveals(page, 5)).revealed === 0);
      await option(page, "A").click();
      await page.waitForTimeout(600);
      check("held key: answering reveals nothing", (await verdict(page)) === null);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Responsive × themes (setup + revealed player) ---");
    {
      const widths = [320, 375, 430, 768, 1366];
      for (const theme of ["light", "dark", "eyesaver"]) {
        // Setup (practice mode chosen) at every width…
        for (const width of widths) {
          const ctx = await newContext(browser, F.tokens.themes, { width, theme });
          const page = await newPage(ctx);
          await page.goto(`${BASE}/student/test-series/${F.mockId}`);
          await page.waitForSelector("[data-testid=pre-test-setup]");
          await page.locator('input[name="answerMode"][value="INSTANT"]').check();
          const applied = await page.evaluate(() => document.documentElement.dataset.theme);
          const o = await overflow(page);
          if (width === 320 || width === 1366) await shot(page, `theme-${theme}-${width}-setup`);
          check(`${theme} @${width}px setup: theme applied, no sideways scroll`, applied === theme && o <= 1, { applied, o });
          await ctx.close();
        }
        // …then one practice attempt with a revealed question, viewed at every width.
        let attemptId = null;
        for (const width of widths) {
          const ctx = await newContext(browser, F.tokens.themes, { width, theme });
          const page = await newPage(ctx);
          if (!attemptId) {
            await page.goto(`${BASE}/student/test-series/${F.mockId}`);
            await page.waitForSelector("[data-testid=pre-test-setup]");
            attemptId = await startFromSetup(page, { answerMode: "INSTANT" });
            await option(page, "A").click();
            await page.waitForSelector("[data-testid=reveal-result]");
          } else {
            await page.goto(`${BASE}/student/attempt/${attemptId}/run`);
            await page.waitForSelector("[data-testid=reveal-result]");
          }
          const o = await overflow(page);
          if (width === 320 || width === 1366) await shot(page, `theme-${theme}-${width}-player`);
          check(`${theme} @${width}px revealed player: no sideways scroll`, o <= 1, o);
          if (width === widths[widths.length - 1]) await submit(page);
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
    if (process.env.IDS_OUT) fs.writeFileSync(process.env.IDS_OUT, JSON.stringify(ids));
  }
  console.log(failures === 0 ? "\nALL PRACTICE MODE UI CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main();
