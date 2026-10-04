/**
 * Ask AI + AI Question Variant actions — real browser verification.
 *
 * Drives a LOCAL production build on a DISPOSABLE database with the fixture
 * from scripts/ai-actions-ux-fixture.ts (cached explanations + variants, so
 * no provider key is needed). Per usage state (9 / 5 / 1 / 0 left, paid
 * unlimited, fresh) it checks, in Practice Mode on the player:
 *  - "Correct ✓ / Incorrect" and the two AI actions share one row (wrapping
 *    under it on a phone), the Correct Answer line follows, and there is no
 *    second Ask AI button anywhere;
 *  - the usage label / low-limit nudge / upgrade card / "Unlimited AI";
 *  - the upgrade CTA goes to the existing checkout with the live price;
 *  - every limit decision is the server's: at 0 the buttons still send the
 *    request and the server refuses it (DB ledger unchanged);
 *  - one credit per question no matter how often the two buttons are
 *    clicked, double-clicked or toggled; one usage-status read per page;
 *  - analytics events fire without question text;
 *  - Attempt Review + Saved Questions use the same actions; reduced motion
 *    switches the glow off; no console errors; no sideways scroll.
 *
 *   BASE=http://127.0.0.1:3111 FIXTURE=/path/aiux.json DATABASE_URL=<scratch> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-ai-actions-ux.mjs
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

const manifest = JSON.parse(fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const actionName = (id) => manifest.node[id]?.exportedName ?? id;

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}
const views = (persona) =>
  JSON.parse(
    execFileSync("npx", ["tsx", "scripts/ai-actions-ux-fixture.ts", "views", F.students[persona]], {
      env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
      encoding: "utf8",
    }).trim().split("\n").pop()
  );

async function newContext(browser, token, { device = "desktop", theme, reducedMotion } = {}) {
  const opts =
    device === "phone" ? { ...devices["Pixel 7"] } : device === "tablet" ? { viewport: { width: 820, height: 1180 }, hasTouch: true } : { viewport: { width: 1366, height: 900 } };
  if (reducedMotion) opts.reducedMotion = reducedMotion;
  const ctx = await browser.newContext(opts);
  const cookies = [{ name: "student-session-token", value: token, url: BASE }];
  if (theme) cookies.push({ name: "mts-theme", value: theme, url: BASE });
  await ctx.addCookies(cookies);
  // Record analytics calls whether or not GA is configured on this server.
  await ctx.addInitScript(() => {
    window.__events = [];
    window.gtag = (...args) => window.__events.push(args);
  });
  return ctx;
}
async function newPage(ctx) {
  const page = await ctx.newPage();
  page.errors = [];
  page.actions = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  page.on("request", (r) => {
    const id = r.headers()["next-action"];
    if (r.method() === "POST" && id) page.actions.push(actionName(id));
  });
  return page;
}
const countActions = (page, name) => page.actions.filter((a) => a === name).length;
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const option = (page, label) => page.locator(`[data-testid=option][data-label="${label}"]`);
const usage = (page) => page.locator("[data-testid=ai-usage]").first();
const usageState = async (page) => ((await usage(page).count()) ? await usage(page).getAttribute("data-state") : null);
const usageText = async (page) => ((await usage(page).count()) ? (await usage(page).innerText()).replace(/\s+/g, " ").trim() : "");
const events = (page) =>
  page.evaluate(() => {
    const out = [...(window.__events || [])];
    for (const e of window.dataLayer || []) out.push(Array.from(e));
    return out.filter((e) => e[0] === "event" && /^ai_/.test(e[1])).map((e) => ({ name: e[1], params: e[2] }));
  });
const waitUsage = (page) => page.waitForSelector("[data-testid=ai-usage]", { timeout: 15000 });
const settle = (page) => page.waitForLoadState("networkidle").catch(() => {});

async function startPractice(page) {
  await page.goto(`${BASE}/student/test-series/${F.mockId}`);
  await page.waitForSelector("[data-testid=pre-test-setup]");
  await page.locator('input[name="answerMode"][value="INSTANT"]').check();
  await page.getByRole("button", { name: /Start Test|Practice Again/ }).click();
  await page.waitForURL(/\/run$/, { timeout: 30000 });
  await page.waitForSelector("[data-testid=test-player]");
  return page.url().split("/attempt/")[1].split("/")[0];
}
async function answer(page, index, { wrong = false } = {}) {
  if (index > 0) await page.getByRole("button", { name: `Go to question ${index + 1}`, exact: true }).click();
  const key = F.keys[index];
  const label = wrong ? ["A", "B", "C", "D"].find((l) => l !== key) : key;
  await option(page, label).click();
  await page.waitForSelector("[data-testid=reveal-result]", { timeout: 15000 });
}
async function submit(page) {
  await page.getByRole("button", { name: "Submit Test" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await page.waitForURL(/\/result$/, { timeout: 30000 });
}
async function layout(page) {
  return page.evaluate(() => {
    const r = (el) => el && el.getBoundingClientRect();
    const result = r(document.querySelector("[data-testid=reveal-result]") || document.querySelector("[data-testid=review-answer-header] > p"));
    const ask = r(document.querySelector("[data-testid=ask-ai-button]"));
    const variant = r(document.querySelector("[data-testid=ai-variant-button]"));
    const answerLine = [...document.querySelectorAll("p")].find((p) => /^Correct Answer:/.test(p.textContent.trim()));
    return { result, ask, variant, answer: r(answerLine), vw: window.innerWidth };
  });
}
const mid = (b) => b.top + b.height / 2;

async function main() {
  const browser = await chromium.launch();
  const ckeckoutHref = F.paidProduct ? `/student/checkout/${encodeURIComponent(F.paidProduct.code)}` : "/student/plans";
  try {
    // ------------------------------------------------------------------
    console.log("\n--- A. 9 uses left · desktop · Correct row, label, Ask AI, Variant, toggling ---");
    {
      const ctx = await newContext(browser, F.tokens.nine);
      const page = await newPage(ctx);
      await startPractice(page);
      check("no AI action is fetched before the answer is committed", (await page.locator("[data-testid=ai-actions]").count()) === 0);
      await answer(page, 0);
      await waitUsage(page);
      const tools = page.locator("[data-testid=revealed-review-tools]");
      check("exactly one Ask AI button (old location removed)", (await page.getByRole("button", { name: /Ask AI/ }).count()) === 1);
      check("AI Question Variant is its own button", (await tools.getByRole("button", { name: "AI Question Variant" }).count()) === 1);
      const L = await layout(page);
      check("desktop: Correct ✓ and both AI actions on ONE row", Math.abs(mid(L.result) - mid(L.ask)) < 8 && Math.abs(mid(L.ask) - mid(L.variant)) < 2 && L.ask.left > L.result.right, L);
      check("Correct Answer line sits below that row", L.answer && L.answer.top > L.ask.bottom, L);
      check("verdict reads Correct", /^\s*Correct/.test(await page.locator("[data-testid=reveal-result]").innerText()));
      check("A: label '9 AI uses remaining today' (server value)", (await usageText(page)) === "9 AI uses remaining today" && (await usageState(page)) === "ok", await usageText(page));
      check("A: no upgrade prompt above the low threshold", (await page.locator("[data-testid=ai-upgrade-cta]").count()) === 0);
      check("usage status read exactly once", countActions(page, "getAiUsageStatusAction") === 1, page.actions);
      check("nothing AI-generating fetched before a click", countActions(page, "getExplanationAction") === 0 && countActions(page, "getQuestionVariantsAction") === 0);
      await shot(page, "A-desktop-revealed");

      await page.getByTestId("ask-ai-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept explanation for question 1.");
      check("Ask AI opens the AI Explanation panel", /AI Explanation/.test(await page.getByTestId("ai-panel").innerText()));
      check("Ask AI aria-expanded=true", (await page.getByTestId("ask-ai-button").getAttribute("aria-expanded")) === "true");
      check("A: label now 8 (one credit for a new question)", (await usageText(page)) === "8 AI uses remaining today", await usageText(page));
      check("panel no longer duplicates 'AI Question Variants' as a tab", (await page.getByTestId("ai-panel").getByRole("button", { name: /Question Variant/ }).count()) === 0);
      await shot(page, "A-desktop-ask-ai-open");

      await page.getByTestId("ai-variant-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Variant 1 of question 1");
      const vText = await page.getByTestId("ai-panel").innerText();
      check("AI Question Variant opens the variant view directly (no explanation first)", /AI Question Variant/.test(vText) && /5 unique practice questions/.test(vText), vText.slice(0, 200));
      check("A: same question → still 8 (variants share the question's credit)", (await usageText(page)) === "8 AI uses remaining today", await usageText(page));
      await shot(page, "A-desktop-variant-open");

      // Toggle both views a few times: cached client-side, no new requests.
      for (let i = 0; i < 3; i++) {
        await page.getByTestId("ask-ai-button").click();
        await page.getByTestId("ai-variant-button").click();
        await page.getByTestId("ai-variant-button").click();
      }
      await settle(page);
      check("toggling panels re-fetches nothing", countActions(page, "getExplanationAction") === 1 && countActions(page, "getQuestionVariantsAction") === 1, page.actions);
      const v = views("nine");
      check("A: DB ledger = 1 seeded + 1 new question (no double count)", v.distinct === F.freeDailyLimit - 9 + 1 && v.perQuestion[F.questionIds[0]] === 2, v);

      // Next question: still one status read for the page.
      await answer(page, 1, { wrong: true });
      await waitUsage(page);
      check("Incorrect verdict shares the row too", /Incorrect — correct answer/.test(await page.locator("[data-testid=reveal-result]").innerText()));
      check("paging questions does not re-read usage", countActions(page, "getAiUsageStatusAction") === 1, page.actions);
      check("label carries over (8)", (await usageText(page)) === "8 AI uses remaining today");
      const ev = await events(page);
      const names = ev.map((e) => e.name);
      check("events: ai_ask_clicked, ai_variant_clicked, ai_generation_success", ["ai_ask_clicked", "ai_variant_clicked", "ai_generation_success"].every((n) => names.includes(n)), names);
      const params = ev.find((e) => e.name === "ai_ask_clicked")?.params ?? {};
      check("event params: source_page / subscription_status / remaining_ai_uses", params.source_page === "practice_player" && params.subscription_status === "free" && params.remaining_ai_uses === 9, params);
      check("events carry no question text or ids", !JSON.stringify(ev).match(/AI UX question|nematode|Fixture concept|cmu/i), JSON.stringify(ev).slice(0, 300));
      check("A: no console errors", page.errors.length === 0, page.errors);
      await submit(page);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- B. 5 uses left · low-limit nudge ---");
    {
      const ctx = await newContext(browser, F.tokens.five);
      const page = await newPage(ctx);
      await startPractice(page);
      await answer(page, 0);
      await waitUsage(page);
      const t = await usageText(page);
      check("B: 'Only 5 AI uses remaining today.' + upgrade text", (await usageState(page)) === "low" && /Only 5 AI uses remaining today\./.test(t) && /Upgrade for unlimited AI explanations and AI Question Variants\./.test(t), t);
      const cta = page.locator("[data-testid=ai-upgrade-cta]");
      check("B: non-blocking 'Get Unlimited Access' link to the existing checkout", (await cta.innerText()).trim() === "Get Unlimited Access" && (await cta.getAttribute("href")) === ckeckoutHref, await cta.getAttribute("href"));
      check("B: no modal/dialog shown", (await page.getByRole("dialog").count()) === 0);
      await shot(page, "B-desktop-low");
      await page.getByTestId("ask-ai-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept");
      check("B: still usable at the threshold → 'Only 4'", /Only 4 AI uses remaining today\./.test(await usageText(page)), await usageText(page));
      const ev = (await events(page)).map((e) => e.name);
      check("B: ai_low_limit_shown sent once", ev.filter((n) => n === "ai_low_limit_shown").length === 1, ev);
      check("B: no console errors", page.errors.length === 0, page.errors);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- C. 1 use left → last use → 0 ---");
    {
      const ctx = await newContext(browser, F.tokens.one);
      const page = await newPage(ctx);
      await startPractice(page);
      await answer(page, 0);
      await waitUsage(page);
      check("C: 'Only 1 AI use remaining today.' (singular)", /Only 1 AI use remaining today\./.test(await usageText(page)), await usageText(page));
      await page.getByTestId("ai-variant-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Variant 1 of question 1");
      await page.waitForSelector("[data-testid=ai-usage][data-state=exhausted]");
      const card = await usageText(page);
      check("C: after the last use the strong upgrade card replaces the nudge", /Unlock Unlimited AI/.test(card) && /You've used your daily AI allowance/.test(card) && /Ask AI explanations/.test(card) && /AI Question Variants/.test(card), card);
      check("C: card shows the live product price", F.paidProduct ? /Unlock Unlimited AI\s*— ₹[\d,]+(\.\d{2})?/.test(card) : true, card);
      check("C: the variants just generated stay visible", /Variant 1 of question 1/.test(await page.getByTestId("ai-panel").innerText()));
      // Same question again: free (already counted today) — server allows.
      await page.getByTestId("ask-ai-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept");
      check("C: re-opening an already-counted question at 0 still works (server rule)", true);
      // A NEW question at 0: the server refuses.
      await answer(page, 1);
      await waitUsage(page);
      const before = views("one");
      await page.getByTestId("ask-ai-button").click();
      await page.waitForResponse((r) => r.request().method() === "POST" && actionName(r.request().headers()["next-action"]) === "getExplanationAction");
      await settle(page);
      check("C: new question at 0 → no AI panel, upgrade card stays", (await page.locator("[data-testid=ai-panel]").count()) === 0 && (await usageState(page)) === "exhausted");
      const after = views("one");
      check("C: refused request deducted nothing", after.rows === before.rows && after.distinct === F.freeDailyLimit, { before, after });
      await shot(page, "C-desktop-exhausted");
      check("C: no console errors", page.errors.length === 0, page.errors);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- D. 0 left · server enforcement · upgrade CTA → checkout ---");
    {
      const ctx = await newContext(browser, F.tokens.zero);
      const page = await newPage(ctx);
      await startPractice(page);
      await answer(page, 0);
      await page.waitForSelector("[data-testid=ai-usage][data-state=exhausted]");
      const card = await usageText(page);
      check("D: upgrade card on load", /Unlock Unlimited AI/.test(card) && /Upgrade for Unlimited AI/.test(card), card);
      check("D: no plain 'Daily AI limit reached.' text", !/Daily AI limit reached\./.test(await page.locator("body").innerText()));
      const before = views("zero");
      await page.getByTestId("ask-ai-button").click();
      await page.getByTestId("ai-variant-button").click();
      await settle(page);
      check("D: the buttons still ask the server (UI does not decide)", countActions(page, "getExplanationAction") === 1 && countActions(page, "getQuestionVariantsAction") === 1, page.actions);
      check("D: server refused both — no AI content rendered", (await page.locator("[data-testid=ai-panel]").count()) === 0);
      const after = views("zero");
      check("D: nothing deducted / logged", after.rows === before.rows, { before, after });
      // Tamper with the client: forging a big remaining count changes nothing server-side.
      await page.evaluate(() => {
        try {
          localStorage.setItem("ai-remaining", "999");
        } catch {}
      });
      const refused = page.waitForResponse((r) => r.request().method() === "POST" && actionName(r.request().headers()["next-action"]) === "getExplanationAction");
      await page.getByTestId("ask-ai-button").click();
      await refused;
      await page.waitForTimeout(500);
      check("D: browser state can't unlock AI", (await page.locator("[data-testid=ai-panel]").count()) === 0 && views("zero").rows === before.rows);
      const ev = (await events(page)).map((e) => e.name);
      check("D: ai_limit_reached sent once", ev.filter((n) => n === "ai_limit_reached").length === 1, ev);
      await shot(page, "D-desktop-zero");
      const cta = page.getByTestId("ai-upgrade-cta");
      check("D: CTA → existing checkout route", (await cta.getAttribute("href")) === ckeckoutHref, await cta.getAttribute("href"));
      await cta.click();
      await page.waitForURL(/\/student\/(checkout|plans)/, { timeout: 30000 });
      await settle(page);
      const body = await page.locator("body").innerText();
      check("D: checkout page renders the product + price", /₹/.test(body), body.slice(0, 200));
      const ev2 = (await events(page)).map((e) => e.name);
      check("D: ai_upgrade_clicked sent", ev2.includes("ai_upgrade_clicked"), ev2);
      await shot(page, "D-checkout");
      check("D: no console errors", page.errors.length === 0, page.errors);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- E. paid / unlimited ---");
    {
      const ctx = await newContext(browser, F.tokens.paid);
      const page = await newPage(ctx);
      await startPractice(page);
      await answer(page, 0);
      await waitUsage(page);
      const unlimited = F.paidDailyLimit === null;
      check("E: 'Unlimited AI' label", unlimited ? (await usageState(page)) === "unlimited" && (await usageText(page)) === "Unlimited AI" : true, await usageText(page));
      await page.getByTestId("ask-ai-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept");
      await page.getByTestId("ai-variant-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Variant 1");
      const body = await page.locator("body").innerText();
      check("E: no limit / low-limit / upgrade copy", !/remaining today|limit reached|Upgrade|Unlock Unlimited|Get Unlimited Access/i.test(body));
      check("E: no upgrade CTA", (await page.locator("[data-testid=ai-upgrade-cta]").count()) === 0);
      check("E: still 'Unlimited AI' after use", unlimited ? (await usageText(page)) === "Unlimited AI" : true);
      await shot(page, "E-desktop-unlimited");
      check("E: no console errors", page.errors.length === 0, page.errors);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- Double clicks, resume, review page, saved questions (fresh student) ---");
    let attemptId;
    {
      const ctx = await newContext(browser, F.tokens.fresh);
      const page = await newPage(ctx);
      attemptId = await startPractice(page);
      await answer(page, 0);
      await waitUsage(page);
      check("fresh: 10 left → '10 AI uses remaining today'", (await usageText(page)) === `${F.freeDailyLimit} AI uses remaining today`, await usageText(page));
      await page.getByTestId("ask-ai-button").dblclick();
      await page.getByTestId("ai-variant-button").dblclick();
      await page.waitForSelector("[data-testid=ai-panel]");
      await settle(page);
      check("double-click Ask AI → one request", countActions(page, "getExplanationAction") === 1, page.actions);
      check("double-click Variant → one request", countActions(page, "getQuestionVariantsAction") === 1, page.actions);
      const v = views("fresh");
      check("double clicks + both views → exactly one credit", v.distinct === 1, v);
      check("label 9 after both views of one question", (await usageText(page)) === `${F.freeDailyLimit - 1} AI uses remaining today`, await usageText(page));

      // Save Q1 (for the Saved Questions page) — Save stays in the question header.
      await page.getByRole("button", { name: /^Save/ }).first().click();
      await page.waitForTimeout(800);

      // Resume: reload the attempt — reveal + AI row come back, one status read.
      await page.reload();
      await page.waitForSelector("[data-testid=reveal-result]");
      await waitUsage(page);
      check("resume: revealed answer and AI row restored", (await page.locator("[data-testid=ai-actions]").count()) === 1);
      check("resume: usage still 9 (server value)", (await usageText(page)) === `${F.freeDailyLimit - 1} AI uses remaining today`, await usageText(page));
      check("fresh player: no console errors", page.errors.length === 0, page.errors);
      await submit(page);

      await page.goto(`${BASE}/student/attempt/${attemptId}/review`);
      await page.waitForSelector("[data-testid=review-answer-header]");
      await waitUsage(page);
      const header = page.locator(".border-b").filter({ hasText: /Question 1 of/ }).first();
      check("review: Ask AI removed from the question header", (await header.getByRole("button", { name: /Ask AI/ }).count()) === 0);
      check("review: Save / Report still in the header", (await header.getByRole("button", { name: /Save/ }).count()) === 1 && (await header.getByRole("button", { name: /Report/ }).count()) === 1);
      check("review: exactly one Ask AI + one Variant button", (await page.getByRole("button", { name: /Ask AI/ }).count()) === 1 && (await page.getByRole("button", { name: "AI Question Variant" }).count()) === 1);
      const L = await layout(page);
      check("review desktop: status + AI actions on one row above Correct Answer", Math.abs(mid(L.result) - mid(L.ask)) < 8 && L.answer.top > L.ask.bottom, L);
      await page.getByTestId("ask-ai-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept");
      check("review: Ask AI works (already counted → no new credit)", views("fresh").distinct === 1);
      await page.getByRole("button", { name: /^Next/ }).click();
      check("review: Next swaps question, AI panel reset", (await page.locator("[data-testid=ai-panel]").count()) === 0 && /Question 2 of/.test(await page.locator("body").innerText()));
      await page.getByRole("button", { name: /Previous/ }).click();
      await shot(page, "review-desktop");
      check("review: no console errors", page.errors.length === 0, page.errors);

      await page.goto(`${BASE}/student/saved`);
      await page.waitForSelector("[data-testid=ai-actions]");
      check("saved: both AI actions present", (await page.getByTestId("ask-ai-button").count()) >= 1 && (await page.getByTestId("ai-variant-button").count()) >= 1);
      check("saved: usage not repeated under every card before use", (await page.locator("[data-testid=ai-usage]").count()) === 0);
      await page.getByTestId("ai-variant-button").first().click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Variant 1");
      check("saved: variant view + usage shown for the used question", (await page.locator("[data-testid=ai-usage]").count()) === 1);
      check("saved: no console errors", page.errors.length === 0, page.errors);
      await ctx.close();
    }

    // ------------------------------------------------------------------
    console.log("\n--- F/G. phone · tablet · themes · reduced motion ---");
    for (const [device, theme] of [
      ["phone", "dark"],
      ["phone", "light"],
      ["tablet", "light"],
      ["desktop", "light"],
      ["phone", "eyesaver"],
    ]) {
      const ctx = await newContext(browser, F.tokens.nine, { device, theme });
      const page = await newPage(ctx);
      await page.goto(`${BASE}/student/test-series/${F.mockId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await page.locator('input[name="answerMode"][value="INSTANT"]').check();
      await page.getByRole("button", { name: /Start Test|Practice Again/ }).click();
      await page.waitForURL(/\/run$/, { timeout: 30000 });
      await page.waitForSelector("[data-testid=test-player]");
      await answer(page, 2);
      await waitUsage(page);
      const L = await layout(page);
      const o = await overflow(page);
      const sameRow = Math.abs(mid(L.result) - mid(L.ask)) < 8;
      const wrapped = L.ask.top >= L.result.bottom - 1;
      check(`${device}/${theme}: AI actions beside or cleanly below Correct, inside the viewport`, (sameRow || wrapped) && L.variant.right <= L.vw && L.ask.left >= 0, L);
      check(`${device}/${theme}: Ask AI + Variant fully visible without scrolling sideways`, o <= 1, o);
      const btnH = L.ask.height;
      check(`${device}/${theme}: buttons are tappable (≥ 32px)`, btnH >= 32, btnH);
      await page.getByTestId("ask-ai-button").click();
      await page.waitForSelector("[data-testid=ai-panel] >> text=Fixture concept");
      check(`${device}/${theme}: open panel causes no sideways scroll`, (await overflow(page)) <= 1);
      const anim = await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=ask-ai-button]"), "::after").animationName);
      check(`${device}/${theme}: glow animates (ai-breathe)`, anim === "ai-breathe", anim);
      await shot(page, `FG-${device}-${theme}`);
      check(`${device}/${theme}: no console errors`, page.errors.length === 0, page.errors);
      await submit(page);
      await ctx.close();
    }
    {
      const ctx = await newContext(browser, F.tokens.nine, { device: "phone", reducedMotion: "reduce" });
      const page = await newPage(ctx);
      await page.goto(`${BASE}/student/test-series/${F.mockId}`);
      await page.waitForSelector("[data-testid=pre-test-setup]");
      await page.locator('input[name="answerMode"][value="INSTANT"]').check();
      await page.getByRole("button", { name: /Start Test|Practice Again/ }).click();
      await page.waitForURL(/\/run$/, { timeout: 30000 });
      await answer(page, 3);
      const anim = await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=ask-ai-button]"), "::after").animationName);
      check("prefers-reduced-motion: glow animation off", anim === "none", anim);
      await submit(page);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nALL AI ACTIONS UX CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  if (failures) process.exitCode = 1;
}

main();
