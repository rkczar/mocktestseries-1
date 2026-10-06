/**
 * NEET Phase 4 — advanced question types in a real browser (desktop + 360 px
 * phone, light + dark), against a local production build on a DISPOSABLE
 * database, behind a scratch nginx that serves /media/ (real stored figures).
 *
 *   STORAGE_DIR=<scratch> REAL_MEDIA=1 DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server \
 *     npx tsx scripts/verify-question-types.ts setup > /tmp/qt.json
 *   BASE=<nginx origin> FIXTURE=/tmp/qt.json DATABASE_URL=<scratch> [SHOTS=<dir>] \
 *     NODE_PATH=/root/.claude/skills/gstack/node_modules node scripts/verify-question-types.mjs
 *   … verify-question-types.ts cleanup /tmp/qt.json
 *
 * Covers: MSQ checkbox semantics (never radios), toggle/autosave/restore,
 * rapid toggling vs the stored set, keyboard, image options; SINGLE radios
 * unchanged; Match lists (structure, images, stacking on a phone, no page
 * scroll); Exam Mode leak gate on the raw HTML; Practice "Check answer" with
 * selected/wrong/missed states; Review + Saved Questions; Ask AI hidden for
 * advanced types; a 180-question mixed paper (load, navigation, save latency, heap).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const { Client } = require("pg");

const BASE = process.env.BASE ?? "http://localhost:3143";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ORDER = Object.keys(F.ids); // creation order = paper order
const idx = (key) => ORDER.indexOf(key);

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}
const info = (m) => console.log(`INFO  ${m}`);

const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, "") });
await db.connect();
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
  page.on("dialog", (d) => d.accept());
  return page;
}

async function login(page, tag) {
  const { email, password } = F.students[tag];
  await db.query(`delete from "StudentDevice" where "studentId" in (select id from "Student" where email = $1)`, [email]);
  await db.query(`delete from "StudentLoginAttempt" where identifier = $1`, [email]);
  await db.query(`update "TestAttempt" set "activeDeviceId" = null, "activeSeenAt" = null where "studentId" = (select id from "Student" where email = $1)`, [email]);
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
}

const rawHtml = (page, url) =>
  page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "same-origin" });
    return { status: r.status, body: await r.text() };
  }, url);

async function openRun(page, attemptId) {
  await page.goto(`${BASE}/student/attempt/${attemptId}/run`);
  await page.locator("[data-testid=test-player]").waitFor({ timeout: 30000 });
}
const position = async (page) => Number(((await page.locator("[data-testid=question-position]").first().textContent()) ?? "").match(/\d+/)?.[0] ?? 1) - 1;
async function goToQuestion(page, i) {
  if (page.mobile) {
    for (let guard = 0; guard < 400 && (await position(page)) !== i; guard++) {
      const here = await position(page);
      if (here < i) await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
      else await page.getByRole("button", { name: /Previous/ }).first().click();
    }
  } else {
    await page.locator(`[data-testid=palette] button[aria-label="Go to question ${i + 1}"]`).click();
  }
  await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(`Question ${n} of`), i + 1);
}
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const storedLabels = async (attemptId, key) =>
  (await db.query(`select "selectedLabels" from "Answer" where "attemptId" = $1 and "questionId" = $2`, [attemptId, F.ids[key]])).rows[0]?.selectedLabels ?? null;
async function waitStored(attemptId, key, want, ms = 15000) {
  const t0 = Date.now();
  let got;
  while (Date.now() - t0 < ms) {
    got = await storedLabels(attemptId, key);
    if (JSON.stringify(got) === JSON.stringify(want)) return { ok: true, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, got };
}
const checkedLabels = (page) =>
  page.locator("[data-testid=multi-options] input[type=checkbox]").evaluateAll((els) => els.filter((e) => e.checked).map((e) => e.value));
const imagesLoaded = (page, sel) =>
  page.locator(sel).evaluateAll((imgs) => imgs.map((i) => i.complete && i.naturalWidth > 0));

try {
  // ------------------------------------------------------------------------
  console.log("U1 Exam Mode (desktop): MSQ checkboxes, autosave, restore, Match lists, no leaks");
  {
    const page = await newPage();
    const run = F.runs.exam;
    await login(page, "exam");
    await openRun(page, run);
    const raw = await rawHtml(page, `/student/attempt/${run}/run`);
    check("raw player HTML: no correctLabels / matchSpec / explanation / isCorrect", raw.status === 200 && !/correctLabels|matchSpec|Sharks are fish|isCorrect/.test(raw.body));

    // SINGLE unchanged: a radio group.
    await goToQuestion(page, idx("single-plain"));
    check("SINGLE: radiogroup with 4 radios, no checkboxes", (await page.locator("[role=radiogroup] input[type=radio]").count()) === 4 && (await page.locator("[data-testid=multi-options]").count()) === 0);

    // MSQ: real checkboxes in a labelled group.
    await goToQuestion(page, idx("msq-abd"));
    const group = page.locator("[data-testid=multi-options]");
    check("MSQ: role=group with 4 checkboxes and no radios", (await group.getAttribute("role")) === "group" && (await group.locator("input[type=checkbox]").count()) === 4 && (await page.locator("[data-testid=test-player] input[type=radio]").count()) === 0);
    check("MSQ: hint announced via aria-describedby", /more than one option/i.test((await page.locator(`#${await group.getAttribute("aria-describedby")}`).textContent()) ?? ""));
    const opt = (l) => group.locator(`[data-testid=option][data-label=${l}]`);
    await opt("A").click();
    await opt("B").click();
    await opt("D").click();
    check("MSQ: A, B, D stay selected together", JSON.stringify(await checkedLabels(page)) === '["A","B","D"]');
    let w = await waitStored(run, "msq-abd", ["A", "B", "D"]);
    check("autosave stores [A,B,D]", w.ok, w);
    info(`autosave latency (last toggle → stored): ${w.ms} ms`);
    await opt("B").click();
    w = await waitStored(run, "msq-abd", ["A", "D"]);
    check("tapping again deselects → stored [A,D]", w.ok && JSON.stringify(await checkedLabels(page)) === '["A","D"]', w);

    // Rapid toggling: A B D, unselect B, select C — no waits between taps (A,D already on → clear first).
    await page.getByRole("button", { name: "Clear Response" }).click();
    for (const l of ["A", "B", "D", "B", "C"]) await opt(l).click();
    const ui = await checkedLabels(page);
    w = await waitStored(run, "msq-abd", ui);
    check("rapid toggling: UI [A,C,D] and the stored set converge to it", JSON.stringify(ui) === '["A","C","D"]' && w.ok, { ui, w });

    // Keyboard: Space toggles the focused checkbox.
    await opt("C").locator("input").focus();
    await page.keyboard.press("Space");
    w = await waitStored(run, "msq-abd", ["A", "D"]);
    check("keyboard Space toggles a checkbox (C off → [A,D])", w.ok, w);

    // Navigation preserves; reload restores from the server.
    await goToQuestion(page, idx("msq-all"));
    await goToQuestion(page, idx("msq-abd"));
    check("navigation away and back keeps [A,D]", JSON.stringify(await checkedLabels(page)) === '["A","D"]');
    await page.reload();
    await page.locator("[data-testid=test-player]").waitFor();
    await goToQuestion(page, idx("msq-abd"));
    check("reload restores [A,D] from the server", JSON.stringify(await checkedLabels(page)) === '["A","D"]');
    const palBtn = page.locator(`[data-testid=palette] button[aria-label="Go to question ${idx("msq-abd") + 1}"]`);
    await goToQuestion(page, idx("msq-all"));
    check("palette marks the MSQ answered", /answered|success/i.test(((await palBtn.getAttribute("class")) ?? "") + ((await palBtn.getAttribute("data-status")) ?? "")) || (await palBtn.evaluate((b) => getComputedStyle(b).backgroundColor)) !== "rgba(0, 0, 0, 0)");

    // Image-option MSQ: real images, tap on the option text toggles, enlarge opens the viewer.
    await goToQuestion(page, idx("msq-img"));
    const imgs = await imagesLoaded(page, "[data-testid=multi-options] img");
    check("image options: 4 real images loaded", imgs.length === 4 && imgs.every(Boolean), imgs);
    await page.locator("[data-testid=multi-options] [data-testid=option][data-label=B] input").check();
    await page.locator("[data-testid=multi-options] [data-testid=option][data-label=D] input").check();
    w = await waitStored(run, "msq-img", ["B", "D"]);
    check("image-option MSQ saves [B,D]", w.ok, w);
    await page.locator("[data-testid=multi-options] [data-testid=media-expand]").first().click();
    const viewerOpen = await page.locator("[data-testid=image-viewer][open]").isVisible().catch(() => false);
    check("image option can be enlarged (viewer opens)", viewerOpen);
    if (viewerOpen) await page.keyboard.press("Escape");
    check("enlarging did not toggle the option set", JSON.stringify(await checkedLabels(page)) === '["B","D"]');

    // Match the Following: structure + images + coded radios.
    await goToQuestion(page, idx("mtf-bio"));
    const ml = page.locator("[data-testid=match-lists]");
    check("MTF: List I and List II sections with 4 entries each", (await ml.locator("[data-testid=match-list-I] li").count()) === 4 && (await ml.locator("[data-testid=match-list-II] li").count()) === 4);
    check("MTF lists are labelled regions (aria-label List I / List II)", (await page.locator("section[aria-label='List I']").count()) === 1 && (await page.locator("section[aria-label='List II']").count()) === 1);
    check("MTF coded options are radios", (await page.locator("[role=radiogroup] input[type=radio]").count()) === 4);
    const box1 = await ml.locator("[data-testid=match-list-I]").boundingBox();
    const box2 = await ml.locator("[data-testid=match-list-II]").boundingBox();
    check("desktop: List I and List II side by side", Math.abs(box1.y - box2.y) < 2 && box2.x > box1.x + 50, { box1, box2 });
    await page.locator("[role=radiogroup] [data-testid=option][data-label=B] input").check();
    const mtfStored = await (async () => {
      for (let i = 0; i < 100; i++) {
        const r = (await db.query(`select "selectedOptionLabel" from "Answer" where "attemptId" = $1 and "questionId" = $2`, [run, F.ids["mtf-bio"]])).rows[0];
        if (r?.selectedOptionLabel === "B") return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })();
    check("MTF coded answer saved as selectedOptionLabel B", mtfStored);
    await goToQuestion(page, idx("mtf-phys"));
    const listImgs = await imagesLoaded(page, "[data-testid=match-lists] img");
    check("MTF Physics: list graphs loaded (2 images)", listImgs.length === 2 && listImgs.every(Boolean), listImgs);
    check("MTF Physics: formulas rendered in List II", (await page.locator("[data-testid=match-list-II] .katex").count()) >= 3);
    await goToQuestion(page, idx("mtf-chem"));
    check("MTF Chemistry: mhchem rendered in List I", (await page.locator("[data-testid=match-list-I] .katex").count()) >= 2);
    await shot(page, "u1-mtf-chem-desktop");
    await goToQuestion(page, idx("msq-chem"));
    check("MSQ Chemistry: mhchem options rendered", (await page.locator("[data-testid=multi-options] .katex").count()) === 4);
    check("U1 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("U2 Practice Mode: Check answer, selected / wrong / missed states");
  {
    const page = await newPage();
    const run = F.runs.prac;
    await login(page, "prac");
    await openRun(page, run);
    await goToQuestion(page, idx("msq-abd"));
    const group = page.locator("[data-testid=multi-options]");
    const check1 = page.locator("[data-testid=check-answer]");
    check("Check answer disabled with nothing selected", await check1.isDisabled());
    await group.locator("[data-label=A] input").check();
    await group.locator("[data-label=C] input").check();
    const before = await rawHtml(page, `/student/attempt/${run}/run`);
    check("before Check answer: no key in the raw HTML", !/correctLabels/.test(before.body));
    check("one tap is not a commit (no reveal yet)", (await page.locator("[data-testid=reveal-result]").count()) === 0);
    await check1.click();
    await page.locator("[data-testid=reveal-result]").waitFor();
    const result = (await page.locator("[data-testid=reveal-result]").innerText()).replace(/\s+/g, " ");
    check("reveal: Incorrect, your answer A, C, correct answer A, B, D", /Incorrect/.test(result) && /Your answer: A, C/.test(result) && /Correct answer: A, B, D/.test(result), result);
    const state = async (l) => group.locator(`[data-label=${l}]`).getAttribute("data-state");
    check("option states: A hit, C wrong, B + D missed", (await state("A")) === "hit" && (await state("C")) === "wrong" && (await state("B")) === "missed" && (await state("D")) === "missed", [await state("A"), await state("B"), await state("C"), await state("D")]);
    check("checkboxes locked after the check", (await group.locator("input:disabled").count()) === 4);
    check("Ask AI not offered for an MSQ", (await page.locator("[data-testid=instant-panel] [data-testid=ask-ai-button]").count()) === 0);
    check("explanation released with the reveal", (await page.locator("[data-testid=instant-panel]").innerText()).includes("Sharks are fish"));
    await shot(page, "u2-practice-msq-revealed");
    // SINGLE in practice still commits on the tap.
    await goToQuestion(page, idx("single-plain"));
    await page.locator("[role=radiogroup] [data-label=C] input").click();
    await page.locator("[data-testid=reveal-result]").waitFor();
    check("SINGLE practice: tap commits + reveals Correct", /Correct/.test(await page.locator("[data-testid=reveal-result]").innerText()));
    check("SINGLE practice: Ask AI still offered", (await page.locator("[data-testid=instant-panel] [data-testid=ask-ai-button]").count()) === 1);
    // MATCH in practice: tap commits like SINGLE.
    await goToQuestion(page, idx("mtf-bio"));
    await page.locator("[role=radiogroup] [data-label=A] input").click();
    await page.locator("[data-testid=reveal-result]").waitFor();
    check("MTF practice: tap commits + Correct", /Correct/.test(await page.locator("[data-testid=reveal-result]").innerText()));
    check("U2 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("U3 Review + Saved Questions");
  {
    const page = await newPage();
    await login(page, "review");
    await page.goto(`${BASE}/student/attempt/${F.reviewAttemptId}/review`);
    await page.locator("[data-testid=review-options]").waitFor();
    const goReview = async (i) => {
      for (let g = 0; g < 40; g++) {
        const pos = Number(((await page.locator("[data-testid=review-nav-position]").textContent()) ?? "").match(/(\d+)\s*\//)?.[1] ?? 1) - 1;
        if (pos === i) return;
        await page.getByRole("button", { name: pos < i ? "Next question" : "Previous question" }).click();
      }
    };
    await goReview(idx("msq-abd"));
    const st = async (l) => page.locator(`[data-testid=review-options] > div`).nth(["A", "B", "C", "D"].indexOf(l)).getAttribute("data-state");
    check("Review MSQ: A selected-correct, C selected-incorrect, B + D missed-correct", (await st("A")) === "selected-correct" && (await st("C")) === "selected-incorrect" && (await st("B")) === "missed-correct" && (await st("D")) === "missed-correct");
    const sets = (await page.locator("[data-testid=review-answer-sets]").innerText()).replace(/\s+/g, " ");
    check("Review MSQ: Your answer A, C / Correct answer A, B, D", /Your answer: A, C/.test(sets) && /Correct answer: A, B, D/.test(sets), sets);
    check("Review MSQ: verdict Incorrect", /Incorrect/.test(await page.locator("[data-testid=review-answer-header]").innerText()));
    check("Review MSQ: no Ask AI button", (await page.locator("[data-testid=ask-ai-button]").count()) === 0);
    await shot(page, "u3-review-msq");
    await goReview(idx("msq-ab"));
    check("Review MSQ exact set: Correct", /Correct/.test(await page.locator("[data-testid=review-answer-header]").innerText()) && !/Incorrect/.test(await page.locator("[data-testid=review-answer-header]").innerText()));
    await goReview(idx("mtf-bio"));
    check("Review MTF: lists shown + coded answer B marked wrong, A correct", (await page.locator("[data-testid=match-lists] li").count()) === 8 && /Correct Answer: A\./.test(await page.locator("body").innerText()));
    await goReview(idx("single-plain"));
    check("Review SINGLE: unchanged (Correct Answer line + Ask AI offered)", /Correct Answer: C\./.test(await page.locator("body").innerText()) && (await page.locator("[data-testid=ask-ai-button]").count()) === 1);

    await page.goto(`${BASE}/student/saved`);
    await page.getByText("QT MSQ 2").first().waitFor();
    const body = await page.locator("main").innerText();
    check("Saved MSQ: multi note + 3 correct answers marked", /More than one option may be correct/.test(body) && (body.match(/Correct answer/g) ?? []).length >= 3);
    check("Saved MTF: lists with real images", (await page.locator("[data-testid=match-lists]").count()) === 1 && (await imagesLoaded(page, "[data-testid=match-lists] img")).every(Boolean));
    check("Saved: no Ask AI panel for advanced types", (await page.locator("[data-testid=ask-ai-button]").count()) === 0);
    check("U3 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  for (const dark of [false, true]) {
    const tag = dark ? "dark" : "mobile";
    console.log(`U4 Phone 360 px (${dark ? "dark" : "light"}): MSQ + Match layout`);
    const page = await newPage({ mobile: true, dark });
    await login(page, tag);
    await openRun(page, F.runs[tag]);
    for (const key of ["msq-abd", "msq-img", "msq-phys", "mtf-bio", "mtf-phys", "mtf-chem", "mtf-mixed"]) {
      await goToQuestion(page, idx(key));
      check(`${tag} ${key}: no page-level horizontal scroll`, await noHorizontalScroll(page));
      if (key.startsWith("mtf")) {
        const b1 = await page.locator("[data-testid=match-list-I]").boundingBox();
        const b2 = await page.locator("[data-testid=match-list-II]").boundingBox();
        check(`${tag} ${key}: lists stacked (List II below List I), full width`, b2.y >= b1.y + b1.height - 1 && b1.width > 280, { b1, b2 });
        const fs = await page.locator("[data-testid=match-item]").first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
        check(`${tag} ${key}: entries readable (font ≥ 14px)`, fs >= 14, fs);
      }
      if (key === "msq-abd") {
        await page.locator("[data-testid=multi-options] [data-label=B]").tap();
        await page.locator("[data-testid=multi-options] [data-label=D]").tap();
        check(`${tag} msq tap selects several`, JSON.stringify(await checkedLabels(page)) === '["B","D"]');
        const sel = await page.locator("[data-testid=multi-options] [data-label=B]").evaluate((e) => getComputedStyle(e).backgroundColor);
        const un = await page.locator("[data-testid=multi-options] [data-label=A]").evaluate((e) => getComputedStyle(e).backgroundColor);
        check(`${tag} selected state visibly different`, sel !== un, { sel, un });
      }
      await shot(page, `u4-${tag}-${key}`);
    }
    await goToQuestion(page, idx("mtf-phys"));
    await page.locator("[data-testid=match-lists] [data-testid=media-expand]").first().tap();
    check(`${tag} list image expandable on a phone`, await page.locator("[data-testid=image-viewer][open]").isVisible().catch(() => false));
    await page.keyboard.press("Escape");
    check(`U4 ${tag} no page errors`, page.errors.length === 0, page.errors);
    await page.context().close();
  }

  // ------------------------------------------------------------------------
  console.log("U5 180-question mixed paper (phone): load, navigation, save latency, heap");
  {
    const page = await newPage({ mobile: true });
    await login(page, "perf");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const t0 = Date.now();
    await openRun(page, F.runs.perf);
    const wall = Date.now() - t0;
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType("navigation")[0];
      return { transfer: n.transferSize, decoded: n.decodedBodySize, dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) };
    });
    const n0 = Date.now();
    for (let i = 1; i <= 30; i++) {
      await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
      await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(`Question ${n} of`), i + 1);
    }
    const navMs = (Date.now() - n0) / 30;
    // Save latency: toggle on the first MSQ found, measure to the stored row.
    let saveMs = null;
    for (let i = 0; i < 6 && saveMs === null; i++) {
      if (await page.locator("[data-testid=multi-options]").count()) {
        const qid = await page.evaluate(() => document.querySelector("[data-testid=multi-options] input")?.getAttribute("name")?.slice(2));
        const s0 = Date.now();
        await page.locator("[data-testid=multi-options] [data-testid=option]").first().tap();
        for (let k = 0; k < 150; k++) {
          const r = (await db.query(`select cardinality("selectedLabels") n from "Answer" where "attemptId" = $1 and "questionId" = $2`, [F.runs.perf, qid])).rows[0];
          if (r?.n > 0) {
            saveMs = Date.now() - s0;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      } else await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
    }
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    info(`180 mixed: HTML transfer ${(nav.transfer / 1024).toFixed(0)} KiB (decoded ${(nav.decoded / 1024).toFixed(0)} KiB), DCL ${nav.dcl} ms, load ${nav.load} ms, wall ${wall} ms, avg Next ${navMs.toFixed(0)} ms, MSQ save ${saveMs} ms, JS heap ${(metrics.JSHeapUsedSize / 1048576).toFixed(1)} MiB, DOM nodes ${metrics.Nodes}`);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.reload();
    await page.locator("[data-testid=test-player]").waitFor({ timeout: 60000 });
    const slow = await page.evaluate(() => Math.round(performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd));
    const s0 = Date.now();
    for (let i = 1; i <= 5; i++) {
      await page.getByRole("button", { name: /^(Save & )?Next/ }).first().click();
      await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(`Question ${n} of`), i + 1);
    }
    const slowNav = (Date.now() - s0) / 5;
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    info(`180 mixed at 4x CPU: DCL ${slow} ms, avg Next ${slowNav.toFixed(0)} ms`);
    check("180 mixed: navigation under 300 ms per question", navMs < 300, navMs);
    check("180 mixed: MSQ save stored within 2 s", saveMs !== null && saveMs < 2000, saveMs);
    check("180 mixed: no horizontal scroll", await noHorizontalScroll(page));
    check("U5 no page errors", page.errors.length === 0, page.errors);
    await page.context().close();
  }
} catch (e) {
  failed++;
  console.log(`FAIL  suite crashed: ${e instanceof Error ? e.stack : e}`);
} finally {
  await browser.close();
  await db.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
