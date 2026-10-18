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
await admin.goto(`${BASE}/admin/ai-importer`);
await admin.fill("[data-testid=ai-title]", `AIUI digital ${F.suffix}`);
await admin.selectOption("[data-testid=ai-exam]", F.examId);
await admin.selectOption("[data-testid=ai-pyq]", F.paperId);
await admin.fill("[data-testid=ai-year]", "2024");
await admin.fill("[data-testid=ai-budget]", "8");
await Promise.all([admin.waitForURL(/\/admin\/ai-importer\/jobs\/[a-z0-9]+$/, { timeout: 30000 }), admin.click("[data-testid=create-import]")]);
const jobId = admin.url().split("/").pop();
check("job created", !!jobId);
await admin.locator("[data-testid=upload-input]").setInputFiles(path.join(FX, "digital-clean.pdf"));
await admin.locator("[data-testid=upload-progress] li", { hasText: "2 page(s)" }).waitFor({ timeout: 60000 });
check("upload progress reports PDF, 2 pages", true);
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
await admin.fill("[data-testid=confirm-budget]", "8");
await admin.click("[data-testid=confirm-start]");
const st1 = await waitStatus(admin, /Ready to import/, 180000);
check("processing finished → Ready to import", /Ready to import/.test(st1), st1);
check("job page shows the models chosen at confirmation, with the reason", (await admin.locator("[data-testid=plan-extract]").getAttribute("data-model")) === "mockvision/reader" && /Cheapest suitable/.test((await admin.locator("[data-testid=plan-extract]").textContent()) ?? ""));
const blockedNote = (await admin.locator("[data-testid=files-remove-blocked]").textContent().catch(() => "")) ?? "";
check("after processing, Remove is disabled with the reason shown", /Processing has started/.test(blockedNote) && (await admin.locator("[data-testid=file-remove]:not([disabled])").count()) === 0 && (await admin.locator("[data-testid=file-remove]").count()) > 0, blockedNote);
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
section("D. Import & Publish All Eligible (existing Bulk Import underneath)");
await admin.goto(`${BASE}/admin/ai-importer/jobs/${jobId}`);
await admin.click("[data-testid=import-publish-all]");
const st2 = await waitStatus(admin, /Completed/, 240000);
check("import finished (completed, possibly with issues)", /Completed/.test(st2), st2);
const pub = (await db.query(`select "sourceLabel", status, "questionId" from "AiImportQuestion" where "jobId"=$1 order by "orderIndex"`, [jobId])).rows;
const published = pub.filter((r) => r.status === "PUBLISHED");
check("eligible questions published (incl. option-image Q3, admin-answered Q2)", published.some((r) => r.sourceLabel === "3") && published.some((r) => r.sourceLabel === "2"), pub);
check("Q8 (answer unverified) imported but not published", pub.find((r) => r.sourceLabel === "8")?.status === "IMPORTED", pub.find((r) => r.sourceLabel === "8"));
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
check("Cost Center shows calls (classification) with cost", (await admin.locator("[data-testid=cost-calls] tbody tr").count()) > 0);

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
check("FULL_ADMIN can view but not start an import", (await full.locator("text=You can view imports but not start one").count()) === 1 && (await full.locator("[data-testid=create-import]").count()) === 0);
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
await admin.goto(`${BASE}/admin/ai-importer`);
await admin.fill("[data-testid=ai-title]", `AIUI remove ${F.suffix}`);
await admin.selectOption("[data-testid=ai-exam]", F.examId);
await admin.fill("[data-testid=ai-budget]", "5");
await Promise.all([admin.waitForURL(/\/admin\/ai-importer\/jobs\/[a-z0-9]+$/, { timeout: 30000 }), admin.click("[data-testid=create-import]")]);
const rmJob = admin.url().split("/").pop();
const row = (name) => admin.locator("[data-testid=file-row]", { hasText: name });
await admin.locator("[data-testid=upload-input]").setInputFiles(path.join(FX, "digital-clean.pdf"));
await admin.locator("[data-testid=upload-progress] li", { hasText: "2 page(s)" }).waitFor({ timeout: 60000 });
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
check("server refusal shown in the dialog (job started meanwhile)", /Processing has started/.test(await dlg.locator("[data-testid=remove-file-error]").textContent()));
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
const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8"));
const removeActionId = Object.entries(manifest.node).find(([, v]) => v.exportedName === "removeFileAction" || JSON.stringify(v).includes("removeFileAction"))?.[0];
const keyId = (await db.query(`select id from "AiImportFile" where "jobId"=$1 and "originalName"='key-digital.pdf'`, [rmJob])).rows[0].id;
const rawRemove = await inPage(full, `/admin/ai-importer/jobs/${rmJob}`, { method: "POST", headers: { "Next-Action": removeActionId, Accept: "text/x-component", "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify([rmJob, keyId]) });
check("FULL_ADMIN raw removeFileAction call is refused", !!removeActionId && /do not have permission/.test(rawRemove.text), { id: removeActionId, status: rawRemove.status, text: rawRemove.text.slice(-200) });
check("…and the file still exists", (await db.query(`select count(*)::int n from "AiImportFile" where id=$1`, [keyId])).rows[0].n === 1);

check("no page errors in any session", pages.every((p) => p.errors.length === 0), pages.map((p) => p.errors).flat());
await browser.close();
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "SOME CHECKS FAILED" : "ALL PASS");
process.exit(fail ? 1 : 0);
