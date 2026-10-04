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
 * Mobile card layout (360 / 375 / 390 / 412 / 430 px, short and very long
 * question + options): header → question → options → result → Correct Answer
 * (one uninterrupted block) → Ask AI | AI Question Variant (+ usage) → Save |
 * Report → Share on WhatsApp → AI panel. Tools render once, not in the header;
 * Theme / Text Size appear once (global header only); nothing clips or
 * overflows; the whole card scrolls fully clear of the bar; opening Ask AI or
 * the Variant never moves the buttons, the panel opens below Share and is
 * scrolled into view; Save and Report still work. At desktop the tools stay in
 * the header band and the AI row sits beside Correct / Incorrect, as before.
 * Needs the scratch DB's `question.whatsapp_share` Setting enabled.
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
  await page.waitForTimeout(900); // phone auto-scrolls to the opened panel
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

async function mobileLayout(browser, width, attemptId, long) {
  const tag = `${width}px ${long ? "long" : "short"}`;
  const ctx = await browser.newContext({ ...devices["Pixel 7"], viewport: { width, height: 800 } });
  await ctx.addCookies([{ name: "student-session-token", value: F.tokens.fresh, url: BASE }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${BASE}/student/attempt/${attemptId}/review`);
  await page.waitForSelector("[data-testid=review-question-tools]");
  await page.waitForLoadState("networkidle").catch(() => {});
  if (long) {
    await page.evaluate(() => {
      const card = document.querySelector("[data-testid=review-nav]").previousElementSibling;
      const qp = card.querySelector("p.whitespace-pre-wrap");
      qp.textContent = "A 34-year-old presents with progressive dyspnoea, ".repeat(25) + "Supercalifragilisticexpialidocious-unbroken-token-" + "x".repeat(60);
      card.querySelectorAll("[data-testid=review-options] > div").forEach((o, i) => {
        o.firstChild.nextSibling.textContent = ` Option ${i + 1}: ` + "a very long distractor describing a management step in detail, ".repeat(6);
      });
    });
  }
  const L = await page.evaluate(() => {
    const r = (el) => el && el.getBoundingClientRect().toJSON();
    const card = document.querySelector("[data-testid=review-nav]").previousElementSibling.firstElementChild;
    const tools = card.querySelector("[data-testid=review-question-tools]");
    const header = card.firstElementChild;
    const btn = (re) => [...tools.querySelectorAll("button,a")].find((b) => re.test(b.textContent.trim()));
    const answerLine = [...card.querySelectorAll("p")].find((p) => /^Correct Answer:/.test(p.textContent.trim()));
    const clipped = [...card.querySelectorAll("button,a")].filter((b) => b.scrollWidth > b.clientWidth + 1 || b.getBoundingClientRect().right > window.innerWidth || b.getBoundingClientRect().left < 0).map((b) => b.textContent.trim());
    return {
      vw: window.innerWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      header: r(header),
      headerHasTools: header.contains(tools) || !!header.querySelector("button"),
      question: r(card.querySelector("p.whitespace-pre-wrap")),
      questionFont: parseFloat(getComputedStyle(card.querySelector("p.whitespace-pre-wrap")).fontSize),
      options: r(card.querySelector("[data-testid=review-options]")),
      result: r(card.querySelector("[data-testid=review-answer-header] > p")),
      ai: r(card.querySelector("[data-testid=ask-ai-button]")),
      usage: r(card.querySelector("[data-testid=ai-usage]")),
      themeVisible: [...document.querySelectorAll("button[aria-label*='Switch to']")].filter((b) => b.offsetParent !== null).length,
      textSizeVisible: [...document.querySelectorAll("button[aria-label^='Text size']")].filter((b) => b.offsetParent !== null).length,
      variant: r(card.querySelector("[data-testid=ai-variant-button]")),
      answer: r(answerLine),
      tools: r(tools),
      save: r(btn(/^Save/)),
      report: r(btn(/^Report/)),
      share: r(btn(/WhatsApp/)),
      toolsCount: document.querySelectorAll("[data-testid=review-question-tools]").length,
      navCount: document.querySelectorAll("[data-testid=review-nav]").length,
      clipped,
    };
  });
  check(`${tag}: no sideways scroll`, L.overflow <= 0, L.overflow);
  check(`${tag}: no clipped / off-screen buttons`, L.clipped.length === 0, L.clipped);
  check(`${tag}: one tools group, one nav bar`, L.toolsCount === 1 && L.navCount === 1, L);
  check(`${tag}: header holds no Save/Report/Share`, !L.headerHasTools);
  check(`${tag}: Theme + Text Size shown once (global header)`, L.themeVisible === 1 && L.textSizeVisible === 1, [L.themeVisible, L.textSizeVisible]);
  check(
    `${tag}: order header → question → options → result → Correct Answer → AI → tools`,
    L.header.bottom <= L.question.top && L.question.bottom <= L.options.top && L.options.bottom <= L.result.top && L.result.bottom <= L.answer.top && L.answer.bottom <= L.ai.top && L.ai.bottom <= L.tools.top,
    L
  );
  check(`${tag}: nothing between options and Correct Answer but the result line`, L.answer.top - L.options.bottom < L.result.height + 32, { gap: L.answer.top - L.options.bottom });
  check(`${tag}: usage stays with the AI actions, above Save/Report`, !L.usage || (L.usage.top >= L.ai.bottom && L.usage.bottom <= L.tools.top), L.usage);
  check(`${tag}: Ask AI + Variant side by side`, Math.abs(L.ai.top - L.variant.top) < 1 && L.variant.left > L.ai.right, { ai: L.ai, variant: L.variant });
  check(`${tag}: Save + Report side by side, Share full width below`, Math.abs(L.save.top - L.report.top) < 1 && L.share && L.share.top >= L.save.bottom && L.share.width > L.save.width * 1.6, { save: L.save, report: L.report, share: L.share });
  check(`${tag}: tool buttons ≥ 40px tall`, L.save.height >= 40 && L.report.height >= 40 && L.share.height >= 40, [L.save.height, L.report.height, L.share.height]);
  check(`${tag}: larger question text (≥ 17px)`, L.questionFont >= 16.9, L.questionFont);

  // Bar visible at the top; scroll to the end → tools fully clear of the bar.
  const vis = await page.evaluate(() => document.querySelector("[data-testid=review-nav]").getBoundingClientRect().bottom <= window.innerHeight + 0.5);
  check(`${tag}: Previous/Next visible without scrolling`, vis);
  await page.evaluate(() => {
    const navEl = document.querySelector("[data-testid=review-nav]");
    const tools = document.querySelector("[data-testid=review-question-tools]");
    window.scrollBy(0, tools.getBoundingClientRect().bottom - (window.innerHeight - navEl.offsetHeight));
  });
  const end = await page.evaluate(() => {
    const navEl = document.querySelector("[data-testid=review-nav]");
    const share = [...document.querySelectorAll("[data-testid=review-question-tools] a")].find((a) => /WhatsApp/.test(a.textContent));
    const r = share.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 3);
    return { shareBottom: r.bottom, navTop: navEl.getBoundingClientRect().top, hitIsShare: !!hit?.closest("a") && hit.closest("a") === share };
  });
  check(`${tag}: Share (last tool) scrolls fully clear of the bar and is tappable`, end.shareBottom <= end.navTop + 0.5 && end.hitIsShare, end);
  if (long) {
    // Mid-question: the bar stays pinned while the long question is read.
    await page.evaluate(() => window.scrollTo(0, 300));
    const pinned = await page.evaluate(() => Math.abs(document.querySelector("[data-testid=review-nav]").getBoundingClientRect().bottom - window.innerHeight) < 1.5);
    check(`${tag}: bar pinned while reading the long question`, pinned);
  }
  await shot(page, `mobile-${width}-${long ? "long" : "short"}`);

  if (width === 390 && !long) {
    // Functionality intact from the new spot.
    const tools = page.getByTestId("review-question-tools");
    const saveBtn = tools.getByRole("button", { name: /^Save/ });
    const before = (await saveBtn.innerText()).trim();
    await saveBtn.click();
    await page.waitForFunction((b) => {
      const t = [...document.querySelectorAll("[data-testid=review-question-tools] button")].find((x) => /^Save/.test(x.textContent.trim()));
      return t && t.textContent.trim() !== b && !t.disabled;
    }, before);
    check(`${tag}: Save toggles from the bottom tools`, true);
    await tools.getByRole("button", { name: /^Save/ }).click(); // restore
    await page.waitForTimeout(800);
    await tools.getByRole("button", { name: "Report" }).click();
    check(`${tag}: Report dialog opens`, await page.getByRole("dialog").isVisible());
    await page.keyboard.press("Escape");
    check(`${tag}: Share link is a wa.me link`, /wa\.me|whatsapp/.test((await tools.locator("a").getAttribute("href")) ?? ""));
  }
  // AI panels open BELOW the whole action area; the buttons never move.
  await page.evaluate(() => window.scrollTo(0, 0));
  const pos = () =>
    page.evaluate(() => {
      const y = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.getBoundingClientRect().top + window.scrollY : null;
      };
      const panel = document.querySelector("[data-testid=ai-panel]");
      const tools = document.querySelector("[data-testid=review-question-tools]");
      const navTop = document.querySelector("[data-testid=review-nav]").getBoundingClientRect().top;
      return {
        ai: y("[data-testid=ask-ai-button]"),
        save: y("[data-testid=review-question-tools] button"),
        toolsBottom: tools.getBoundingClientRect().bottom + window.scrollY,
        panelTop: panel ? panel.getBoundingClientRect().top + window.scrollY : null,
        panelInView: panel ? panel.getBoundingClientRect().top < navTop && panel.getBoundingClientRect().bottom > 0 : false,
        panelLabel: panel ? panel.querySelector(".ai-heading")?.textContent.trim() : null,
      };
    });
  const before = await pos();
  await page.getByTestId("ask-ai-button").click();
  await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept", { timeout: 20000 });
  await page.waitForTimeout(900); // smooth scroll settles
  let after = await pos();
  check(`${tag}: Ask AI → buttons did not move`, Math.abs(after.ai - before.ai) < 1 && Math.abs(after.save - before.save) < 1, { before, after });
  check(`${tag}: Ask AI → explanation below Save/Report/Share`, after.panelTop >= after.toolsBottom, after);
  check(`${tag}: Ask AI → explanation scrolled into view`, after.panelInView, after);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByTestId("ai-variant-button").click();
  await page.waitForFunction(() => /AI Question Variant/.test(document.querySelector("[data-testid=ai-panel] .ai-heading")?.textContent ?? ""), null, { timeout: 20000 });
  await page.waitForTimeout(900);
  after = await pos();
  check(`${tag}: Variant → buttons did not move`, Math.abs(after.ai - before.ai) < 1 && Math.abs(after.save - before.save) < 1, { before, after });
  check(`${tag}: Variant → content below Save/Report/Share`, after.panelLabel === "AI Question Variant" && after.panelTop >= after.toolsBottom, after);
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`${tag}: no sideways scroll with AI panel open`, ov <= 0, ov);
  // End of the AI panel scrolls clear of the bar.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const tail = await page.evaluate(() => ({
    panelBottom: document.querySelector("[data-testid=ai-panel]").getBoundingClientRect().bottom,
    navTop: document.querySelector("[data-testid=review-nav]").getBoundingClientRect().top,
  }));
  check(`${tag}: AI panel end never under the bar`, tail.panelBottom <= tail.navTop + 0.5, tail);
  await shot(page, `mobile-${width}-${long ? "long" : "short"}-variant`);

  check(`${tag}: no console / hydration errors`, errors.length === 0, errors);
  await ctx.close();
}

async function desktopLayout(browser, attemptId) {
  const { ctx, page } = await newPage(browser, "desktop");
  await page.goto(`${BASE}/student/attempt/${attemptId}/review`);
  await page.waitForSelector("[data-testid=review-question-tools]");
  const L = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect().toJSON();
    const card = document.querySelector("[data-testid=review-nav]").previousElementSibling.firstElementChild;
    const header = card.firstElementChild;
    const tools = card.querySelector("[data-testid=review-question-tools]");
    const q = card.querySelector("p.whitespace-pre-wrap");
    const opt = card.querySelector("[data-testid=review-options] > div");
    const ah = card.querySelector("[data-testid=review-answer-header]");
    const answerLine = [...card.querySelectorAll("p")].find((p) => /^Correct Answer:/.test(p.textContent.trim()));
    return { header: r(header), tools: r(tools), q: r(q), qFont: getComputedStyle(q).fontSize, qLh: getComputedStyle(q).lineHeight, optFont: getComputedStyle(opt).fontSize, optLh: getComputedStyle(opt).lineHeight, card: r(card), ah: r(ah), ai: r(card.querySelector("[data-testid=ask-ai-button]")), result: r(ah.querySelector("p")), answer: r(answerLine), themeVisible: [...document.querySelectorAll("button[aria-label*='Switch to']")].filter((b) => b.offsetParent !== null).length, btnH: [...tools.querySelectorAll("button")].map((b) => b.getBoundingClientRect().height) };
  });
  console.log("  desktop layout", JSON.stringify({ qFont: L.qFont, qLh: L.qLh, optFont: L.optFont, optLh: L.optLh, btnH: L.btnH }));
  check("desktop: tools in the header band, right side, same row", Math.abs(L.tools.top - L.header.top) < 1 && Math.abs(L.tools.bottom - L.header.bottom) < 1 && L.tools.right <= L.card.right && L.tools.left > L.header.left, L);
  check("desktop: tools above the question", L.tools.bottom <= L.q.top);
  check("desktop: AI actions on the Correct/Incorrect row, Correct Answer below", Math.abs(L.ai.top + L.ai.height / 2 - (L.result.top + L.result.height / 2)) < 8 && L.ai.right <= L.card.right && L.answer.top >= L.ah.bottom, L);
  check("desktop: page controls (Theme / Text Size) still shown beside Back", L.themeVisible === 2, L.themeVisible);
  check("desktop: question/option type unchanged (15px / 14px, sm Save/Report)", L.qFont === "15px" && L.optFont === "14px" && L.btnH.every((h) => h === 32), L);
  await shot(page, "desktop-layout");
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch();
  try {
    const attemptId = await submitAttempt(browser);
    console.log(`submitted attempt ${attemptId}`);
    for (const d of ["desktop", "tablet", "phone", "landscape"]) await runDevice(browser, d, attemptId);
    console.log("\n--- mobile card layout ---");
    for (const w of [360, 375, 390, 412, 430]) for (const long of [false, true]) await mobileLayout(browser, w, attemptId, long);
    console.log("\n--- desktop card layout ---");
    await desktopLayout(browser, attemptId);
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
