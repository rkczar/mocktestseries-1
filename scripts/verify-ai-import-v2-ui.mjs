/**
 * AI Question Importer 2.0 — browser suite (Playwright, desktop + mobile) against a scratch `next start`
 * with the mock OpenRouter and the scratch worker loop. Synthetic fixtures only. Run it after
 * scripts/verify-ai-import-ui.mjs on the same fixture (that suite saves the importer settings it uses):
 *
 *   BASE=… FX_DIR=… FIXTURE=… ADMIN_USER=… ADMIN_PASS=… DATABASE_URL=<scratch> NODE_PATH=<playwright> \
 *   node scripts/verify-ai-import-v2-ui.mjs
 *
 * Covers: exam + Previous Year Paper visible on every step, confirmation summary, live progress from the
 * backend, edit with validation / Save / Cancel, complete images with zoom (no cropping) on desktop and
 * mobile, image replacement, re-scan with a side-by-side choice, history, approval → Question Bank,
 * Question Bank detail (exam, paper, taxonomy, original number, images) and access control.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const BASE = process.env.BASE;
const FX = process.env.FX_DIR;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await db.query(`delete from "LoginAttempt" where username = any($1)`, [[process.env.ADMIN_USER, F.fullAdmin]]);
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
const browser = await chromium.launch();
const pages = [];
async function newPage({ mobile = false } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e).slice(0, 200)));
  page.on("dialog", (d) => d.accept(page.nextPrompt ?? undefined).catch(() => {}));
  pages.push(page);
  return page;
}
async function adminLogin(page, user, pw) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pw);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
async function until(fn, timeout = 15000, every = 500) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, every));
  }
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const inPage = (page, url, init) => page.evaluate(async ([u, i]) => { const r = await fetch(u, i); return { status: r.status, text: await r.text() }; }, [url, init ?? {}]);
/** Every <img> in scope: loaded, and drawn at its own aspect ratio (complete image, never cropped or squashed). */
const imageFit = (page, scope) =>
  page.locator(`${scope} img`).evaluateAll((imgs) =>
    imgs.map((im) => {
      const r = im.getBoundingClientRect();
      const fit = getComputedStyle(im).objectFit;
      const natural = im.naturalWidth / Math.max(1, im.naturalHeight);
      const drawn = r.width / Math.max(1, r.height);
      return { ok: im.complete && im.naturalWidth > 0, fit, natural: +natural.toFixed(3), drawn: +drawn.toFixed(3), w: Math.round(r.width) };
    }),
  );
const wholeImage = (x) => x.ok && (x.fit === "contain" || Math.abs(x.natural - x.drawn) / x.natural < 0.03);
const qid = async (jobId, label) => (await db.query(`select id from "AiImportQuestion" where "jobId"=$1 and "sourceLabel"=$2`, [jobId, label])).rows[0]?.id;

