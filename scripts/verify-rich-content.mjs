/**
 * NEET Phase 1 — rich content in a real browser (desktop + phone), against a
 * local production build on a DISPOSABLE database.
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-rich-content.ts setup > /tmp/rc.json
 *   BASE=http://localhost:3111 FIXTURE=/tmp/rc.json [ADMIN_USER=… ADMIN_PASS=…] [SHOTS=<dir>] \
 *     NODE_PATH=/root/.claude/skills/gstack/node_modules node scripts/verify-rich-content.mjs
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-rich-content.ts cleanup /tmp/rc.json
 *
 * Covers: KaTeX/mhchem rendering in the Test Player, Review, Saved Questions
 * and the admin preview; PLAIN text shown literally; no script execution;
 * no correctLabel / explanation in the raw player HTML before reveal; the
 * Practice Mode reveal releasing the explanation; long equations on a phone
 * (no page-level horizontal scroll); the KaTeX stylesheet only on pages with
 * rich content; and a 180-question RICH vs PLAIN paper (transfer size,
 * load time, navigation, JS heap).
 */
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const { Client } = require("pg");

const BASE = process.env.BASE ?? "http://localhost:3111";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ORDER = Object.keys(F.ids); // creation order = paper order
const idx = (key) => ORDER.indexOf(key);
const SENT = F.sentinel;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
}
const info = (msg) => console.log(`INFO  ${msg}`);

const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, "") });
await db.connect();
/** One Active Test Device: hand an attempt's lease back before a NEW browser context opens it. */
const releaseLease = (attemptId) => db.query(`update "TestAttempt" set "activeDeviceId" = null, "activeSeenAt" = null where id = $1`, [attemptId]);

const browser = await chromium.launch();

async function newPage({ mobile = false, dark = false } = {}) {
  const ctx = await browser.newContext({
    ...(mobile ? { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } } : { viewport: { width: 1366, height: 900 } }),
    colorScheme: dark ? "dark" : "light",
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.mobile = mobile;
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on("dialog", (d) => {
    page.errors.push(`dialog: ${d.message()}`);
    d.dismiss();
  });
  return page;
}

async function login(page, email) {
  // Each new browser context is a new device; the app's device limit would refuse a third one.
  await db.query(`delete from "StudentDevice" where "studentId" in (select id from "Student" where email = $1)`, [email]);
  await db.query(`delete from "StudentLoginAttempt" where identifier = $1`, [email]);
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  await page.waitForLoadState("load");
}

/** Raw server HTML of a page (in-page fetch keeps the Secure device cookie). */
const rawHtml = (page, url) =>
  page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "same-origin" });
    return { status: r.status, body: await r.text() };
  }, url);

async function openRun(page, attemptId) {
  await page.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await page.locator("[data-testid=test-player]").waitFor({ timeout: 30000 });
}
async function goToQuestion(page, i) {
  if (page.mobile) {
    // Navigation is local state: step with Next / Save & Next from the current position.
    const pos = async () => Number(((await page.locator("[data-testid=question-position]").first().textContent()) ?? "").match(/\d+/)?.[0] ?? 1) - 1;
    for (let guard = 0; guard < 400 && (await pos()) !== i; guard++) {
      const here = await pos();
      if (here < i) await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
      else await page.getByRole("button", { name: /Previous/ }).first().click();
    }
  } else {
    await page.locator(`[data-testid=palette] button[aria-label="Go to question ${i + 1}"]`).click();
  }
  await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(String(n)), i + 1);
}
const questionText = (page) => page.locator("[data-testid=test-player] p.text-question").first();
const katexStylesheetLoaded = (page) =>
  page.evaluate(() => {
    const link = [...document.querySelectorAll('link[rel=stylesheet]')].find((l) => l.getAttribute("href")?.includes("/vendor/katex-"));
    const k = document.querySelector(".katex");
    return { link: !!link, font: k ? getComputedStyle(k).fontFamily : null };
  });
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

