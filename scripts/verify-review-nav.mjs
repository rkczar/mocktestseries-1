/**
 * Attempt Review sticky Previous / Next bar — real browser verification.
 *
 * Drives a LOCAL production build on a DISPOSABLE database seeded by
 * scripts/ai-actions-ux-fixture.ts (20-question FREE Mock with cached AI
 * explanations). Submits one Practice attempt as the "fresh" student, then on
 * /student/attempt/<id>/review at desktop, tablet, phone portrait and phone
 * landscape checks:
 *  - the bar is inside the viewport at the top of the page and while scrolled
 *    deep into a long (Ask AI) explanation;
 *  - it never covers the card: the last line can always scroll clear above it;
 *  - Next / Previous reuse the review's paging (Question N of 20 + "N / 20"),
 *    Previous is disabled on Q1 and Next on Q20 (real `disabled`);
 *  - pressing Next from deep in an explanation brings the new question's
 *    heading back under the sticky header; from the page top it doesn't jump;
 *  - keyboard Enter works, touch targets ≥ 44px on phones, safe-area padding,
 *    no sideways scroll, no console / hydration errors.
 *
 *   BASE=http://127.0.0.1:3111 FIXTURE=/path/aiux.json DATABASE_URL=<scratch> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-review-nav.mjs
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

async function newPage(browser, device) {
  const ctx = await browser.newContext(DEVICES[device]);
  await ctx.addCookies([{ name: "student-session-token", value: F.tokens.fresh, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  return { ctx, page };
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const nav = (page) => page.getByTestId("review-nav");
const position = async (page) => (await page.getByTestId("review-nav-position").innerText()).replace(/\s+/g, " ").trim();
const geometry = (page) =>
  page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect().toJSON();
    const navEl = document.querySelector("[data-testid=review-nav]");
    const card = navEl.previousElementSibling;
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
      buttons: [...navEl.querySelectorAll("button")].map((b) => ({ h: b.getBoundingClientRect().height, disabled: b.disabled, label: b.getAttribute("aria-label") })),
    };
  });

async function submitAttempt(browser) {
  const { ctx, page } = await newPage(browser, "desktop");
  await page.goto(`${BASE}/student/test-series/${F.mockId}`);
  await page.waitForSelector("[data-testid=pre-test-setup]");
  await page.locator('input[name="answerMode"][value="INSTANT"]').check();
  await page.getByRole("button", { name: /Start Test|Practice Again/ }).click();
  await page.waitForURL(/\/run$/, { timeout: 30000 });
  await page.waitForSelector("[data-testid=test-player]");
  const attemptId = page.url().split("/attempt/")[1].split("/")[0];
  await page.locator(`[data-testid=option][data-label="${F.keys[0]}"]`).click();
  await page.waitForSelector("[data-testid=reveal-result]", { timeout: 15000 });
  await page.getByRole("button", { name: "Submit Test" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await page.waitForURL(/\/result$/, { timeout: 30000 });
  await ctx.close();
  return attemptId;
}

async function runDevice(browser, device, attemptId) {
  console.log(`\n--- ${device} ---`);
  const { ctx, page } = await newPage(browser, device);
  await page.goto(`${BASE}/student/attempt/${attemptId}/review`);
  await page.waitForSelector("[data-testid=review-nav]");
  await page.waitForLoadState("networkidle").catch(() => {});
  const total = F.keys.length;

  let g = await geometry(page);
  check(`${device}: bar visible at page top without scrolling`, g.nav.bottom <= g.vh + 0.5 && g.nav.top >= 0, g.nav);
  check(`${device}: counter shows 1 / ${total}`, new RegExp(`^(Question )?1 / ${total}$`).test(await position(page)), await position(page));
  check(`${device}: Q1 → Previous really disabled`, g.buttons[0].disabled === true && g.buttons[1].disabled === false, g.buttons);
  check(`${device}: accessible labels`, g.buttons[0].label === "Previous question" && g.buttons[1].label === "Next question", g.buttons);
  check(`${device}: no sideways scroll`, g.overflow <= 0, g.overflow);
  check(`${device}: bar inside viewport horizontally`, g.bar.left >= 0 && g.bar.right <= g.vw, g.bar);
  if (device === "phone" || device === "landscape") {
    check(`${device}: touch targets ≥ 44px`, g.buttons.every((b) => b.h >= 44), g.buttons);
  }
  const pad = await nav(page).evaluate((el) => el.style.paddingBottom);
  check(`${device}: safe-area bottom padding`, /safe-area-inset-bottom/.test(pad), pad);

  // Next from the very top must not jump the page.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "Next question" }).click();
  await page.waitForFunction(() => /Question 2 of/.test(document.body.innerText));
  g = await geometry(page);
  check(`${device}: Next from top → Q2, no jump`, g.scrollY === 0 && /^(Question )?2 \//.test(await position(page)), { y: g.scrollY, pos: await position(page) });
  await page.getByRole("button", { name: "Previous question" }).click();
  await page.waitForFunction(() => /Question 1 of/.test(document.body.innerText));

  // Long explanation: open Ask AI (cached fixture explanation).
  await page.getByTestId("ask-ai-button").click();
  await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept", { timeout: 20000 });
  check(`${device}: Ask AI still works on review`, (await page.locator("[data-testid=ai-panel]").count()) === 1);
  // Make sure the card is long, like a real long explanation.
  await page.evaluate(() => {
    const p = document.querySelector("[data-testid=ai-panel]");
    const filler = document.createElement("p");
    filler.dataset.testid = "filler";
    filler.textContent = "Long explanation line. ".repeat(400) + "FINAL-LINE";
    p.appendChild(filler);
  });

  // Mid-explanation: bar pinned to the viewport bottom.
  await page.evaluate(() => {
    const card = document.querySelector("[data-testid=review-nav]").previousElementSibling;
    window.scrollTo(0, card.offsetTop + card.offsetHeight / 2);
  });
  g = await geometry(page);
  check(`${device}: mid-explanation → bar pinned to viewport bottom`, Math.abs(g.nav.bottom - g.vh) < 1.5, { navBottom: g.nav.bottom, vh: g.vh });
  await shot(page, `${device}-mid-explanation`);

  // End of explanation: the last line scrolls fully clear above the bar.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const last = await page.evaluate(() => {
    const navEl = document.querySelector("[data-testid=review-nav]");
    const card = navEl.previousElementSibling;
    const f = document.querySelector("[data-testid=filler]");
    return { cardBottom: card.getBoundingClientRect().bottom, fillerBottom: f.getBoundingClientRect().bottom, navTop: navEl.getBoundingClientRect().top };
  });
  check(`${device}: last line of explanation never under the bar`, last.fillerBottom <= last.navTop && last.cardBottom <= last.navTop, last);
  // Scroll so the card's end sits just above the bar — must be reachable (bar not overlapping).
  await page.evaluate(() => {
    const navEl = document.querySelector("[data-testid=review-nav]");
    const card = navEl.previousElementSibling;
    window.scrollBy(0, card.getBoundingClientRect().bottom - (window.innerHeight - navEl.offsetHeight));
  });
  const edge = await page.evaluate(() => {
    const navEl = document.querySelector("[data-testid=review-nav]");
    const f = document.querySelector("[data-testid=filler]");
    const r = f.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + 4, r.bottom - 4);
    return { fillerBottom: r.bottom, navTop: navEl.getBoundingClientRect().top, hitIsNav: !!hit?.closest("[data-testid=review-nav]") };
  });
  check(`${device}: final line readable (not hit-tested as the bar)`, edge.fillerBottom <= edge.navTop + 0.5 && !edge.hitIsNav, edge);
  await shot(page, `${device}-end-of-explanation`);

  // Deep in the explanation → Next → Q2 heading back under the sticky header.
  await page.evaluate(() => {
    const card = document.querySelector("[data-testid=review-nav]").previousElementSibling;
    window.scrollTo(0, card.offsetTop + card.offsetHeight * 0.7);
  });
  await page.getByRole("button", { name: "Next question" }).click();
  await page.waitForFunction(() => /Question 2 of/.test(document.body.innerText));
  g = await geometry(page);
  // A short next question on a tall screen can't scroll its card all the way up — then the page must at least be at its scroll limit.
  check(`${device}: Next from deep scroll → Q2 opens at its top`, g.card.top >= g.headerBottom - 1 && (g.card.top <= g.headerBottom + 24 || g.atMaxScroll), { cardTop: g.card.top, headerBottom: g.headerBottom, atMax: g.atMaxScroll });
  check(`${device}: Ask AI panel reset on question change`, (await page.locator("[data-testid=ai-panel]").count()) === 0);
  check(`${device}: counter updated to 2`, /^(Question )?2 \//.test(await position(page)), await position(page));
  await shot(page, `${device}-after-next`);

  // Previous from deep scroll as well.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.getByRole("button", { name: "Previous question" }).click();
  await page.waitForFunction(() => /Question 1 of/.test(document.body.innerText));
  g = await geometry(page);
  check(`${device}: Previous → Q1 at its top, Previous disabled again`, g.buttons[0].disabled && g.card.top >= g.headerBottom - 1 && (g.card.top <= g.headerBottom + 24 || g.atMaxScroll), { b: g.buttons, cardTop: g.card.top });

  // Keyboard: Enter on the focused Next button.
  await page.getByRole("button", { name: "Next question" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /Question 2 of/.test(document.body.innerText));
  check(`${device}: keyboard Enter on Next works`, true);

  // Walk to the last question; Next disables there, index never overruns.
  for (let i = 2; i < total; i++) await page.getByRole("button", { name: "Next question" }).click();
  await page.waitForFunction((n) => document.body.innerText.includes(`Question ${n} of ${n}`), total);
  g = await geometry(page);
  check(`${device}: last question → Next really disabled`, g.buttons[1].disabled === true && g.buttons[0].disabled === false, g.buttons);
  check(`${device}: counter ${total} / ${total}`, new RegExp(`^(Question )?${total} / ${total}$`).test(await position(page)), await position(page));
  await page.getByRole("button", { name: "Next question" }).click({ force: true }).catch(() => {});
  check(`${device}: forced click on disabled Next stays on ${total}`, (await page.locator("body").innerText()).includes(`Question ${total} of ${total}`));

  check(`${device}: no console / hydration errors`, page.errors.length === 0, page.errors);
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch();
  try {
    const attemptId = await submitAttempt(browser);
    console.log(`submitted attempt ${attemptId}`);
    for (const d of ["desktop", "tablet", "phone", "landscape"]) await runDevice(browser, d, attemptId);
  } finally {
    await browser.close();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