// ------------------------------------------------------------------ 1
section("1. One page: Exam → Previous Year Paper → upload → confirm → live progress");
const admin = await newPage();
await adminLogin(admin, process.env.ADMIN_USER, process.env.ADMIN_PASS);
await db.query(`update "Setting" set value = jsonb_set(value, '{aiEnabled}', 'true') where key='ai.importer'`);
await admin.goto(`${BASE}/admin/ai-importer`);
await admin.selectOption("[data-testid=op-exam]", F.examId);
await admin.selectOption("[data-testid=op-pyq]", F.paper2Id);
check("paper selected on the main card, its year shown, no year to type", /2022/.test(await admin.locator("[data-testid=op-pyq-hint]").textContent()) && (await admin.locator("[data-testid=op-year]").count()) === 0);
await admin.fill("[data-testid=op-expected]", "3");
await admin.locator("[data-testid=op-upload-input]").setInputFiles({ name: `AIUI v2 scanned ${F.suffix}.pdf`, mimeType: "application/pdf", buffer: readFileSync(path.join(FX, "scanned.pdf")) });
await Promise.all([admin.waitForURL(/\/admin\/ai-importer\?job=[a-z0-9]+$/, { timeout: 90000 }), admin.locator("[data-testid=op-submit]").click()]);
const jobId = new URL(admin.url()).searchParams.get("job");
await until(async () => (await admin.locator("[data-testid=op-confirm]").count()) > 0 || (await admin.reload(), false), 90000, 2000);
check("mapping visible after upload: exam, paper title, year 2022, job id, status", (await admin.locator("[data-testid=paper-mapping]").getAttribute("data-paper-id")) === F.paper2Id && (await admin.locator("[data-testid=pm-paper] dd").textContent()) === F.paper2Title && /2022/.test(await admin.locator("[data-testid=pm-year]").textContent()) && (await admin.locator("[data-testid=pm-job]").textContent()).includes(jobId));
check("confirmation summary shows the selected paper and year", (await admin.locator("[data-testid=op-confirm-paper]").textContent()) === F.paper2Title && /2022/.test(await admin.locator("[data-testid=op-confirm-year]").textContent()));
check("expected count carried from the upload", (await admin.locator("[data-testid=op-confirm-expected]").inputValue()) === "3");
check("Start Import stays disabled until the summary is confirmed", await admin.locator("[data-testid=process-import]").isDisabled());
if (await admin.locator("[data-testid=op-verify-mode]").count()) await admin.selectOption("[data-testid=op-verify-mode]", "all");
await admin.locator("[data-testid=op-confirm-check]").check();
await admin.locator("[data-testid=process-import]").click();
const sawProgress = await until(async () => (await admin.locator("[data-testid=op-progress]").count()) > 0 || (await admin.locator("[data-testid=quality-panel]").count()) > 0, 30000, 300);
check("progress (or the finished summary) comes from the backend, on the same page", !!sawProgress);
if (await admin.locator("[data-testid=op-live]").count()) check("live counters shown: pages, failed, expected, extracted, verified, spend", /Pages:/.test(await admin.locator("[data-testid=op-live]").textContent()) && /Verified:/.test(await admin.locator("[data-testid=op-live]").textContent()));
await until(async () => { await admin.reload(); return (await admin.locator("[data-testid=quality-panel]").count()) > 0; }, 240000, 3000);
check("finished: quality summary with expected 3 / extracted 3 and nothing stored", (await admin.locator("[data-testid=q-expected]").getAttribute("data-value")) === "3" && (await admin.locator("[data-testid=q-extracted]").getAttribute("data-value")) === "3" && (await admin.locator("[data-testid=q-stored]").getAttribute("data-value")) === "0");
check("independent verification counted from stored evidence", Number(await admin.locator("[data-testid=q-verified]").getAttribute("data-value")) >= 1);
check("the selected paper is still shown after processing", (await admin.locator("[data-testid=paper-mapping]").getAttribute("data-paper-id")) === F.paper2Id);

// ------------------------------------------------------------------ 2
section("2. Review a question: mapping, complete images with zoom, edit with validation");
const q1 = await qid(jobId, "1");
await admin.goto(`${BASE}/admin/ai-importer/questions/${q1}`);
check("question page shows the exam and the paper", (await admin.locator("[data-testid=paper-mapping]").getAttribute("data-paper-id")) === F.paper2Id);
check("verification line shows the independent read", (await admin.locator("[data-testid=q-verification]").getAttribute("data-agree")) !== "none");
await admin.waitForTimeout(1200);
const prevImgs = await imageFit(admin, "[data-testid=preview-figure]");
check("preview figure: complete image at its own aspect ratio", prevImgs.length >= 1 && prevImgs.every(wholeImage), prevImgs);
const figImgs = await imageFit(admin, "[data-testid=rv-figure]");
check("figure tools: complete image at its own aspect ratio", figImgs.length >= 1 && figImgs.every(wholeImage), figImgs);
await admin.locator("[data-testid=rv-figure] [data-testid=media-expand]").first().click();
check("tap a figure → full-size viewer with zoom", await until(async () => (await admin.locator("dialog[open]").count()) > 0, 5000));
await admin.keyboard.press("Escape");
await admin.locator("[data-testid=rv-figure-source]").first().click();
check("shows where the figure was cut from the source page", (await admin.locator("[data-testid=rv-figure] img[alt^='Page']").count()) >= 1);
// Validation before saving; Cancel restores.
const stem0 = await admin.locator("[data-testid=rv-stem]").inputValue();
await admin.fill("[data-testid=rv-stem]", "");
await admin.fill("[data-testid=rv-pages]", "9");
check("problems listed before saving; Save disabled", /cannot be empty/.test(await admin.locator("[data-testid=rv-problems]").textContent()) && /Source pages must be/.test(await admin.locator("[data-testid=rv-problems]").textContent()) && (await admin.locator("[data-testid=rv-save]").isDisabled()));
await admin.click("[data-testid=rv-cancel]");
check("Cancel restores the question", (await admin.locator("[data-testid=rv-stem]").inputValue()) === stem0 && (await admin.locator("[data-testid=rv-problems]").count()) === 0);
await admin.fill("[data-testid=rv-stem]", `${stem0} [edited in UI]`);
await admin.fill("[data-testid=rv-explanation]", "UI explanation.");
await admin.click("[data-testid=rv-save]");
await admin.locator("[data-testid=review-msg]").waitFor();
check("Save changes → saved and re-checked", /Saved and re-checked/.test(await admin.locator("[data-testid=review-msg]").textContent()));
await admin.reload();
check("history lists the manual correction with the fields changed", /Manual correction/.test(await admin.locator("[data-testid=rv-history]").textContent()) && /Question text/.test(await admin.locator("[data-testid=rv-history]").textContent()));

