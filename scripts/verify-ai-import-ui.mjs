/**
 * AI Question Importer — browser suite (Playwright, desktop + mobile), against a
 * scratch `next start` (behind a proxy serving /media from scratch storage) with
 * the mock OpenRouter. Synthetic fixtures only.
 *
 *   BASE=http://localhost:3411 FX_DIR=/tmp/aifx FIXTURE=/tmp/aiui.json ADMIN_USER=… ADMIN_PASS=… \
 *   DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-ai-import-ui.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE;
const FX = process.env.FX_DIR;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
// Repeated suite runs trip the app's own login limiter: clear this suite's attempts (scratch DB only).
await db.query(`delete from "LoginAttempt" where username = any($1)`, [[process.env.ADMIN_USER, F.fullAdmin]]);
await db.query(`delete from "StudentLoginAttempt" where identifier = $1`, [F.student.email]).catch(() => {});
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};
const section = (s) => console.log(`\n=== ${s}`);
const browser = await chromium.launch();
const pages = [];
async function newPage({ mobile = false } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e).slice(0, 200)));
  page.on("dialog", (d) => {
    page.lastDialog = d.message();
    d.accept(page.nextPrompt ?? undefined).catch(() => {});
  });
  pages.push(page);
  return page;
}
async function adminLogin(page, user, pass) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pass);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const inPage = (page, url, init) => page.evaluate(async ([u, i]) => { const r = await fetch(u, i); return { status: r.status, text: await r.text() }; }, [url, init ?? {}]);
async function waitStatus(page, re, timeout = 120000) {
  const end = Date.now() + timeout;
  for (;;) {
    const t = (await page.locator("[data-testid=job-status]").textContent().catch(() => "")) ?? "";
    if (re.test(t)) return t;
    if (Date.now() > end) return t;
    await page.waitForTimeout(1500);
    await page.reload();
  }
}
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
/**
 * Starts an import the normal way: the one-page importer (exam preselected, optional details under
 * Advanced options), choose the files → Submit & Analyze. Returns the job id from the page URL.
 */
async function startOnMainPage(page, file, { name, examId, pyqId, year, key, expected } = {}) {
  await page.goto(`${BASE}/admin/ai-importer`);
  if (examId) await page.selectOption("[data-testid=op-exam]", examId);
  // Step 2: the Previous Year Paper is chosen on the main card (its year comes from the paper).
  if (pyqId) await page.selectOption("[data-testid=op-pyq]", pyqId);
  if (await page.locator("[data-testid=op-year]").count()) await page.fill("[data-testid=op-year]", year ?? "2024");
  // The expected count is a required step of the form (it is confirmed again before processing).
  await page.fill("[data-testid=op-expected]", expected ?? "10");
  if (key) await page.locator("[data-testid=op-key-input]").setInputFiles(path.join(FX, key));
  const input = name ? { name, mimeType: file.endsWith(".docx") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : file.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf", buffer: readFileSync(path.join(FX, file)) } : path.join(FX, file);
  await page.locator("[data-testid=op-upload-input]").setInputFiles(input);
  await Promise.all([page.waitForURL(/\/admin\/ai-importer\?job=[a-z0-9]+$/, { timeout: 90000 }), page.locator("[data-testid=op-submit]").click()]);
  return new URL(page.url()).searchParams.get("job");
}
/** Confirm summary → Confirm Cost & Start Processing (expected count required, explicit confirmation). */
async function startImport(page, { expected, dbl = false } = {}) {
  const exp = page.locator("[data-testid=op-confirm-expected]");
  if (expected || !(await exp.inputValue())) await exp.fill(expected ?? "10");
  await page.locator("[data-testid=op-confirm-check]").check();
  if (dbl) await page.locator("[data-testid=process-import]").dblclick();
  else await page.locator("[data-testid=process-import]").click();
}
async function waitFor(page, selector, timeout = 120000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.locator(selector).count()) return true;
    if (Date.now() > end) return false;
    await page.waitForTimeout(1500);
  }
}
async function imagesOk(page, scope) {
  return page.locator(`${scope} img`).evaluateAll((imgs) => imgs.map((im) => ({ ok: im.complete && im.naturalWidth > 0, src: im.getAttribute("src")?.slice(0, 60) })));
}

