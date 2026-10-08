/**
 * Test Player sticky Previous / Save & Next bar — real browser verification.
 *
 * Drives a LOCAL production build on a DISPOSABLE database seeded by
 * scripts/ai-actions-ux-fixture.ts (20-question FREE Mock). Starts one Exam
 * Mode attempt and one Practice (Instant) attempt — neither is submitted —
 * then at desktop, tablet, phone portrait and phone landscape checks:
 *  - the bar (QuestionBottomNav, data-testid=player-nav) is inside the
 *    viewport at the page top and stays pinned to the viewport bottom while
 *    scrolled deep into a long question;
 *  - it never covers the question, its options or the palette's Submit Test
 *    button: everything can scroll clear above it;
 *  - Previous is really disabled on Q1; Save & Next (Exam) / Next (Practice)
 *    keeps the player's paging and answer saving; the last question shows
 *    Submit Test, which opens the existing confirm dialog (cancelled here);
 *  - Clear Response, Mark for Review & Next and the palette still work;
 *  - Next from deep in a long question brings the new question's card back
 *    under the sticky header; from the page top it doesn't jump;
 *  - touch targets ≥ 44px on phones, safe-area padding, no sideways scroll,
 *    no console / hydration errors.
 *
 *   BASE=http://127.0.0.1:3111 FIXTURE=/path/aiux.json DATABASE_URL=<scratch> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-player-nav.mjs
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
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const DEVICES = {
  desktop: { viewport: { width: 1366, height: 900 } },
  tablet: { viewport: { width: 820, height: 1180 }, hasTouch: true },
  phone: { ...devices["Pixel 7"] },
  landscape: { ...devices["Pixel 7 landscape"] },
};

async function newPage(browser, device, token) {
  const ctx = await browser.newContext(DEVICES[device]);
  await ctx.addCookies([{ name: "student-session-token", value: token, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  return { ctx, page };
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const index = async (page) => Number(await page.getAttribute("[data-testid=test-player]", "data-question-index"));
const position = async (page) => (await page.getByTestId("player-nav-position").innerText()).replace(/\s+/g, " ").trim();
const nextButton = (page) => page.getByTestId("player-nav").locator("button").last();
const prevButton = (page) => page.getByTestId("player-nav").locator("button").first();
const option = (page, label) => page.locator(`[data-testid=option][data-label="${label}"]`);
const geometry = (page) =>
  page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect().toJSON();
    const navEl = document.querySelector("[data-testid=player-nav]");
    const card = document.querySelector("[data-testid=question-position]").closest(".scroll-mt-20");
    const header = document.querySelector("header");
    return {
      nav: r(navEl),
      bar: r(navEl.firstElementChild),
      card: r(card),
      headerBottom: header ? header.getBoundingClientRect().bottom : 0,
      vh: window.innerHeight,
      vw: window.innerWidth,
      scrollY: window.scrollY,
      atMaxScroll: Math.abs(window.scrollY - (document.documentElement.scrollHeight - window.innerHeight)) < 2,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      buttons: [...navEl.querySelectorAll("button")].map((b) => ({ h: b.getBoundingClientRect().height, disabled: b.disabled, text: b.innerText.trim() })),
    };
  });
async function goToQuestion(page, n) {
  await page.getByRole("button", { name: `Go to question ${n}`, exact: true }).click();
  await page.waitForFunction((i) => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === String(i), n - 1);
}

async function start(browser, token, answerMode) {
  const { ctx, page } = await newPage(browser, "desktop", token);
  await page.goto(`${BASE}/student/test-series/${F.mockId}`);
  // A re-run finds this student's unsubmitted attempt from last time: resume it instead.
  await page.waitForSelector("[data-testid=pre-test-setup], button:has-text('Resume Test')");
  if (await page.locator("[data-testid=pre-test-setup]").count()) {
    await page.locator(`input[name="answerMode"][value="${answerMode}"]`).check();
    await page.getByRole("button", { name: /Start Test|Practice Again/ }).first().click();
  } else {
    await page.getByRole("button", { name: /Resume Test/ }).click();
  }
  await page.waitForURL(/\/run$/, { timeout: 30000 });
  await page.waitForSelector("[data-testid=test-player]").catch(async (e) => {
    console.error("start failed at", page.url(), (await page.locator("body").innerText()).slice(0, 400));
    throw e;
  });
  const attemptId = page.url().split("/attempt/")[1].split("/")[0];
  await ctx.close();
  return attemptId;
}

async function runDevice(browser, device, token, attemptId, mode) {
  console.log(`\n--- ${mode} · ${device} ---`);
  const label = `${mode} ${device}`;
  const { ctx, page } = await newPage(browser, device, token);
  await page.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await page.waitForSelector("[data-testid=player-nav]");
  await page.waitForLoadState("networkidle").catch(() => {});
  await goToQuestion(page, 1);
  await page.evaluate(() => window.scrollTo(0, 0));
  const total = F.keys.length;
  const nextLabel = mode === "exam" ? /Save & Next/ : /^Next/;

  let g = await geometry(page);
  check(`${label}: bar visible at page top without scrolling`, g.nav.bottom <= g.vh + 0.5 && g.nav.top >= 0, g.nav);
  check(`${label}: counter shows 1 / ${total}`, new RegExp(`^(Question )?1 / ${total}$`).test(await position(page)), await position(page));
  check(`${label}: Q1 → Previous really disabled, Next enabled`, g.buttons[0].disabled === true && g.buttons[1].disabled === false, g.buttons);
  check(`${label}: right button reads ${mode === "exam" ? "Save & Next" : "Next"}`, nextLabel.test(g.buttons[1].text) && (mode === "exam" || !/Save/.test(g.buttons[1].text)), g.buttons[1].text);
  check(`${label}: no sideways scroll`, g.overflow <= 0, g.overflow);
  check(`${label}: bar inside viewport horizontally`, g.bar.left >= 0 && g.bar.right <= g.vw, g.bar);
  if (device === "phone" || device === "landscape") check(`${label}: touch targets ≥ 44px`, g.buttons.every((b) => b.h >= 44), g.buttons);
  const pad = await page.getByTestId("player-nav").evaluate((el) => el.style.paddingBottom);
  check(`${label}: safe-area bottom padding`, /safe-area-inset-bottom/.test(pad), pad);
  check(`${label}: Clear Response + Mark for Review & Next still shown`, (await page.getByRole("button", { name: "Clear Response" }).count()) === 1 && (await page.getByRole("button", { name: /Mark for Review & Next/ }).count()) === 1);
  check(`${label}: exactly one Previous / Next pair on the page`, (await page.getByRole("button", { name: /^Previous$/ }).count()) === 1);

  // Next from the very top must not jump the page.
  await nextButton(page).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === "1");
  g = await geometry(page);
  check(`${label}: Next from top → Q2, no jump`, g.scrollY === 0 && /^(Question )?2 \//.test(await position(page)), { y: g.scrollY, pos: await position(page) });
  await prevButton(page).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === "0");
  check(`${label}: Previous → back to Q1`, (await index(page)) === 0);

  // Make the question very long, like a long passage / diagram question.
  await page.evaluate(() => {
    const stem = document.querySelector("[data-testid=question-position]").closest(".scroll-mt-20");
    const filler = document.createElement("p");
    filler.dataset.testid = "filler";
    filler.textContent = "Long question line. ".repeat(500);
    const opts = stem.querySelector("[data-testid=option]");
    opts.parentElement.insertAdjacentElement("beforebegin", filler);
  });
  await page.evaluate(() => {
    const card = document.querySelector("[data-testid=question-position]").closest(".scroll-mt-20");
    window.scrollTo(0, card.offsetTop + card.offsetHeight / 2);
  });
  g = await geometry(page);
  check(`${label}: mid-question → bar pinned to viewport bottom`, Math.abs(g.nav.bottom - g.vh) < 1.5, { navBottom: g.nav.bottom, vh: g.vh });
  await shot(page, `${mode}-${device}-mid-question`);

  // Options + last option reachable clear above the bar.
  const lastOpt = page.locator("[data-testid=option]").last();
  await page.evaluate(() => {
    const o = [...document.querySelectorAll("[data-testid=option]")].pop();
    const navEl = document.querySelector("[data-testid=player-nav]");
    window.scrollBy(0, o.getBoundingClientRect().bottom - (window.innerHeight - navEl.offsetHeight));
  });
  const edge = await page.evaluate(() => {
    const o = [...document.querySelectorAll("[data-testid=option]")].pop();
    const r = o.getBoundingClientRect();
    const navEl = document.querySelector("[data-testid=player-nav]");
    const hit = document.elementFromPoint(r.left + 8, r.bottom - 6);
    return { optBottom: r.bottom, navTop: navEl.getBoundingClientRect().top, hitIsNav: !!hit?.closest("[data-testid=player-nav]") };
  });
  check(`${label}: last option sits clear above the bar (not hit-tested as the bar)`, edge.optBottom <= edge.navTop + 0.5 && !edge.hitIsNav, edge);
  const lastLabel = await lastOpt.getAttribute("data-label");
  // Practice: the first answer is final, so on a later device Q1 is already answered and locked.
  const locked = mode === "practice" && (await page.locator("[data-testid=reveal-result]").count()) > 0;
  if (!locked) await lastOpt.click();
  if (mode === "practice") await page.waitForSelector("[data-testid=reveal-result]", { timeout: 15000 });
  check(`${label}: last option selectable right above the bar`, locked || (await lastOpt.locator("input").isChecked()), lastLabel);
  if (mode === "exam") {
    await page.getByRole("button", { name: "Clear Response" }).click();
    check(`${label}: Clear Response still clears`, !(await lastOpt.locator("input").isChecked()));
    await lastOpt.click();
  }

  // Page end: the palette's Submit Test (and everything else) scrolls clear of the bar.
  await page.waitForTimeout(500); // let the Practice reveal / explanation finish growing the card
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const end = await page.evaluate(() => {
    const navEl = document.querySelector("[data-testid=player-nav]");
    const card = document.querySelector("[data-testid=question-position]").closest(".scroll-mt-20");
    const palette = document.querySelector("[data-testid=palette]");
    const submit = [...(palette.closest("aside")?.querySelectorAll("button") ?? [])].find((b) => b.innerText.trim() === "Submit Test");
    const navTop = navEl.getBoundingClientRect().top;
    return { navTop, cardBottom: card.getBoundingClientRect().bottom, paletteBottom: palette.getBoundingClientRect().bottom, submitBottom: submit ? submit.getBoundingClientRect().bottom : null };
  });
  check(`${label}: at page end nothing is under the bar (card, palette, Submit Test)`, end.cardBottom <= end.navTop + 0.5 && end.paletteBottom <= end.navTop + 0.5 && (end.submitBottom === null || end.submitBottom <= end.navTop + 0.5), end);
  await shot(page, `${mode}-${device}-page-end`);

  // Deep in the long question → Next → Q2 card back under the sticky header.
  await page.evaluate(() => {
    const card = document.querySelector("[data-testid=question-position]").closest(".scroll-mt-20");
    window.scrollTo(0, card.offsetTop + card.offsetHeight * 0.7);
  });
  await nextButton(page).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === "1");
  g = await geometry(page);
  check(`${label}: Next from deep scroll → Q2 card at its top`, g.card.top >= g.headerBottom - 1 && (g.card.top <= g.headerBottom + 24 || g.atMaxScroll), { cardTop: g.card.top, headerBottom: g.headerBottom, atMax: g.atMaxScroll });

  // The answer given on Q1 before Next is kept (existing save semantics).
  await prevButton(page).click();
  await page.waitForFunction(() => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === "0");
  check(`${label}: Q1 answer kept after Next / Previous`, await option(page, lastLabel).locator("input").isChecked());

  // Mark for Review & Next still marks and advances.
  if (mode === "exam" && device === "desktop") {
    await page.getByRole("button", { name: /Mark for Review & Next/ }).click();
    await page.waitForFunction(() => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === "1");
    const cls = await page.getByRole("button", { name: "Go to question 1", exact: true }).getAttribute("class");
    check(`${label}: Mark for Review & Next → Q2, Q1 marked in the palette`, /color-info/.test(cls || ""), cls);
  }

  // Last question: Submit Test in the bar opens the existing confirm dialog.
  await goToQuestion(page, total);
  g = await geometry(page);
  check(`${label}: last question → bar reads Submit Test, Previous enabled`, /Submit Test/.test(g.buttons[1].text) && !g.buttons[0].disabled && !g.buttons[1].disabled, g.buttons);
  check(`${label}: counter shows ${total} / ${total}`, new RegExp(`^(Question )?${total} / ${total}$`).test(await position(page)), await position(page));
  await nextButton(page).click();
  await page.getByRole("dialog").waitFor({ timeout: 10000 });
  check(`${label}: bar Submit Test opens the confirm dialog`, (await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).count()) === 1);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 10000 });
  check(`${label}: cancelling leaves the attempt running`, page.url().endsWith("/run") && (await page.getByTestId("test-player").count()) === 1);

  // Keyboard: Enter on a focused Previous.
  await prevButton(page).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((t) => document.querySelector("[data-testid=test-player]")?.getAttribute("data-question-index") === String(t - 2), total);
  check(`${label}: keyboard Enter on Previous works`, (await index(page)) === total - 2);

  check(`${label}: no console / hydration errors`, page.errors.length === 0, page.errors.slice(0, 3));
  await ctx.close();
}

const browser = await chromium.launch();
try {
  const examAttempt = await start(browser, F.tokens.nine, "EXAM");
  const practiceAttempt = await start(browser, F.tokens.five, "INSTANT");
  for (const device of Object.keys(DEVICES)) await runDevice(browser, device, F.tokens.nine, examAttempt, "exam");
  for (const device of ["desktop", "phone"]) await runDevice(browser, device, F.tokens.five, practiceAttempt, "practice");
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