try {
  // ------------------------------------------------------------------------
  console.log("R1 Exam Mode player (desktop): rendering, no leaks, no script execution");
  {
    const page = await newPage();
    await login(page, F.students.exam.email);
    const raw = await rawHtml(page, `${BASE}/student/attempt/${F.examAttemptId}/run`);
    check("raw player HTML loads", raw.status === 200, raw.status);
    check("raw player HTML has no explanation sentinel", !raw.body.includes(SENT));
    check("raw player HTML has no correctLabel", !raw.body.includes("correctLabel"));
    check("raw player HTML carries server-rendered KaTeX (no client math runtime needed)", raw.body.includes("katex"));
    check("no KaTeX JavaScript chunk is referenced", !/katex[^"']*\.js/i.test(raw.body));

    await openRun(page, F.examAttemptId);
    // Q1 PLAIN: literal.
    const plainText = await questionText(page).innerText();
    check("PLAIN question shows $, \\ce{}, LaTeX and HTML literally", plainText.includes("Cost is $5 and $10; $$x$$ \\ce{H2O} \\frac{1}{2} <b>bold</b> <script>window.__xss=9</script> & 2 < 3"), plainText.slice(0, 160));
    check("PLAIN question has no KaTeX markup", (await questionText(page).locator(".katex").count()) === 0);
    check("legacy question image rendered from Question.imageUrl", (await page.locator('img[src="/storage/question-images/legacy-plain-fixture.webp"]').count()) === 1);
    check("legacy option image rendered from QuestionOption.imageUrl", (await page.locator('img[src="/storage/question-images/legacy-opt-a.webp"]').count()) === 1);
    check("PLAIN-only screen has no KaTeX stylesheet yet", !(await katexStylesheetLoaded(page)).link);

    await goToQuestion(page, idx("physics"));
    const physKatex = await questionText(page).locator(".katex").count();
    check("Physics question renders KaTeX formulas", physKatex >= 8, physKatex);
    check("display equation present", (await questionText(page).locator(".katex-display").count()) === 1);
    const optKatex = await page.locator("[data-testid=option]").evaluateAll((els) => els.map((e) => e.querySelectorAll(".katex").length));
    check("formulas inside all 4 options", optKatex.length === 4 && optKatex.every((n) => n >= 1), optKatex);
    const css = await katexStylesheetLoaded(page);
    check("self-hosted KaTeX stylesheet attached and applied", css.link && /KaTeX_Main/.test(css.font ?? ""), css);
    await page.evaluate(() => document.fonts.ready);
    check("KaTeX web fonts loaded", await page.evaluate(() => [...document.fonts].some((f) => f.family.includes("KaTeX") && f.status === "loaded")));
    await shot(page, "desktop-physics");

    await goToQuestion(page, idx("chemistry"));
    const chem = await questionText(page).innerText();
    check("mhchem equation rendered (→, ⇌ glyphs visible)", (await questionText(page).locator(".katex").count()) >= 6 && /→/.test(chem), chem.slice(0, 200));
    check("chemistry inside options", (await page.locator("[data-testid=option] .katex").count()) === 4);
    await shot(page, "desktop-chemistry");

    await goToQuestion(page, idx("malformed"));
    check("malformed question renders (no crash, error shown inline)", (await questionText(page).locator(".katex-error").count()) >= 1 && (await page.locator("[data-testid=option]").count()) === 4);
    await shot(page, "desktop-malformed");

    await goToQuestion(page, idx("security"));
    const xss = await page.evaluate(() => window.__xss ?? null);
    check("no injected script ran (window.__xss unset)", xss === null, xss);
    check("no <a>/<script>/<img onerror> created from content", (await questionText(page).locator("a, script, img").count()) === 0);
    check("tags shown as text", (await questionText(page).innerText()).includes("<script>window.__xss=1</script>"));

    await goToQuestion(page, idx("organic"));
    const imgs = await page.locator("[data-testid=test-player] [data-testid=question-media] img").evaluateAll((els) =>
      els.map((e) => ({ alt: e.getAttribute("alt"), w: e.getAttribute("width"), h: e.getAttribute("height"), src: e.getAttribute("src"), plate: e.className.includes("bg-white") }))
    );
    check("question image + 4 option images (alt, width, height, /media/ URL, dark-mode plate)", imgs.length === 5 && imgs.every((i) => i.alt && i.w && i.h && i.src.startsWith("/media/q/") && i.plate), imgs);
    check("option images sit inside their option", (await page.locator('[data-testid=option][data-label="C"] img[alt="Structure C: diethyl ether"]').count()) === 1);

    await goToQuestion(page, idx("explained"));
    check("EXPLANATION images are not shown in the running test", (await page.locator('img[alt^="Ray diagram"]').count()) === 0);
    check("no human explanation in Exam Mode", (await page.locator("[data-testid=human-explanation]").count()) === 0);

    // Answer + navigation still behave.
    await goToQuestion(page, idx("physics"));
    await page.locator('[data-testid=option][data-label="A"] input').check();
    await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
    await page.reload();
    await page.locator("[data-testid=test-player]").waitFor();
    await goToQuestion(page, idx("physics"));
    check("selection on a RICH question persists across reload", await page.locator('[data-testid=option][data-label="A"] input').isChecked());
    check("R1 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("R2 Phone 360px (dark): long equations, layout");
  {
    await releaseLease(F.examAttemptId);
    const page = await newPage({ mobile: true, dark: true });
    await login(page, F.students.exam.email);
    await openRun(page, F.examAttemptId);
    await goToQuestion(page, idx("long"));
    check("no page-level horizontal scroll with a long equation", await noHorizontalScroll(page));
    const box = await page.locator(".rich-math-display").first().evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
    check("the long display equation scrolls inside its own box", box.sw > box.cw && box.ox === "auto", box);
    const inline = await questionText(page).locator(".rich-math").last().evaluate((el) => ({ w: el.getBoundingClientRect().width, vw: window.innerWidth }));
    check("long inline formula fits the screen width", inline.w <= inline.vw, inline);
    await shot(page, "mobile-long-equation-dark");
    await goToQuestion(page, idx("physics"));
    check("physics on phone: no horizontal scroll", await noHorizontalScroll(page));
    await shot(page, "mobile-physics-dark");
    await goToQuestion(page, idx("organic"));
    check("images on phone: no horizontal scroll", await noHorizontalScroll(page));
    const color = await page.evaluate(() => {
      const k = document.querySelector(".katex");
      return k ? getComputedStyle(k).color : null;
    });
    info(`dark-mode KaTeX text color: ${color}`);
    check("R2 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("R3 Practice Mode: reveal releases answer + explanation (only then)");
  {
    const page = await newPage();
    await login(page, F.students.practice.email);
    const before = await rawHtml(page, `${BASE}/student/attempt/${F.practiceAttemptId}/run`);
    check("before any reveal: no explanation / correctLabel in raw HTML", !before.body.includes(SENT) && !before.body.includes("correctLabel"));
    await openRun(page, F.practiceAttemptId);
    await goToQuestion(page, idx("physics"));
    check("no explanation before the tap", (await page.locator("[data-testid=human-explanation]").count()) === 0);
    await page.locator('[data-testid=option][data-label="B"] input').click();
    await page.locator("[data-testid=reveal-result]").waitFor({ timeout: 15000 });
    const expl = page.locator("[data-testid=human-explanation]");
    await expl.waitFor({ timeout: 15000 });
    check("explanation appears after the server reveal", (await expl.innerText()).includes(`${SENT}-${F.suffix}-physics`));
    check("explanation math rendered (inline + display)", (await expl.locator(".katex").count()) >= 3 && (await expl.locator(".katex-display").count()) === 1);
    check("correct-answer line renders the option formula", (await page.locator("[data-testid=revealed-review-tools] .katex").count()) >= 1);
    await shot(page, "desktop-practice-reveal");

    await goToQuestion(page, idx("explained"));
    await page.locator('[data-testid=option][data-label="A"] input').click();
    await page.locator("[data-testid=human-explanation]").waitFor({ timeout: 15000 });
    const eimgs = await page.locator("[data-testid=human-explanation] img").evaluateAll((els) => els.map((e) => e.getAttribute("alt")));
    check("two explanation diagrams, in order, after reveal", eimgs.length === 2 && eimgs[0].startsWith("Ray diagram") && eimgs[1].startsWith("Total internal"), eimgs);

    await goToQuestion(page, idx("chemistry"));
    check("an unrevealed question shows no explanation", (await page.locator("[data-testid=human-explanation]").count()) === 0);
    const after = await rawHtml(page, `${BASE}/student/attempt/${F.practiceAttemptId}/run`);
    const leaked = [...new Set(after.body.match(new RegExp(`${SENT}-${F.suffix}-[a-z]+`, "g")) ?? [])].sort();
    check("after reload: only revealed questions' explanations are in the HTML", JSON.stringify(leaked) === JSON.stringify([`${SENT}-${F.suffix}-explained`, `${SENT}-${F.suffix}-physics`]), leaked);
    check("R3 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("R4 Review page (submitted): rich text + explanation");
  {
    const page = await newPage({ mobile: true });
    await login(page, F.students.review.email);
    await page.goto(`${BASE}/student/attempt/${F.reviewAttemptId}/review`);
    await page.locator("[data-testid=review-nav]").waitFor();
    const next = page.locator("[data-testid=review-nav] button[aria-label='Next question']");
    check("Q1 PLAIN review shows literal text", (await page.getByText("Cost is $5 and $10;", { exact: false }).count()) >= 1 && (await page.locator(".katex").count()) === 0);
    for (let i = 0; i < idx("physics"); i++) await next.click();
    await page.locator("[data-testid=human-explanation]").waitFor();
    check("physics review renders math in question/options", (await page.locator(".katex").count()) >= 12);
    check("review shows the human explanation", (await page.locator("[data-testid=human-explanation]").innerText()).includes(`${SENT}-${F.suffix}-physics`));
    check("review on phone: no horizontal scroll", await noHorizontalScroll(page));
    await shot(page, "mobile-review-physics");
    for (let i = idx("physics"); i < idx("organic"); i++) await next.click();
    check("review: organic option images", (await page.locator("[data-testid=review-options] img").count()) === 4);
    for (let i = idx("organic"); i < idx("plain-explained"); i++) await next.click();
    const pe = await page.locator("[data-testid=human-explanation]").innerText();
    check("PLAIN explanation shown literally", pe.includes("Plain explanation $y$ stays literal"), pe);
    check("R4 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("R5 Saved Questions: revealed vs locked");
  {
    const page = await newPage();
    await login(page, F.students.saved.email);
    await page.goto(`${BASE}/student/saved`);
    await page.waitForLoadState("load");
    check("saved (revealed): math rendered", (await page.locator(".katex").count()) >= 8);
    check("saved (revealed): human explanations shown", (await page.locator("[data-testid=human-explanation]").count()) === 2);
    check("saved (revealed): PLAIN saved question literal", (await page.getByText("Cost is $5 and $10;", { exact: false }).count()) === 1);
    await shot(page, "desktop-saved");
    await page.context().close();

    const locked = await newPage();
    await login(locked, F.students.exam.email);
    const raw = await rawHtml(locked, `${BASE}/student/saved`);
    check("saved during a running test: rendered question present", raw.body.includes("katex"));
    check("saved during a running test: NO explanation in raw HTML", !raw.body.includes(SENT));
    await locked.context().close();
  }

  // ------------------------------------------------------------------------
  if (process.env.ADMIN_USER) {
    console.log("R6 Admin single-question preview (DRAFT-safe)");
    const page = await newPage();
    await page.goto(`${BASE}/admin/login`);
    await page.fill("input[name=username]", process.env.ADMIN_USER);
    await page.fill("input[name=password]", process.env.ADMIN_PASS);
    await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
    await page.goto(`${BASE}/admin/questions/preview/${F.ids.explained}`);
    const card = page.locator("[data-testid=admin-question-preview]");
    await card.waitFor();
    check("admin preview renders math", (await card.locator(".katex").count()) >= 5);
    check("admin preview shows explanation + 2 diagrams", (await card.locator("[data-testid=human-explanation] img").count()) === 2);
    await page.goto(`${BASE}/admin/questions/preview/${F.ids.plain}`);
    check("admin preview of PLAIN is literal", (await page.locator("[data-testid=admin-question-preview]").innerText()).includes("\\ce{H2O} \\frac{1}{2} <b>bold</b>"));
    await shot(page, "admin-preview-plain");
    check("R6 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("R7 180-question paper: RICH vs PLAIN (phone)");
  for (const [label, email, attemptId] of [
    ["PLAIN", F.students.plain.email, F.plainAttemptId],
    ["RICH", F.students.perf.email, F.perfAttemptId],
  ]) {
    const page = await newPage({ mobile: true });
    await login(page, email);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const t0 = Date.now();
    await openRun(page, attemptId);
    const loadMs = Date.now() - t0;
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return { transfer: n.transferSize, encoded: n.encodedBodySize, decoded: n.decodedBodySize, dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) };
    });
    // 30 navigations across the paper (local state only).
    const n0 = Date.now();
    for (let i = 1; i <= 30; i++) {
      await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
      await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(String(n)), i + 1);
    }
    const navMs = (Date.now() - n0) / 30;
    await page.evaluate(() => window.gc?.());
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const heapMb = metrics.JSHeapUsedSize / 1024 / 1024;
    const nodes = metrics.Nodes;
    info(
      `${label}: HTML transfer ${(nav.transfer / 1024).toFixed(0)} KiB (decoded ${(nav.decoded / 1024).toFixed(0)} KiB), DOMContentLoaded ${nav.dcl} ms, load ${nav.load} ms, wall ${loadMs} ms, avg Next ${navMs.toFixed(0)} ms, JS heap ${heapMb.toFixed(1)} MiB, DOM nodes ${nodes}`
    );
    const liveElements = await page.evaluate(() => document.querySelectorAll("*").length);
    // Mid-range phone: 4x CPU slowdown, same page reloaded.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.reload();
    await page.locator("[data-testid=test-player]").waitFor({ timeout: 60000 });
    const slow = await page.evaluate(() => Math.round(performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd));
    const s0 = Date.now();
    for (let i = 1; i <= 5; i++) {
      await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
      await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(String(n)), i + 1);
    }
    const slowNav = (Date.now() - s0) / 5;
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    info(`${label}: live DOM elements ${liveElements}; at 4x CPU throttle: DOMContentLoaded ${slow} ms, avg Next ${slowNav.toFixed(0)} ms`);
    check(`${label} 180-question paper: no horizontal scroll`, await noHorizontalScroll(page));
    check(`${label} 180-question paper: navigation under 300 ms per question`, navMs < 300, navMs);
    check(`${label} no page errors`, page.errors.length === 0, page.errors);
    if (label === "PLAIN") check("PLAIN 180-question paper never loads the KaTeX stylesheet", !(await katexStylesheetLoaded(page)).link);
    await page.context().close();
  }
} catch (e) {
  failed++;
  console.log(`FAIL  suite crashed: ${e?.message ?? e}`);
} finally {
  await browser.close();
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