// ------------------------------------------------------------------ 3
section("3. Re-scan from the original page: correction kept, side-by-side choice");
await admin.click("[data-testid=rv-rescan-question]");
await admin.locator("[data-testid=review-msg]").waitFor();
check("re-scan queued (message)", /Re-scan queued/.test(await admin.locator("[data-testid=review-msg]").textContent()), await admin.locator("[data-testid=review-msg]").textContent());
await until(async () => { await admin.reload(); return (await admin.locator("[data-testid=rv-compare]").count()) > 0; }, 180000, 3000);
check("the new read waits beside the corrected question", (await admin.locator("[data-testid=rv-compare]").count()) === 1 && (await admin.locator("[data-testid=rv-stem]").inputValue()).endsWith("[edited in UI]"));
check("comparison marks the changed field (question text)", (await admin.locator("[data-testid=rv-compare-row][data-field=stem]").getAttribute("data-same")) === "false");
await admin.click("[data-testid=rv-approve]");
await admin.locator("[data-testid=review-msg]").waitFor();
check("…with the reason shown", /re-scan result is waiting/.test(await admin.locator("[data-testid=review-msg]").textContent()), await admin.locator("[data-testid=review-msg]").textContent());
await admin.click("[data-testid=rv-compare-apply]");
await until(async () => (await admin.locator("[data-testid=rv-compare]").count()) === 0, 15000);
check("Keep the current question (nothing ticked) → the correction stays", (await admin.locator("[data-testid=rv-stem]").inputValue()).endsWith("[edited in UI]"));

// ------------------------------------------------------------------ 4
section("4. Replace an image, set answer and topic, approve, add to the Question Bank");
const big = await sharp({ create: { width: 900, height: 300, channels: 3, background: { r: 240, g: 230, b: 200 } } }).png().toBuffer();
await admin.locator("[data-testid=rv-figure-replace-input]").first().setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: big });
await until(async () => /Image replaced/.test((await admin.locator("[data-testid=review-msg]").textContent()) ?? ""), 20000);
await admin.reload();
const up = await imageFit(admin, "[data-testid=rv-figure]");
check("uploaded 900×300 image shown complete (3:1, not cropped)", up.length === 1 && wholeImage(up[0]) && Math.abs(up[0].natural - 3) < 0.01, up);
await admin.click("[data-testid=rv-answer-A]");
await admin.click("[data-testid=rv-set-answer]");
await until(async () => /Answer saved/.test((await admin.locator("[data-testid=review-msg]").textContent()) ?? ""), 10000);
const subj = await admin.locator("[data-testid=rv-subject] option").nth(1).getAttribute("value");
await admin.selectOption("[data-testid=rv-subject]", subj);
const topic = await admin.locator("[data-testid=rv-topic] option").nth(1).getAttribute("value").catch(() => null);
if (topic) await admin.selectOption("[data-testid=rv-topic]", topic);
await admin.click("[data-testid=rv-set-topic]");
await until(async () => /Subject\/topic saved/.test((await admin.locator("[data-testid=review-msg]").textContent()) ?? ""), 10000);
await admin.click("[data-testid=rv-approve]");
await until(async () => /Approved\./.test((await admin.locator("[data-testid=review-msg]").textContent()) ?? ""), 15000);
await admin.reload();
check("approved badge shown", (await admin.locator("[data-testid=rv-approved]").count()) === 1);
await admin.goto(`${BASE}/admin/ai-importer?job=${jobId}`);
await admin.locator("[data-testid=qp-store-approved]").click();
await until(async () => { await admin.reload(); return Number(await admin.locator("[data-testid=q-stored]").getAttribute("data-value")) >= 1; }, 180000, 3000);
check("approved question added to the Question Bank (as Draft)", (await db.query(`select q.status from "Question" q join "AiImportQuestion" a on a."questionId"=q.id where a.id=$1`, [q1])).rows[0]?.status === "DRAFT");
check("Open in Question Bank link", (await admin.locator("[data-testid=qp-open-bank] a").count()) >= 1);