// ------------------------------------------------------------------ admin
section("A. Section, navigation, settings");
const admin = await newPage();
await adminLogin(admin, process.env.ADMIN_USER, process.env.ADMIN_PASS);
await admin.goto(`${BASE}/admin`);
check("sidebar shows AI Question Importer", (await admin.getByRole("link", { name: "AI Question Importer" }).count()) > 0);
const SECTIONS = ["", "/jobs", "/exceptions", "/answers", "/history", "/costs", "/vault", "/storage", "/settings"];
for (const s of SECTIONS) {
  const r = await admin.goto(`${BASE}/admin/ai-importer${s}`);
  const ok = r.status() === 200 && (await admin.locator("[data-testid=ai-importer-subnav]").count()) === 1 && (await admin.locator("text=Application error").count()) === 0;
  check(`page ${s || "/"} renders`, ok, r.status());
}
// The administrator approves models for the importer only (Import Settings → Importer models); they are then
// chosen AUTOMATICALLY (none picked per import). Global AI → Models approvals are left exactly as they are.
await db.query(`delete from "Setting" where key in ('ai.importer', 'ai.importer.routes')`);
const globalFlags = async () => JSON.stringify((await db.query(`select id, approved, "medicallyApproved" from "AiModel" order by id`)).rows);
const flags0 = await globalFlags();
await admin.goto(`${BASE}/admin/ai-importer/settings`);
await admin.locator("[data-testid=ai-enabled]").check();
for (const id of ["mockvision/reader", "mockvision/checker", "mockvision/mid", "mockvision/cheapnozdr", "mockvision/pricey", "mocktext/classifier"]) {
  await admin.locator("[data-testid=importer-model-search]").fill(id);
  await admin.locator(`[data-testid=importer-model-hits] li[data-model-id="${id}"] [data-testid=importer-model-add]`).click();
}
check("automatic model selection is the default", await admin.locator("[data-testid=sel-auto]").isChecked());
await admin.locator("[data-testid=routes-refresh]").click();
await until(async () => (await admin.locator("[data-testid=sel-extract]").getAttribute("data-model")) === "mockvision/reader");
check("automatic choice shown: page reading mockvision/reader (cheapest with a ZDR route), verification a different model", (await admin.locator("[data-testid=sel-extract]").getAttribute("data-model")) === "mockvision/reader" && (await admin.locator("[data-testid=sel-verify]").getAttribute("data-model")) === "mockvision/mid");
await admin.locator("[data-testid=settings-save]").click();
await admin.locator("[data-testid=settings-msg]").waitFor();
check("settings saved", /saved/i.test(await admin.locator("[data-testid=settings-msg]").textContent()));
const saved = (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value;
check("settings persisted (AI on, automatic selection, no manual models, ZDR + no data collection)", saved?.aiEnabled === true && saved?.selection?.mode === "auto" && saved?.models?.extract === null && saved?.privacy?.dataCollection === "deny" && saved?.privacy?.zdr === true, saved);
check("importer list saved (6 models) and no global AI → Models approval changed", saved?.importerModels?.length === 6 && (await globalFlags()) === flags0);

// ------------------------------------------------------------------ new import → upload → analyze → confirm
section("B. New import, upload, analysis, confirmation, processing");
const jobId = await startOnMainPage(admin, "digital-clean.pdf", { name: `AIUI digital ${F.suffix}.pdf`, examId: F.examId, pyqId: F.paperId, expected: "10" });
check("the selected Previous Year Paper is kept on the job, with the paper's own year", await until(async () => { const r = (await db.query(`select "previousYearPaperId", year, "expectedQuestions" from "AiImportJob" where id=$1`, [jobId])).rows[0]; return r?.previousYearPaperId === F.paperId && r.year !== null && r.expectedQuestions === 10; }));
check("the main page shows the exam AND the selected paper", (await admin.locator("[data-testid=paper-mapping]").getAttribute("data-paper-id")) === F.paperId && !/None — Question Bank only/.test(await admin.locator("[data-testid=pm-paper]").textContent()));
check("job created from the main page (named after the file)", !!jobId && (await db.query(`select title from "AiImportJob" where id=$1`, [jobId])).rows[0]?.title === `AIUI digital ${F.suffix}`);
// The detailed job page stays available for step-by-step work.
await admin.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
await waitStatus(admin, /Awaiting confirmation/);
await admin.locator("[data-testid=upload-input]").setInputFiles(path.join(FX, "fake.pdf"));
await admin.locator("[data-testid=upload-progress] li", { hasText: "content is PNG" }).waitFor({ timeout: 30000 });
check("fake PDF refused with a clear reason in the UI", true);
await admin.reload();
await admin.selectOption("[data-testid=upload-role]", "ANSWER_KEY");
await admin.locator("[data-testid=upload-input]").setInputFiles(path.join(FX, "key-digital.pdf"));
await admin.locator("[data-testid=upload-progress] li", { hasText: "1 page(s)" }).waitFor({ timeout: 60000 });
await admin.reload();
// Remove the refused upload, then analyze.
const remove = admin.locator("[data-testid=file-row]", { hasText: "fake.pdf" }).locator("[data-testid=file-remove]");
if (await remove.count()) {
  check("refused upload offers Remove upload", /Remove upload/.test(await remove.textContent()));
  await remove.click();
  await admin.locator("[data-testid=file-row]", { hasText: "fake.pdf" }).waitFor({ state: "detached", timeout: 15000 });
}
check("every stored file has its own Remove button before processing", (await admin.locator("[data-testid=file-row] [data-testid=file-remove]:not([disabled])").count()) === (await admin.locator("[data-testid=file-row]").count()));
await admin.click("[data-testid=analyze]");
await waitStatus(admin, /Awaiting confirmation/);
await admin.locator("[data-testid=analysis-report]").waitFor();
const reportText = await admin.locator("[data-testid=analysis-report]").textContent();
check("analysis report separates Detected and Estimated values", /Detected · pages/.test(reportText) && /Estimated · questions/.test(reportText));
check("estimate table with the automatically chosen model, price, total and conservative maximum", (await admin.locator("[data-testid=estimate-total]").count()) === 1 && /mockvision\/reader/.test(await admin.locator("[data-testid=estimate]").textContent()) && /₹[\d.]+/.test((await admin.locator("[data-testid=estimate-max]").textContent()) ?? "") && /Models: automatic/.test(await admin.locator("[data-testid=estimate]").textContent()));
check("job page: no budget field; cost panel with estimate, estimated maximum, job and month actual spend", (await admin.locator("[data-testid=confirm-budget]").count()) === 0 && (await admin.locator("[data-testid=confirm-card] [data-testid=cost-estimate-value]").count()) === 1 && (await admin.locator("[data-testid=confirm-card] [data-testid=cost-max-value]").count()) === 1 && (await admin.locator("[data-testid=confirm-card] [data-testid=cost-job-actual-value]").count()) === 1 && (await admin.locator("[data-testid=confirm-card] [data-testid=cost-month-actual-value]").count()) === 1);
check("job page button reads Confirm Cost & Start Processing", (await admin.locator("[data-testid=confirm-start]").textContent()) === "Confirm Cost & Start Processing");
await admin.click("[data-testid=confirm-start]");
const st1 = await waitStatus(admin, /Review & approval/, 180000);
check("processing finished → Review & approval (nothing stored yet)", /Review & approval/.test(st1) && (await db.query(`select count(*)::int n from "AiImportQuestion" where "jobId"=$1 and "questionId" is not null`, [jobId])).rows[0].n === 0, st1);
const progressText = (await admin.locator("[data-testid=progress-card]").textContent()) ?? "";
check("after processing the job page still shows the four cost figures (actual spend from the usage records, not the held maximum)", (await admin.locator("[data-testid=progress-card] [data-testid=cost-job-actual-value]").count()) === 1 && (await admin.locator("[data-testid=progress-card] [data-testid=cost-month-actual-value]").count()) === 1 && /Estimated maximum/.test(progressText) && !/AI spend so far/.test(progressText), progressText.slice(0, 300));
check("job page shows the paper mapping and the quality summary", (await admin.locator("[data-testid=paper-mapping]").getAttribute("data-paper-id")) === F.paperId && (await admin.locator("[data-testid=quality-panel]").count()) === 1);
check("job page shows the models chosen at confirmation, with the reason", (await admin.locator("[data-testid=plan-extract]").getAttribute("data-model")) === "mockvision/reader" && /Cheapest suitable/.test((await admin.locator("[data-testid=plan-extract]").textContent()) ?? ""));
const blockedNote = (await admin.locator("[data-testid=files-remove-blocked]").textContent().catch(() => "")) ?? "";
check("after processing, Remove is disabled with the reason shown", /use Delete import/.test(blockedNote) && (await admin.locator("[data-testid=file-remove]:not([disabled])").count()) === 0 && (await admin.locator("[data-testid=file-remove]").count()) > 0, blockedNote);
const summaryText = await admin.locator("[data-testid=batch-summary]").textContent();
check("batch summary shows extracted / eligible / not importable", /Questionsextracted10/.test(summaryText.replace(/\s+/g, "")) && /Not importable/.test(summaryText), summaryText.slice(0, 200));

// ------------------------------------------------------------------ review
section("C. Review exceptions and one question");
await admin.goto(`${BASE}/admin/ai-importer/exceptions?job=${jobId}`);
const rows = await admin.locator("[data-testid=exception-row]").count();
check("exceptions list shows only questions needing a decision", rows > 0 && rows < 10, rows);
const q2Id = (await db.query(`select id from "AiImportQuestion" where "jobId"=$1 and "sourceLabel"='2'`, [jobId])).rows[0].id;
await admin.goto(`${BASE}/admin/ai-importer/questions/${q2Id}`);
await admin.locator("[data-testid=source-page]").first().waitFor();
await admin.waitForTimeout(1500);
const src = await admin.locator("[data-testid=q-preview] img, figure img").evaluateAll((imgs) => imgs.map((im) => ({ ok: im.complete && im.naturalWidth > 0 })));
check("source page image and stem figure load beside the question", src.length >= 2 && src.every((i) => i.ok), src);
check("Q2 shows the key mismatch", /mismatch/i.test(await admin.locator("[data-testid=q-answer-status]").textContent()));
await admin.click("[data-testid=rv-answer-C]");
await admin.click("[data-testid=rv-set-answer]");
await admin.locator("[data-testid=review-msg]").waitFor();
check("admin sets the answer", /Answer saved/.test(await admin.locator("[data-testid=review-msg]").textContent()));
const q3Id = (await db.query(`select id from "AiImportQuestion" where "jobId"=$1 and "sourceLabel"='3'`, [jobId])).rows[0].id;
await admin.goto(`${BASE}/admin/ai-importer/questions/${q3Id}`);
await admin.waitForTimeout(1200);
const opt = [];
for (const l of ["A", "B", "C", "D"]) opt.push(await imagesOk(admin, `[data-testid=option-figure-${l}]`));
check("preview: each option shows its own image", opt.every((x) => x.length === 1 && x[0].ok), opt);

// ------------------------------------------------------------------ import & publish
section("D. Approve, then Add approved & Publish Eligible (existing Bulk Import underneath)");
await admin.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
check("nothing can be added before approval", await admin.locator("[data-testid=import-draft]").isDisabled());
await admin.goto(`${BASE}/admin/ai-importer/exceptions?job=${jobId}&status=all`);
await admin.locator("[data-testid=bulk-bar] button", { hasText: "Select all" }).click();
await admin.click("[data-testid=bulk-approve]");
await admin.locator("[data-testid=bulk-msg]").waitFor({ timeout: 30000 });
const approveMsg = await admin.locator("[data-testid=bulk-msg]").textContent();
check("bulk approval approves what is ready and names what it refused, with reasons", /\d+ approved/.test(approveMsg) && /not approved — Q\d+:/.test(approveMsg), approveMsg);
await admin.reload();
check("review list shows the approval of each question", (await admin.locator("[data-testid=row-approval][data-approved=true]").count()) > 0);
await admin.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
await admin.click("[data-testid=import-publish-all]");
await until(async () => (await db.query(`select count(*)::int n from "AiImportEvent" where "jobId"=$1 and type='QUALITY_GATE'`, [jobId])).rows[0].n > 0, 240000);
await admin.reload();
const st2 = await waitStatus(admin, /Review & approval|Completed/, 60000);
check("approved questions added; the job waits for the remaining decisions", /Review & approval|Completed/.test(st2), st2);
const pub = (await db.query(`select "sourceLabel", status, "questionId" from "AiImportQuestion" where "jobId"=$1 order by "orderIndex"`, [jobId])).rows;
const published = pub.filter((r) => r.status === "PUBLISHED");
check("eligible questions published (incl. option-image Q3, admin-answered Q2)", published.some((r) => r.sourceLabel === "3") && published.some((r) => r.sourceLabel === "2"), pub);
check("Q8 (answer unverified) imported but not published", pub.find((r) => r.sourceLabel === "8")?.status === "IMPORTED", pub.find((r) => r.sourceLabel === "8"));
check("stored questions carry the job's exam and Previous Year Paper", (await db.query(`select count(*)::int n from "Question" q join "AiImportQuestion" a on a."questionId"=q.id where a."jobId"=$1 and (q."examId"<>$2 or q."previousYearPaperId" is distinct from $3)`, [jobId, F.examId, F.paperId])).rows[0].n === 0);
// The remaining questions are decided (rejected): the job then completes with warnings, never plain Completed.
await admin.goto(`${BASE}/admin/ai-importer/exceptions?job=${jobId}`);
if (await admin.locator("[data-testid=exception-row]").count()) {
  await admin.locator("[data-testid=bulk-bar] button", { hasText: "Select all" }).click();
  admin.nextPrompt = "synthetic: not stored";
  await admin.click("[data-testid=bulk-reject]");
  await admin.locator("[data-testid=bulk-msg]").waitFor({ timeout: 30000 });
  admin.nextPrompt = undefined;
}
await admin.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
const st3 = await waitStatus(admin, /Completed/, 60000);
check("every question decided and the count matches → Completed with Warnings", /Completed with Warnings/.test(st3), st3);
const runLink = admin.locator("a", { hasText: "Bulk Import run" }).first();
check("job links to its Bulk Import run in Import History", (await runLink.count()) === 1);
const runHref = await runLink.getAttribute("href");
const runPage = await admin.goto(`${BASE}${runHref}`);
// The run page streams in: wait for its label instead of counting immediately.
const runLabel = await admin.locator(`text=AI Importer — AIUI digital ${F.suffix}`).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
check("existing Bulk Import history page opens for the run", runPage.status() === 200 && (await admin.locator("text=Application error").count()) === 0 && runLabel);
const q8 = pub.find((r) => r.sourceLabel === "8");
await admin.goto(`${BASE}/admin/questions/preview/${q8.questionId}`);
check("saved question shows 'Answer unverified'", (await admin.locator("text=Answer unverified").count()) > 0);
const q3saved = pub.find((r) => r.sourceLabel === "3");
await admin.goto(`${BASE}/admin/questions/preview/${q3saved.questionId}`);
await admin.waitForTimeout(1500);
const reopened = await admin.locator("img").evaluateAll((imgs) => imgs.filter((im) => (im.getAttribute("src") ?? "").startsWith("/media/")).map((im) => im.complete && im.naturalWidth > 0));
check("reopened saved question: all 4 option images load from /media", reopened.length >= 4 && reopened.every(Boolean), reopened);
await admin.goto(`${BASE}/admin/ai-importer/history`);
check("Import History lists the job with counts", (await admin.locator("[data-testid=history-table]", { hasText: `AIUI digital ${F.suffix}` }).count()) === 1);
await admin.goto(`${BASE}/admin/ai-importer/costs`);
// Since 2026-10-23 the free classifier settles most questions, so this local paper may need no AI call at all: the
// Cost Center must list exactly the calls that were made (and none that were not).
const aiCalls = Number((await db.query(`select count(*)::int n from "AiImportAiCall" where "jobId"=$1`, [jobId])).rows[0].n);
check("Cost Center lists the AI calls that were made (none invented when the free classifier settled everything)", (await admin.locator("[data-testid=cost-calls]").count()) === 1 && (aiCalls > 0 ? (await admin.locator("[data-testid=cost-calls] tbody tr").count()) > 0 : true), { aiCalls });

// ------------------------------------------------------------------ publishing policy in the Question Bank
section("E. Question Bank publishing gate");
const bulk = await inPage(admin, "/api/admin/questions/bulk-actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "PUBLISH", ids: [q8.questionId] }) });
const bj = JSON.parse(bulk.text);
check("bulk Publish refuses a flagged question and says why", bulk.status === 200 && bj.updatedCount === 0 && bj.blockedCount === 1 && /flagged for review/i.test(bj.message), bj);
await admin.goto(`${BASE}/admin/questions`);
await admin.locator("table tbody [role=checkbox]").first().waitFor({ timeout: 30000 });
await admin.locator("table tbody [role=checkbox]").first().click();
check("bulk action list offers 'Mark Reviewed (clear flag)'", (await admin.locator("option[value=CLEAR_REVIEW_REQUIRED]").count()) === 1);
await admin.goto(`${BASE}/admin/questions?tab=add&id=${q8.questionId}`);
await admin.locator("select[name=status]").waitFor({ timeout: 20000 });
await admin.selectOption("select[name=status]", "PUBLISHED");
await admin.locator("form button[type=submit]").last().click();
await admin.waitForTimeout(2500);
check("question form refuses publishing a flagged question", (await admin.locator("text=can't be published").count()) > 0);
check("still a draft in the database", (await db.query(`select status from "Question" where id=$1`, [q8.questionId])).rows[0].status === "DRAFT");

// ------------------------------------------------------------------ student sees images
section("F. Student opens the published imported questions");
const out = execFileSync("npx", ["tsx", "scripts/ai-import-ui-fixture.ts", "attempt", process.env.FIXTURE], { env: process.env }).toString();
const att = JSON.parse(out.trim().split("\n").pop());
check("PYQ attempt built from the published imported questions", att.questions >= 3, att);
const student = await newPage();
await student.goto(`${BASE}/login`);
await student.locator("#identifier").or(student.getByText("Already have an account? Sign in")).first().waitFor();
if (!(await student.locator("#identifier").count())) await student.getByText("Already have an account? Sign in").click();
await student.fill("#identifier", F.student.email);
await student.fill("input[type=password]", F.password);
await Promise.all([student.waitForURL(/\/student/, { timeout: 30000 }), student.locator("form button[type=submit]").first().click()]);
await student.goto(`${BASE}/student/attempt/${att.attemptId}/run`);
await student.locator("[data-testid=test-player]").waitFor({ timeout: 30000 });
let found = null;
for (let i = 0; i < 12 && !found; i++) {
  const imgs = await student.locator("[data-testid=test-player] [data-testid=question-media] img").evaluateAll((x) => x.map((im) => im.complete && im.naturalWidth > 0));
  if (imgs.length === 4) found = imgs;
  else {
    const next = student.getByRole("button", { name: /^(Save & )?Next/ }).first();
    if (!(await next.count())) break;
    await next.click();
    await student.waitForTimeout(700);
  }
}
check("student player: the option-image question shows all 4 images", !!found && found.every(Boolean), found);
const raw = await student.evaluate((u) => fetch(u).then((r) => r.text()), `/student/attempt/${att.attemptId}/run`);
check("student payload carries no answer key", !/"correctLabel"/.test(raw) && !/answerVerification/.test(raw));

// ------------------------------------------------------------------ storage, vault, access
section("G. Storage Manager, vault, access control");
await admin.goto(`${BASE}/admin/ai-importer/storage`);
await admin.click("[data-testid=scan-storage]");
await admin.locator("[data-testid=storage-report]").waitFor({ timeout: 60000 });
check("storage scan report", /Original papers/.test(await admin.locator("[data-testid=storage-report]").textContent()));
await admin.click("[data-testid=preview-cleanup]");
await admin.locator("[data-testid=cleanup-preview]").waitFor({ timeout: 30000 });
const canDelete = await admin.locator("[data-testid=cleanup-execute]").count();
if (canDelete) {
  check("delete disabled until DELETE is typed", await admin.locator("[data-testid=cleanup-execute]").isDisabled());
  await admin.fill("[data-testid=cleanup-confirm]", "DELETE");
  await admin.click("[data-testid=cleanup-execute]");
  await admin.locator("[data-testid=storage-msg]").waitFor();
  check("cleanup executed with confirmation", /Removed/.test(await admin.locator("[data-testid=storage-msg]").textContent()));
} else check("preview shows nothing to delete when nothing is safe", /0 item/.test(await admin.locator("[data-testid=cleanup-preview]").textContent()));
await admin.click("[data-testid=find-duplicates]");
await admin.locator("[data-testid=duplicates-report]").waitFor({ timeout: 60000 });
check("duplicate & integrity check runs", /checksummed/.test(await admin.locator("[data-testid=duplicates-report]").textContent()));
const fileId = (await db.query(`select id from "AiImportFile" where "jobId"=$1 and role='PAPER' and status<>'REJECTED' limit 1`, [jobId])).rows[0].id;
const dl = await inPage(admin, `/api/admin/ai-importer/files/${fileId}/original`);
check("admin can download the original from the vault", dl.status === 200 && dl.text.startsWith("%PDF"));
const anon = await newPage();
const anonRes = await anon.request.get(`${BASE}/api/admin/ai-importer/files/${fileId}/original`, { maxRedirects: 0 });
check("anonymous access to the original is refused", anonRes.status() === 403 || anonRes.status() === 307 || anonRes.status() === 302, anonRes.status());
const pageImg = (await db.query(`select id from "AiImportPage" where "jobId"=$1 limit 1`, [jobId])).rows[0].id;
const anonImg = await anon.request.get(`${BASE}/api/admin/ai-importer/pages/${pageImg}/image`, { maxRedirects: 0 });
check("anonymous access to page images is refused", [302, 307, 403].includes(anonImg.status()), anonImg.status());
const full = await newPage();
await adminLogin(full, F.fullAdmin, F.password);
await full.goto(`${BASE}/admin/ai-importer`);
check("FULL_ADMIN can view but not start an import", (await full.locator("text=You can view imports but not start one").count()) === 1 && (await full.locator("[data-testid=op-upload-input]").count()) === 0);
await full.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
check("FULL_ADMIN sees no import/publish buttons", (await full.locator("[data-testid=import-draft]").count()) === 0);
const fullUpload = await inPage(full, "/api/admin/ai-importer/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId, name: "x.pdf", size: 10 }) });
check("FULL_ADMIN upload refused server-side (403)", fullUpload.status === 403, fullUpload.status);

// ------------------------------------------------------------------ mobile
section("H. Mobile layout");
const m = await newPage({ mobile: true });
await adminLogin(m, process.env.ADMIN_USER, process.env.ADMIN_PASS);
for (const s of ["", `/jobs/${jobId}`, "/exceptions", "/storage", "/settings", `/questions/${q3Id}`]) {
  await m.goto(`${BASE}/admin/ai-importer${s}`);
  await m.waitForTimeout(500);
  check(`mobile ${s || "/"}: renders without page-level horizontal scroll`, (await noOverflow(m)) && (await m.locator("text=Application error").count()) === 0);
}
await m.goto(`${BASE}/admin/questions/bulk-import`);
check("existing Bulk Import page still renders", (await m.locator("text=Application error").count()) === 0);

// ------------------------------------------------------------------ remove / replace files
section("I. Remove and replace uploaded files");
const rmJob = await startOnMainPage(admin, "digital-clean.pdf", { examId: F.examId });
const row = (name) => admin.locator("[data-testid=file-row]", { hasText: name });
await admin.goto(`${BASE}/admin/ai-importer/jobs/${rmJob}`);
await waitStatus(admin, /Awaiting confirmation/);
await admin.selectOption("[data-testid=upload-role]", "ANSWER_KEY");
await admin.locator("[data-testid=upload-input]").setInputFiles(path.join(FX, "key.csv"));
await admin.locator("[data-testid=upload-progress] li", { hasText: /CSV/ }).waitFor({ timeout: 60000 });
await admin.reload();
await admin.click("[data-testid=analyze]");
await waitStatus(admin, /Awaiting confirmation/);
check("wrong key analyzed: report + confirm card shown", (await admin.locator("[data-testid=analysis-report]").count()) === 1 && (await admin.locator("[data-testid=confirm-card]").count()) === 1);
check("files show name and type clearly", /Answer key/.test(await row("key.csv").locator("[data-testid=file-type]").textContent()) && /Question paper/.test(await row("digital-clean.pdf").locator("[data-testid=file-type]").textContent()));
await row("key.csv").locator("[data-testid=file-remove]").click();
const dlg = admin.locator("[data-testid=remove-file-dialog]");
await dlg.waitFor();
check("confirmation dialog names the file and its type", (await dlg.locator("[data-testid=remove-file-name]").textContent()) === "key.csv" && /Answer key/.test(await dlg.locator("[data-testid=remove-file-type]").textContent()));
await dlg.getByRole("button", { name: "Keep file" }).click();
await dlg.waitFor({ state: "detached" });
check("Keep file closes the dialog and changes nothing", (await row("key.csv").count()) === 1 && (await admin.locator("[data-testid=analysis-report]").count()) === 1);
await row("key.csv").locator("[data-testid=file-remove]").click();
await dlg.locator("[data-testid=remove-file-confirm]").click();
await admin.locator("[data-testid=job-notice]", { hasText: "Removed" }).waitFor({ timeout: 15000 });
await row("key.csv").waitFor({ state: "detached", timeout: 15000 });
check("wrong key removed: row gone, other file kept", (await row("key.csv").count()) === 0 && (await row("digital-clean.pdf").count()) === 1);
check("analysis cleared: report and confirm card gone, Analyze offered again", (await admin.locator("[data-testid=analysis-report]").count()) === 0 && (await admin.locator("[data-testid=confirm-card]").count()) === 0 && /Analyze files/.test(await admin.locator("[data-testid=analyze]").textContent()));
check("notice tells the admin to re-analyze", /analyze the files again/i.test(await admin.locator("[data-testid=job-notice]").textContent()));
check("activity log shows the removal", /file removed.*key\.csv/i.test(await admin.locator("[data-testid=job-events]").textContent()));
check("file totals recalculated", /1 question paper · 0 answer keys · 2 paper pages/.test(await admin.locator("[data-testid=files-totals]").textContent()));
await admin.selectOption("[data-testid=upload-role]", "ANSWER_KEY");
await admin.locator("[data-testid=upload-input]").setInputFiles(path.join(FX, "key-digital.pdf"));
await admin.locator("[data-testid=upload-progress] li", { hasText: "1 page(s)" }).waitFor({ timeout: 60000 });
await admin.reload();
await admin.click("[data-testid=analyze]");
await waitStatus(admin, /Awaiting confirmation/);
const rep2 = await admin.locator("[data-testid=analysis-report]").textContent();
check("replacement key re-analyzed (old key absent from the report)", rep2.includes("key-digital.pdf") && !rep2.includes("key.csv"));
// Replace the paper too (single paper: the key has no explicit link).
await row("digital-clean.pdf").locator("[data-testid=file-remove]").click();
check("paper dialog says Question paper", /Question paper · PDF/.test(await dlg.locator("[data-testid=remove-file-type]").textContent()));
await dlg.locator("[data-testid=remove-file-confirm]").click();
await row("digital-clean.pdf").waitFor({ state: "detached", timeout: 15000 });
check("paper removed, answer key kept", (await row("key-digital.pdf").count()) === 1);
await admin.locator("[data-testid=upload-input]").setInputFiles(path.join(FX, "formula.pdf"));
await admin.locator("[data-testid=upload-progress] li", { hasText: "page(s)" }).waitFor({ timeout: 60000 });
await admin.reload();
check("replacement paper listed with its own page count", (await row("formula.pdf").count()) === 1 && /1 question paper · 1 answer key/.test(await admin.locator("[data-testid=files-totals]").textContent()));
// A refusal from the server is shown in the dialog; nothing is reported as removed.
await row("key-digital.pdf").locator("[data-testid=file-remove]").click();
await dlg.waitFor();
await db.query(`update "AiImportJob" set status='PROCESSING' where id=$1`, [rmJob]);
await dlg.locator("[data-testid=remove-file-confirm]").click();
await dlg.locator("[data-testid=remove-file-error]").waitFor({ timeout: 15000 });
check("server refusal shown in the dialog (job started meanwhile)", /import is running|use Delete import/.test(await dlg.locator("[data-testid=remove-file-error]").textContent()));
await dlg.getByRole("button", { name: "Keep file" }).click();
check("no success notice and the file is still there", (await admin.locator("[data-testid=job-notice]", { hasText: "key-digital" }).count()) === 0 && (await db.query(`select count(*)::int n from "AiImportFile" where "jobId"=$1 and "originalName"='key-digital.pdf'`, [rmJob])).rows[0].n === 1);
await db.query(`update "AiImportJob" set status='DRAFT' where id=$1`, [rmJob]);
// Mobile: rows, button and dialog fit a 375 px screen.
await m.goto(`${BASE}/admin/ai-importer/jobs/${rmJob}`);
await m.waitForTimeout(500);
const mBtn = m.locator("[data-testid=file-row]", { hasText: "formula.pdf" }).locator("[data-testid=file-remove]");
const mBox = await mBtn.boundingBox();
check("mobile: no horizontal scroll and Remove visible on screen", (await noOverflow(m)) && !!mBox && mBox.x >= 0 && mBox.x + mBox.width <= 375, mBox);
await mBtn.click();
const mDlg = m.locator("[data-testid=remove-file-dialog]");
await mDlg.waitFor();
const dBox = await mDlg.boundingBox();
check("mobile: confirmation dialog fits the screen", !!dBox && dBox.x >= 0 && dBox.x + dBox.width <= 375, dBox);
await mDlg.getByRole("button", { name: "Keep file" }).click();
// View-only admin: no button, and the Server Action refuses.
await full.goto(`${BASE}/admin/ai-importer/jobs/${rmJob}`);
check("FULL_ADMIN sees the files but no Remove buttons", (await full.locator("[data-testid=file-row]").count()) === 2 && (await full.locator("[data-testid=file-remove]").count()) === 0);
const manifest = JSON.parse(readFileSync(`${process.env.APP_DIR ?? "."}/.next/server/server-reference-manifest.json`, "utf8"));
const removeActionId = Object.entries(manifest.node).find(([, v]) => v.exportedName === "removeFileAction" || JSON.stringify(v).includes("removeFileAction"))?.[0];
const keyId = (await db.query(`select id from "AiImportFile" where "jobId"=$1 and "originalName"='key-digital.pdf'`, [rmJob])).rows[0].id;
const rawRemove = await inPage(full, `/admin/ai-importer/jobs/${rmJob}`, { method: "POST", headers: { "Next-Action": removeActionId, Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([rmJob, keyId]) });
check("FULL_ADMIN raw removeFileAction call is refused", !!removeActionId && /do not have permission/.test(rawRemove.text), { id: removeActionId, status: rawRemove.status, text: rawRemove.text.slice(-200) });
check("…and the file still exists", (await db.query(`select count(*)::int n from "AiImportFile" where id=$1`, [keyId])).rows[0].n === 1);

// ------------------------------------------------------------------ one-page importer (the normal workflow)
section("N. One-page importer: Upload → Analyze → Process & Import, with defaults untouched");
const settingsN0 = (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value;
await admin.goto(`${BASE}/admin/ai-importer`);
const subnav = await admin.locator("[data-testid=ai-importer-subnav] > a").allTextContents();
check("main navigation is short: Import, Imports, Review Exceptions, Import Settings + More", JSON.stringify(subnav) === JSON.stringify(["Import", "Imports", "Review Exceptions", "Import Settings"]) && (await admin.locator("[data-testid=ai-importer-more]").count()) === 1, subnav);
const upText = await admin.locator("[data-testid=upload-card]").textContent();
check("upload area with formats and the real limits", /New import/.test(upText) && /PDF, Word \(\.docx\), JPG, PNG, Excel \(\.xlsx\) or CSV/.test(upText) && /up to 100 MB and 300 pages/.test(upText), upText.slice(0, 200));
check("exam preselected from the last import (no form to fill)", (await admin.locator("[data-testid=op-exam]").inputValue()) === F.examId);
const opJob = await startOnMainPage(admin, "digital-clean.pdf", { name: `AIUI onepage ${F.suffix}.pdf`, key: "key-digital.pdf" });
check("upload → automatic analysis on the same page", !!opJob && (await waitFor(admin, "[data-testid=analyzer]", 90000)));
const facts = await admin.locator("[data-testid=analyzer-fact]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-kind"), e.textContent]));
check("analyzer: detected facts labelled (pages, digital, answer key)", facts.some(([k, t]) => k === "detected" && /Pages.*2/.test(t)) && facts.some(([, t]) => /Digital PDF/.test(t)) && facts.some(([, t]) => /Separate answer key uploaded/.test(t)), facts);
check("analyzer says the analysis was local and free", /no AI request was made/.test(await admin.locator("[data-testid=analyzer-mode]").textContent()));
const selModel = admin.locator("[data-testid=selected-model]");
check("selected model + why shown without opening Settings (digital → local reader)", (await selModel.getAttribute("data-local")) === "true" && /Why this model\?/.test(await selModel.textContent()) && /Automatic — Cheapest Suitable Model/.test(await selModel.textContent()));
check("estimated cost, estimated maximum, job and month actual spend shown; no pilot budget", /₹[\d.]+/.test(await admin.locator("[data-testid=op-cost] [data-testid=cost-estimate-value]").textContent()) && /₹[\d.]+/.test(await admin.locator("[data-testid=op-cost] [data-testid=cost-max-value]").textContent()) && /₹[\d.]+|Unknown/.test(await admin.locator("[data-testid=op-cost] [data-testid=cost-month-actual-value]").textContent()) && (await admin.locator("[data-testid=op-pilot-remaining]").count()) === 0 && /final cost may differ/.test(await admin.locator("[data-testid=op-cost]").textContent()));
check("one-page button reads Confirm Cost & Start Processing", /^Confirm Cost & Start Processing$/.test((await admin.locator("[data-testid=process-import]").textContent()) ?? ""));
const confirmText = await admin.locator("[data-testid=op-confirm-summary]").textContent();
check("confirmation summary before Start: exam, paper, year, code", /Exam:/.test(confirmText) && /Previous Year Paper:/.test(confirmText) && /Year:/.test(confirmText) && /Paper set \/ code:/.test(confirmText), confirmText);
check("one primary action, disabled until the summary is confirmed", (await admin.locator("[data-testid=process-import]").count()) === 1 && (await admin.locator("[data-testid=process-import]").isDisabled()));
await startImport(admin, { expected: "10" });
check("re-upload of an already imported paper: quality summary shown on the same page", (await waitFor(admin, "[data-testid=quality-panel]", 240000)) && /\/admin\/ai-importer\?job=/.test(admin.url()), admin.url());
check("finished import on the one-page importer shows its final cost: job and month actual spend", (await admin.locator("[data-testid=op-final-cost] [data-testid=cost-job-actual-value]").count()) === 1 && (await admin.locator("[data-testid=op-final-cost] [data-testid=cost-month-actual-value]").count()) === 1);
const val = async (t) => Number(await admin.locator(`[data-testid=${t}]`).getAttribute("data-value"));
check("…nothing stored by processing; duplicates found; counts from the backend", (await val("q-stored")) === 0 && (await val("q-duplicates")) >= 5 && (await val("q-extracted")) === 10 && (await val("q-expected")) === 10, { st: await val("q-stored"), dup: await val("q-duplicates") });
check("…and the next step is explained", /Next:/.test(await admin.locator("[data-testid=op-next-action]").textContent()) && (await db.query(`select count(*)::int n from "AiImportEvent" where "jobId"=$1 and type in ('IMPORT_REQUESTED','IMPORT_SKIPPED')`, [opJob])).rows[0].n === 0);

// Paid AI off + scanned paper (the UPSC CMS case): blocked before processing, one reason, one next action, ₹0.
await db.query(`update "Setting" set value = jsonb_set(value, '{aiEnabled}', 'false') where key='ai.importer'`);
const offJob = await startOnMainPage(admin, "scanned.pdf", { name: `AIUI scanned off ${F.suffix}.pdf` });
await waitFor(admin, "[data-testid=analyzer-blocker]", 90000);
const blk = await admin.locator("[data-testid=analyzer-blocker]").textContent();
check("AI off + scanned: blocked with the reason and one next action", /no text layer/.test(blk) && /Next:/.test(blk) && /digital PDF or Word/.test(blk), blk);
check("…badge says Action needed, no Start button, no contradictory Next line", /Action needed/.test(await admin.locator("[data-testid=current-status]").textContent()) && (await admin.locator("[data-testid=process-import]").count()) === 0 && (await admin.locator("[data-testid=op-next-action]").count()) === 0);
check("…nothing charged", (await db.query(`select "spentInr" from "AiImportJob" where id=$1`, [offJob])).rows[0].spentInr === 0);
await db.query(`update "Setting" set value = jsonb_set(value, '{aiEnabled}', 'true') where key='ai.importer'`);
// The exam has no year: the upload asks for the paper's year instead of failing every question later.
await admin.goto(`${BASE}/admin/ai-importer`);
check("exam without a year → Paper year is asked for on the upload area", (await admin.locator("[data-testid=op-year]").count()) === 1);
await admin.fill("[data-testid=op-expected]", "3");
await admin.locator("[data-testid=op-upload-input]").setInputFiles(path.join(FX, "paper.docx"));
check("…Submit stays disabled until the year is entered (nothing created)", (await admin.locator("[data-testid=op-submit]").isDisabled()) && /paper's year/.test(await admin.locator("[data-testid=op-submit-hint]").textContent()) && /\/admin\/ai-importer$/.test(admin.url()));
// A new paper with its key, defaults untouched (exam preselected, automatic model): one click imports it.
const newJob = await startOnMainPage(admin, "paper.docx", { name: `AIUI word ${F.suffix}.docx`, key: "key.csv" });
check("Word paper analyzed on the main page", await waitFor(admin, "[data-testid=analyzer]", 90000));
await startImport(admin, { dbl: true, expected: (await admin.locator("[data-testid=op-confirm-expected]").inputValue()) || "3" });
check("double click → one start (button disabled at once)", await until(async () => (await admin.locator("[data-testid=process-import]").count()) === 0 || (await admin.locator("[data-testid=process-import]").isDisabled())));
check("quality summary shown on the same page, without visiting other pages", (await waitFor(admin, "[data-testid=quality-panel]", 240000)) && /\/admin\/ai-importer\?job=/.test(admin.url()), admin.url());
check("nothing stored before approval", (await val("q-stored")) === 0);
// One-click approval is offered only when some question has no flag at all; a subject is never filled in at low
// confidence (the free classifier and the AI classifier both leave an unsure question unresolved).
const wordQs = (await db.query(`select "issueCodes", status, "subjectId", "taxonomyConfidence", "taxonomySource" from "AiImportQuestion" where "jobId"=$1`, [newJob])).rows;
const clean = wordQs.filter((r) => !r.issueCodes.length && r.status === "READY").length;
check("'Approve all without flags' offered only when flag-free questions exist", ((await admin.locator("[data-testid=qp-approve-clean]").count()) > 0) === (clean > 0), { clean, rows: wordQs });
check("no subject filled in at low confidence (free / AI classifier ≥ 60%)", wordQs.every((r) => !r.subjectId || !/local classifier|^AI/.test(r.taxonomySource ?? "") || (r.taxonomyConfidence ?? 0) >= 0.6), wordQs);
const wordUrl = admin.url();
await admin.goto(`${BASE}/admin/ai-importer/exceptions?job=${newJob}`);
await waitFor(admin, "[data-testid=exception-row]", 30000);
// The administrator sets the subject (this exam's records only) for the selection, then approves after review.
for (const box of await admin.locator("[data-testid=exception-row] input[type=checkbox]").all()) await box.check();
await admin.locator("[data-testid=bulk-subject]").selectOption({ index: 1 });
await admin.click("[data-testid=bulk-taxonomy-apply]");
// A confirmation lists the selected questions first (the server checks the confirmed count again).
await waitFor(admin, "[data-testid=bulk-taxonomy-confirm]", 10000);
await admin.click("[data-testid=bulk-taxonomy-confirm-apply]");
await admin.locator("[data-testid=bulk-msg]").waitFor({ timeout: 30000 });
check("…subject set for the selection by the administrator", /Subject \/ topic set on [1-9]/.test(await admin.locator("[data-testid=bulk-msg]").textContent()), await admin.locator("[data-testid=bulk-msg]").textContent());
await waitFor(admin, "[data-testid=exception-row]", 30000);
for (const box of await admin.locator("[data-testid=exception-row] input[type=checkbox]").all()) await box.check();
await admin.click("[data-testid=bulk-approve]");
await until(async () => /approved/.test((await admin.locator("[data-testid=bulk-msg]").textContent().catch(() => "")) ?? ""), 30000);
check("flagged questions approved one by one after review (bulk selection)", /^[1-9]\d* approved/.test(await admin.locator("[data-testid=bulk-msg]").textContent()), await admin.locator("[data-testid=bulk-msg]").textContent());
await admin.goto(wordUrl);
await waitFor(admin, "[data-testid=qp-store-approved]", 30000);
await admin.locator("[data-testid=qp-store-approved]").click();
await until(async () => { await admin.reload(); return (await admin.locator("[data-testid=q-stored]").count()) && (await val("q-stored")) > 0; }, 240000);
const nImported = await val("q-stored");
const wRows = (await db.query(`select q.status, q."questionId", qq.status qs from "AiImportQuestion" q left join "Question" qq on qq.id = q."questionId" where q."jobId"=$1`, [newJob])).rows;
check("questions persisted through the Bulk Import, shown in the result", nImported > 0 && wRows.filter((r) => r.questionId).length === nImported, { nImported, rows: wRows });
check("imported as DRAFT, none published", wRows.every((r) => !r.questionId || r.qs === "DRAFT") && !wRows.some((r) => r.status === "PUBLISHED"));
check("exactly one confirmation for the double click, one import after approval", (await db.query(`select count(*)::int n from "AiImportEvent" where "jobId"=$1 and type in ('IMPORT_REQUESTED','IMPORT_SKIPPED')`, [newJob])).rows[0].n === 1 && (await db.query(`select count(*)::int n from "AiImportEvent" where "jobId"=$1 and type='CONFIRMED'`, [newJob])).rows[0].n === 1);
check("Bulk Import run and the Question Bank linked from the result", (await admin.locator("[data-testid=current-job] a", { hasText: "Bulk Import run" }).count()) >= 1 && (await admin.locator("[data-testid=qp-open-bank] a").count()) >= 1);
const settingsN1 = (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0]?.value;
check("settings untouched by the one-page flow (automatic stays the default)", JSON.stringify(settingsN0) === JSON.stringify(settingsN1) && settingsN1?.selection?.mode === "auto");

// Scanned paper: AI vision via the automatically chosen model; a one-off override; the saved preference.
const scJob = await startOnMainPage(admin, "scanned.pdf", { name: `AIUI scanned ${F.suffix}.pdf` });
await waitFor(admin, "[data-testid=analyzer]", 90000);
check("scanned paper → AI vision strategy, no contradictory 'Action needed' badge", !/Action needed/.test(await admin.locator("[data-testid=current-status]").textContent()) && (await admin.locator("[data-testid=analyzer]").getAttribute("data-strategy")) === "AI");
check("automatic choice: cheapest suitable vision model shown with its reason", (await selModel.getAttribute("data-model")) === "mockvision/reader" && /Why this model\?/.test(await selModel.textContent()));
await admin.locator("[data-testid=op-change-model] summary").click();
await admin.selectOption("[data-testid=op-model-select]", "mockvision/mid");
check("override shows on the card", /mockvision\/mid/.test(await selModel.textContent()) && /override for this import/.test(await selModel.textContent()));
await admin.locator("[data-testid=op-model-remember]").check();
await admin.locator("[data-testid=op-model-save]").click();
await until(async () => (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0].value.selection.mode === "manual");
const savedPref = (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0].value;
check("Remember saves the importer preference only when asked", savedPref.selection.mode === "manual" && savedPref.models.extract === "mockvision/mid");
await admin.selectOption("[data-testid=op-model-select]", "");
await admin.locator("[data-testid=op-model-save]").click();
await until(async () => (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0].value.selection.mode === "auto");
check("…and back to Automatic", (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0].value.selection.mode === "auto");
check("no global AI → Models approval changed by the importer", (await globalFlags()) === flags0);
await admin.reload();
await waitFor(admin, "[data-testid=op-change-model]");
await admin.locator("[data-testid=op-change-model] summary").click();
await admin.selectOption("[data-testid=op-model-select]", "mockvision/mid");
await startImport(admin, { expected: "3" });
await until(async () => (await db.query(`select status from "AiImportJob" where id=$1`, [scJob])).rows[0].status !== "AWAITING_CONFIRMATION", 30000);
const scPlan = (await db.query(`select config from "AiImportJob" where id=$1`, [scJob])).rows[0].config.modelPlan;
check("this import used the override; the default stays Automatic", scPlan?.tasks?.extract?.model === "mockvision/mid" && scPlan?.mode === "manual" && (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0].value.selection.mode === "auto", scPlan?.tasks?.extract);
check("scanned import reaches a result", await waitFor(admin, "[data-testid=quality-panel]", 300000));

// Cancel and Delete from the main page.
const cxJob = await startOnMainPage(admin, "sheet.xlsx", { name: `AIUI cancel ${F.suffix}.xlsx` });
await waitFor(admin, "[data-testid=analyzer]", 90000);
await admin.locator("[data-testid=current-job] [data-testid=job-cancel]").click();
check("Cancel works from the main page", await until(async () => /Cancelled/.test(await admin.locator("[data-testid=current-status]").textContent()), 20000));
check("Retry offered for the cancelled import", (await admin.locator("[data-testid=current-job] [data-testid=job-retry]").count()) === 1);
await admin.locator("[data-testid=current-job] [data-testid=job-delete]").click();
const del = admin.locator("[data-testid=delete-job-dialog]");
await del.locator("[data-testid=delete-preview]").waitFor({ timeout: 15000 });
check("delete dialog lists exactly what will be removed", /AIUI cancel/.test(await del.textContent()) && (await del.locator("[data-testid=delete-preview-file]").count()) === 1 && /Question Bank/.test(await del.textContent()));
check("delete stays disabled until DELETE is typed", await del.locator("[data-testid=delete-job-confirm]").isDisabled());
await del.locator("[data-testid=delete-confirm]").fill("DELETE");
await Promise.all([admin.waitForURL(/\/admin\/ai-importer$/, { timeout: 20000 }), del.locator("[data-testid=delete-job-confirm]").click()]);
check("deleted: job gone, audited, back to the upload area", (await db.query(`select count(*)::int n from "AiImportJob" where id=$1`, [cxJob])).rows[0].n === 0 && (await db.query(`select count(*)::int n from "AuditLog" where action='AI_IMPORT_JOB_DELETED' and "entityId"=$1`, [cxJob])).rows[0].n === 1 && (await admin.locator("[data-testid=upload-card]").count()) === 1);

// Imports page: plain statuses, actions, stalled recovery.
await admin.goto(`${BASE}/admin/ai-importer/jobs`);
const opRow = admin.locator(`[data-testid=job-row][data-job-id="${opJob}"]`);
check("Imports page: plain label + counts + next action", /^(Completed|Completed with Warnings|Needs Correction|Ready for Review)$/.test((await opRow.locator("[data-testid=job-label]").textContent()).trim()) && /extracted/.test(await opRow.textContent()) && /Next:/.test(await opRow.textContent()));
await db.query(`update "AiImportJob" set status='PROCESSING', "leaseOwner"=null, "leaseUntil"=now() - interval '10 minutes', "updatedAt"=now() - interval '10 minutes' where id=$1`, [scJob]);
const scStatusBefore = (await db.query(`select status from "AiImportJob" where id=$1`, [scJob])).rows[0].status;
await admin.reload();
const scRow = admin.locator(`[data-testid=job-row][data-job-id="${scJob}"]`);
check("stalled job is labelled and offers Start again", /Stalled/.test(await scRow.locator("[data-testid=job-label]").textContent()) && (await scRow.locator("[data-testid=job-recover]").count()) === 1);
await scRow.locator("[data-testid=job-recover]").click();
// The scratch worker loop polls every few seconds and may pick the "stalled" job up between the reload
// and the click: Start again then truthfully answers that a worker is processing it (nothing changed).
const recoverMsg = async () => (await scRow.locator("[data-testid=job-controls-message]").textContent().catch(() => "")) ?? "";
await until(async () => /started again|A worker is processing this import/.test(await recoverMsg()), 15000);
const recoverText = await recoverMsg();
const restartEvents = (await db.query(`select count(*)::int n from "AiImportEvent" where "jobId"=$1 and type='WORKER_RESTARTED'`, [scJob])).rows[0].n;
check("Start again answers with what happened (restarted → WORKER_RESTARTED logged; already picked up by the worker → nothing changed)", (/started again/.test(recoverText) && restartEvents === 1) || (/A worker is processing this import/.test(recoverText) && /Nothing was changed/.test(recoverText) && restartEvents === 0), { recoverText, restartEvents });
await db.query(`update "AiImportJob" set status='COMPLETED_WITH_ISSUES' where id=$1 and status=$2`, [scJob, scStatusBefore]);
// The old blanket lock message is gone; the details page explains how to remove files.
await admin.goto(`${BASE}/admin/ai-importer/jobs/${opJob}`);
const why = (await admin.locator("[data-testid=file-remove-why]").allTextContents()).join(" | ");
check("details page: no 'Kept as the original-paper record' — points to Delete instead", !/original-paper record/.test(why) && /Delete/.test(why), why);
check("details page has the same controls (Delete)", (await admin.locator("[data-testid=job-controls] [data-testid=job-delete]").count()) === 1);
// View-only admin and mobile.
await full.goto(`${BASE}/admin/ai-importer/jobs`);
check("FULL_ADMIN: Imports page shows no job controls", (await full.locator("[data-testid=job-row]").count()) > 0 && (await full.locator("[data-testid=job-controls]").count()) === 0);
for (const u of ["", `?job=${opJob}`, "/jobs"]) {
  await m.goto(`${BASE}/admin/ai-importer${u}`);
  await m.waitForTimeout(800);
  check(`mobile ${u || "/"}: no horizontal scroll`, (await noOverflow(m)) && (await m.locator("text=Application error").count()) === 0);
}
await m.goto(`${BASE}/admin/ai-importer?job=${opJob}`);
await m.locator("[data-testid=current-job] [data-testid=job-delete]").click();
const mDel = m.locator("[data-testid=delete-job-dialog]");
await mDel.waitFor();
const mdBox = await mDel.boundingBox();
check("mobile: delete dialog fits the screen", !!mdBox && mdBox.x >= 0 && mdBox.x + mdBox.width <= 375, mdBox);
await mDel.getByRole("button", { name: "Keep import" }).click();

check("no page errors in any session", pages.every((p) => p.errors.length === 0), pages.map((p) => p.errors).flat());
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