// ------------------------------------------------------------------ 5
section("5. Question Bank detail: exam, paper, taxonomy, original number, complete images");
const savedId = (await db.query(`select "questionId" from "AiImportQuestion" where id=$1`, [q1])).rows[0].questionId;
await admin.goto(`${BASE}/admin/questions/preview/${savedId}`);
check("exam shown", (await admin.locator("[data-testid=qf-exam]").textContent()).length > 3);
check("Previous Year Paper shown with its year", (await admin.locator("[data-testid=qf-paper]").textContent()).includes(F.paper2Title) && /2022/.test(await admin.locator("[data-testid=qf-paper]").textContent()));
check("subject › topic shown", /›/.test(await admin.locator("[data-testid=qf-taxonomy]").textContent()));
check("original question number and the import shown", /Original question 1/.test(await admin.locator("[data-testid=qf-import]").textContent()));
check("explanation shown", (await admin.locator("text=UI explanation.").count()) > 0);
await admin.waitForTimeout(1200);
const bank = await imageFit(admin, "[data-testid=admin-question-preview]");
check("Question Bank: image loads from /media, complete, 3:1 kept", bank.length >= 1 && bank.every(wholeImage) && bank.some((b) => Math.abs(b.natural - 3) < 0.02), bank);
await admin.locator("[data-testid=admin-question-preview] [data-testid=media-expand]").first().click();
check("Question Bank: expand / zoom viewer", await until(async () => (await admin.locator("dialog[open]").count()) > 0, 5000));
await admin.keyboard.press("Escape");

// ------------------------------------------------------------------ 6
section("6. Mobile");
const m = await newPage({ mobile: true });
await adminLogin(m, process.env.ADMIN_USER, process.env.ADMIN_PASS);
for (const u of [`/admin/ai-importer?job=${jobId}`, `/admin/ai-importer/questions/${await qid(jobId, "2")}`, `/admin/ai-importer/exceptions?job=${jobId}`, `/admin/questions/preview/${savedId}`, `/admin/ai-importer/jobs/${jobId}`]) {
  await m.goto(`${BASE}${u}`);
  await m.waitForTimeout(900);
  check(`mobile ${u.split("?")[0].replace(/[a-z0-9]{20,}/, "…")}: no horizontal scroll, no error`, (await noOverflow(m)) && (await m.locator("text=Application error").count()) === 0);
}
await m.goto(`${BASE}/admin/questions/preview/${savedId}`);
await m.waitForTimeout(1200);
const mb = await imageFit(m, "[data-testid=admin-question-preview]");
check("mobile Question Bank: image complete and within the screen", mb.length >= 1 && mb.every((x) => wholeImage(x) && x.w <= 375), mb);
await m.goto(`${BASE}/admin/ai-importer/questions/${await qid(jobId, "2")}`);
await m.waitForTimeout(1200);
const mf = await imageFit(m, "[data-testid=rv-figure]");
check("mobile review: figure complete and within the screen", mf.length >= 1 && mf.every((x) => wholeImage(x) && x.w <= 375), mf);

// ------------------------------------------------------------------ 7
section("7. Access control");
const full = await newPage();
await adminLogin(full, F.fullAdmin, F.password);
await full.goto(`${BASE}/admin/ai-importer/questions/${await qid(jobId, "2")}`);
check("FULL_ADMIN sees the question and its paper but no edit / approve / re-scan tools", (await full.locator("[data-testid=paper-mapping]").count()) === 1 && (await full.locator("[data-testid=question-review]").count()) === 0);
const upl = await full.evaluate(async (u) => { const f = new FormData(); f.set("file", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "x.png"); const r = await fetch(u, { method: "POST", body: f }); return r.status; }, `/api/admin/ai-importer/questions/${await qid(jobId, "2")}/figures`);
check("FULL_ADMIN image upload refused server-side (403)", upl === 403, upl);
const manifest = JSON.parse(readFileSync(`${process.env.APP_DIR ?? "."}/.next/server/server-reference-manifest.json`, "utf8"));
const actionId = (name) => Object.entries(manifest.node).find(([, v]) => v.exportedName === name || JSON.stringify(v).includes(`"${name}"`))?.[0];
const raw = await inPage(full, `/admin/ai-importer/questions/${await qid(jobId, "2")}`, { method: "POST", headers: { "Next-Action": actionId("approveQuestionsAction"), Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([[await qid(jobId, "2")]]) });
check("FULL_ADMIN raw approveQuestionsAction refused", !!actionId("approveQuestionsAction") && /do not have permission/.test(raw.text), raw.text.slice(-200));
const rawPaper = await inPage(full, `/admin/ai-importer?job=${jobId}`, { method: "POST", headers: { "Next-Action": actionId("changeJobPaperAction"), Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([jobId, null]) });
check("FULL_ADMIN raw changeJobPaperAction refused; paper unchanged", /do not have permission/.test(rawPaper.text) && (await db.query(`select "previousYearPaperId" from "AiImportJob" where id=$1`, [jobId])).rows[0].previousYearPaperId === F.paper2Id);
const anon = await newPage();
const anonUp = await anon.request.post(`${BASE}/api/admin/ai-importer/questions/${q1}/figures`, { maxRedirects: 0, multipart: { owner: "STEM" } });
check("anonymous image upload refused", [302, 307, 403].includes(anonUp.status()), anonUp.status());

check("no page errors in any session", pages.every((p) => p.errors.length === 0), pages.map((p) => p.errors).flat());
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
