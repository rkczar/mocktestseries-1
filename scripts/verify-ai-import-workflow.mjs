/**
 * AI Question Importer — explicit Submit & Analyze workflow, chunked reference papers, AI Configuration.
 * Scratch only (synthetic DB + mocked OpenRouter; no paid call is made):
 *
 *   BASE=http://localhost:3561 FX_DIR=<fixtures> FIXTURE=<ai-import-ui-fixture.json> ADMIN_USER=… ADMIN_PASS=… \
 *   DATABASE_URL=<scratch> AI_IMPORT_VAULT_DIR=<scratch vault> NODE_PATH=<playwright> node scripts/verify-ai-import-workflow.mjs
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE;
const FX = process.env.FX_DIR;
const VAULT = process.env.AI_IMPORT_VAULT_DIR;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const db = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/\?.*$/, "") });
if (!/mts_|scratch|test/.test(process.env.DATABASE_URL)) throw new Error("Refusing: DATABASE_URL is not a scratch database.");
await db.connect();

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`}`);
}
const section = (s) => console.log(`\n== ${s}`);
async function until(fn, timeout = 15000, step = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/** A valid digital PDF with one numbered question and an unreferenced filler stream of `fillBytes`. */
function syntheticPdf(fillBytes = 0, lead = "") {
  const lines = ["1. Which organ produces insulin?", "(A) Liver", "(B) Pancreas", "(C) Kidney", "(D) Spleen", "2. Which vitamin is fat soluble?", "(A) Vitamin C", "(B) Vitamin B1", "(C) Vitamin D", "(D) Vitamin B12"];
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? "0 -20 Td " : ""}(${l}) Tj`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (fillBytes) objs.push(`<< /Length ${fillBytes} >>\nstream\n${"0".repeat(fillBytes)}\nendstream`);
  let out = `${lead}%PDF-1.4\n`;
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, "latin1") - Buffer.byteLength(lead, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1") - Buffer.byteLength(lead, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const browser = await chromium.launch();
async function newPage({ mobile = false } = {}) {
  const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e).slice(0, 200)));
  page.on("dialog", (d) => d.accept().catch(() => {}));
  // Largest request body sent by the page (no single request may come near nginx's 20 MB limit).
  page.maxBody = 0;
  page.on("request", (r) => {
    const b = r.postDataBuffer();
    if (b && b.length > page.maxBody) page.maxBody = b.length;
  });
  return page;
}
async function adminLogin(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", process.env.ADMIN_USER);
  await page.fill("input[name=password]", process.env.ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const jobCount = async () => Number((await db.query(`select count(*) from "AiImportJob"`)).rows[0].count);
const jobsTitled = async (t) => (await db.query(`select id from "AiImportJob" where title=$1`, [t])).rows.map((r) => r.id);
const refs = async (jobId) => (await db.query(`select data from "AiImportEvent" where "jobId"=$1 and type='REFERENCE_ADDED' order by "createdAt"`, [jobId])).rows.map((r) => r.data);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const file = (name, buffer, mimeType = "application/octet-stream") => ({ name, mimeType, buffer });
const slotStatus = (page, slot) => page.locator(`[data-testid=op-slot-${slot}]`).getAttribute("data-status");

async function fillForm(page, { expected = "3", pyq = true } = {}) {
  await page.goto(`${BASE}/admin/ai-importer`);
  await page.selectOption("[data-testid=op-exam]", F.examId);
  if (pyq) await page.selectOption("[data-testid=op-pyq]", F.paperId);
  if (expected) await page.fill("[data-testid=op-expected]", expected);
}
async function submitAndWait(page) {
  await Promise.all([page.waitForURL(/\/admin\/ai-importer\?job=[a-z0-9]+/, { timeout: 120000 }), page.locator("[data-testid=op-submit]").click()]);
  return new URL(page.url()).searchParams.get("job");
}

const admin = await newPage();
await adminLogin(admin);
await db.query(`update "Setting" set value = jsonb_set(value, '{aiEnabled}', 'true') where key='ai.importer'`);

section("A. Choosing files never starts an upload; Submit & Analyze is explicit and validated");
const before = await jobCount();
await admin.goto(`${BASE}/admin/ai-importer`);
check("Submit & Analyze button present and disabled on an empty form", (await admin.locator("[data-testid=op-submit]").isDisabled()) && /To continue/.test(await admin.locator("[data-testid=op-submit-hint]").textContent()));
await admin.selectOption("[data-testid=op-exam]", F.examId);
await admin.selectOption("[data-testid=op-pyq]", F.paperId);
await admin.locator("[data-testid=op-upload-input]").setInputFiles(path.join(FX, "paper.docx"));
await new Promise((r) => setTimeout(r, 1500));
check("choosing the paper does not create a job or upload anything", (await jobCount()) === before && /\/admin\/ai-importer$/.test(admin.url()) && (await slotStatus(admin, "paper")) === "ready");
check("selected file name + size shown", /paper\.docx · \d+\.\d MB/.test(await admin.locator("[data-testid=op-paper-name]").textContent()));
check("still disabled without the expected count, hint names the missing step", (await admin.locator("[data-testid=op-submit]").isDisabled()) && /expected number/.test(await admin.locator("[data-testid=op-submit-hint]").textContent()));
await admin.fill("[data-testid=op-expected]", "3");
check("enabled once exam, paper, count and file are valid", !(await admin.locator("[data-testid=op-submit]").isDisabled()));

section("B. Unsupported / malformed references are explained before upload");
await admin.locator("[data-testid=op-reference-input]").setInputFiles(path.join(FX, "paper.doc"));
check(".doc reference: exact reason (save as .docx/PDF), Submit disabled", /\.docx or PDF/.test(await admin.locator("[data-testid=op-reference-invalid]").textContent()) && (await admin.locator("[data-testid=op-submit]").isDisabled()));
await admin.locator("[data-testid=op-reference-input]").setInputFiles(file("notes.txt", Buffer.from("1. a\n2. b\n"), "text/plain"));
check(".txt reference: not supported + the supported formats listed", /not supported\. Supported: PDF, Word/.test(await admin.locator("[data-testid=op-reference-invalid]").textContent()));
await admin.locator("[data-testid=op-reference-input]").setInputFiles(file("empty.pdf", Buffer.alloc(0), "application/pdf"));
check("empty reference: refused before upload", /empty/.test(await admin.locator("[data-testid=op-reference-invalid]").textContent()));
await admin.locator("[data-testid=op-reference-remove]").click();
check("Remove clears the reference; Submit enabled again", (await slotStatus(admin, "reference")) === "empty" && !(await admin.locator("[data-testid=op-submit]").isDisabled()));

section("C. 21 MB PDF reference (the size nginx refused in one request), odd MIME type, + answer key");
const big = syntheticPdf(21 * 1024 * 1024);
await admin.locator("[data-testid=op-key-input]").setInputFiles(path.join(FX, "key.csv"));
await admin.locator("[data-testid=op-reference-input]").setInputFiles(file("Reference 2024 (scan).pdf", big, "application/octet-stream"));
check("reference ready, 21+ MB shown", /2[01]\.\d MB/.test(await admin.locator("[data-testid=op-reference-name]").textContent()) && (await slotStatus(admin, "reference")) === "ready");
admin.maxBody = 0;
const bigJob = await submitAndWait(admin);
check("job created and analyzed page opened", !!bigJob);
check("no request body above 8 MB (chunked), so nginx's 20 MB limit is never reached", admin.maxBody > 0 && admin.maxBody <= 8 * 1024 * 1024 + 1024, admin.maxBody);
const r1 = await refs(bigJob);
check("reference linked to the right job, original bytes preserved (sha256)", r1.length === 1 && r1[0].sha256 === sha(big) && r1[0].bytes === big.length && r1[0].kind === "pdf", r1.map((r) => ({ kind: r.kind, bytes: r.bytes })));
check("original file kept in the vault", !!r1[0] && existsSync(path.join(VAULT, r1[0].storageKey)));
check("reference read locally (question found)", r1[0]?.questions?.length >= 1, r1[0]?.questions?.length);
check("paper + key stored once each", Number((await db.query(`select count(*) from "AiImportFile" where "jobId"=$1`, [bigJob])).rows[0].count) === 2);
check("no leftover upload parts in the vault tmp area", !readdirSync(path.join(VAULT, "tmp")).some((d) => d.startsWith("ru")));
const analyzed = await until(async () => (await admin.locator("[data-testid=op-confirm]").count()) > 0 || (await admin.reload(), false), 120000, 2000);
check("analysis finished: cost confirmation shown", analyzed);
check("price confirmation unchanged: Start disabled until the cost is confirmed", analyzed && (await admin.locator("[data-testid=process-import]").isDisabled()));
await admin.locator("[data-testid=op-confirm-check]").check();
check("…and enabled only after the explicit confirmation", !(await admin.locator("[data-testid=process-import]").isDisabled()));
check("nothing charged by Submit & Analyze", Number((await db.query(`select "spentInr" from "AiImportJob" where id=$1`, [bigJob])).rows[0].spentInr) === 0);

section("D. DOCX, scanned and preamble PDFs are accepted as references");
for (const [label, f, expect] of [
  ["DOCX reference", file("Clean copy.docx", readFileSync(path.join(FX, "paper.docx")), ""), (r) => r.kind === "docx" && r.questions.length > 0],
  ["scanned PDF reference (kept, note explains no text layer)", file("scanned ref.pdf", readFileSync(path.join(FX, "scanned.pdf")), "application/pdf"), (r) => r.kind === "pdf" && /no text layer/.test(r.note ?? "")],
  ["PDF with a 300-byte preamble before %PDF-", file("gateway.pdf", syntheticPdf(0, "X".repeat(300)), "application/pdf"), (r) => r.kind === "pdf"],
]) {
  await fillForm(admin);
  await admin.locator("[data-testid=op-upload-input]").setInputFiles(path.join(FX, "paper.docx"));
  await admin.locator("[data-testid=op-reference-input]").setInputFiles(f);
  const id = await submitAndWait(admin);
  const r = (await refs(id))[0];
  check(label, !!r && expect(r), r && { kind: r.kind, q: r.questions.length, note: r.note });
}

section("E. Server-side refusal shows the stage + exact reason; Replace + Retry continue the SAME job");
await fillForm(admin);
await admin.locator("[data-testid=op-upload-input]").setInputFiles(path.join(FX, "paper.docx"));
await admin.locator("[data-testid=op-reference-input]").setInputFiles(file("renamed.pdf", readFileSync(path.join(FX, "photo.png")), "application/pdf"));
const n0 = await jobCount();
await admin.locator("[data-testid=op-submit]").click();
await admin.locator("[data-testid=op-upload-error]").waitFor({ timeout: 60000 });
const err = await admin.locator("[data-testid=op-upload-error]").textContent();
check("PNG named .pdf: 'File check failed' + named .pdf but content PNG", /File check failed/.test(err) && /named \.pdf but its content is PNG/.test(err), err);
check("reference slot marked failed, paper slot uploaded", (await slotStatus(admin, "reference")) === "failed" && (await slotStatus(admin, "paper")) === "uploaded");
check("one job created; Retry button + draft note shown", (await jobCount()) === n0 + 1 && /Retry/.test(await admin.locator("[data-testid=op-submit]").textContent()) && (await admin.locator("[data-testid=op-draft-note]").count()) === 1);
check("paper locked, reference replaceable", (await admin.locator("[data-testid=op-paper-button]").isDisabled()) && !(await admin.locator("[data-testid=op-reference-button]").isDisabled()));
await admin.locator("[data-testid=op-reference-input]").setInputFiles(file("renamed fixed.pdf", syntheticPdf(), "application/pdf"));
const eJob = await submitAndWait(admin);
check("retry finished on the same job (no duplicate job)", (await jobCount()) === n0 + 1);
check("paper not uploaded twice; reference added", Number((await db.query(`select count(*) from "AiImportFile" where "jobId"=$1`, [eJob])).rows[0].count) === 1 && (await refs(eJob)).length === 1);

section("F. Cancel during upload, then retry");
await fillForm(admin);
await admin.locator("[data-testid=op-upload-input]").setInputFiles(path.join(FX, "paper.docx"));
await admin.locator("[data-testid=op-reference-input]").setInputFiles(file("slow.pdf", syntheticPdf(10 * 1024 * 1024), "application/pdf"));
await admin.route("**/references/uploads/*/chunks/*", async (route) => {
  await new Promise((r) => setTimeout(r, 2500));
  await route.continue().catch(() => {});
});
const n1 = await jobCount();
await admin.locator("[data-testid=op-submit]").click();
await admin.locator("[data-testid=op-reference-progress]").waitFor({ timeout: 60000 });
check("progress bar shown while the reference uploads", (await admin.locator("[data-testid=op-reference-progress]").count()) === 1);
await admin.locator("[data-testid=op-cancel]").click();
await admin.locator("[data-testid=op-upload-error]").waitFor({ timeout: 30000 });
check("cancel: says cancelled, finished uploads kept", /Cancelled/.test(await admin.locator("[data-testid=op-upload-error]").textContent()));
check("cancelled parts removed from the vault", await until(() => !readdirSync(path.join(VAULT, "tmp")).some((d) => d.startsWith("ru")), 10000));
await admin.unroute("**/references/uploads/*/chunks/*");
const fJob = await submitAndWait(admin);
check("retry after cancel: same job, reference added", (await jobCount()) === n1 + 1 && (await refs(fJob)).length === 1);

section("G. Duplicate submit → one job");
await fillForm(admin);
await admin.locator("[data-testid=op-upload-input]").setInputFiles(file("Double click paper.docx", readFileSync(path.join(FX, "paper.docx"))));
await admin.locator("[data-testid=op-submit]").dblclick();
await admin.waitForURL(/\?job=/, { timeout: 90000 });
await new Promise((r) => setTimeout(r, 1500));
check("double click created exactly one job", (await jobsTitled("Double click paper")).length === 1, await jobsTitled("Double click paper"));

section("H. AI Configuration = Import Settings; unavailable models never shown as selected");
// Models are installed through the existing Import Settings workflow (mocked provider routes).
await admin.goto(`${BASE}/admin/ai-importer/settings`);
for (const id of ["mockvision/reader", "mockvision/checker", "mockvision/mid", "mocktext/classifier"]) {
  await admin.locator("[data-testid=importer-model-search]").fill(id);
  await admin.locator(`[data-testid=importer-model-hits] li[data-model-id="${id}"] [data-testid=importer-model-add]`).click();
}
await admin.locator("[data-testid=routes-refresh]").click();
await until(async () => (await admin.locator("[data-testid=sel-extract]").getAttribute("data-model")) === "mockvision/reader", 30000);
await admin.locator("[data-testid=settings-save]").click();
await admin.locator("[data-testid=settings-msg]").waitFor();
await admin.goto(`${BASE}/admin/ai-importer/settings`);
const settingsPlan = {};
for (const t of ["extract", "verify", "key", "classify"]) settingsPlan[t] = (await admin.locator(`[data-testid=sel-${t}]`).first().getAttribute("data-model").catch(() => null)) ?? "";
await admin.goto(`${BASE}/admin/ai-importer`);
const importPlan = {};
for (const t of ["extract", "verify", "key", "classify"]) importPlan[t] = await admin.locator(`[data-testid=op-ai-stage][data-task=${t}]`).getAttribute("data-model");
check("4 stages shown on the import page (paid AI on)", (await admin.locator("[data-testid=op-ai-stage]").count()) === 4 && (await admin.locator("[data-testid=op-ai-config]").getAttribute("data-ai")) === "on");
check("import page shows the same model per stage as Import Settings", JSON.stringify(importPlan) === JSON.stringify(settingsPlan), { importPlan, settingsPlan });
check("at least the page-reading stage has a model in this fixture", !!importPlan.extract, importPlan);
const savedSettings = (await db.query(`select value from "Setting" where key='ai.importer'`)).rows[0].value;
await db.query(`update "Setting" set value = jsonb_set(value, '{importerModels}', '[]') where key='ai.importer'`);
await admin.reload();
const unavailable = await admin.locator("[data-testid=op-ai-stage]").allTextContents();
check("no importer models: every stage says Not available with the reason, none shown selected", unavailable.length === 4 && unavailable.every((s) => /Not available/.test(s)) && (await admin.locator("[data-testid=op-ai-stage][data-model='']").count()) === 4, unavailable);
await db.query(`update "Setting" set value = $1 where key='ai.importer'`, [savedSettings]);
await db.query(`update "Setting" set value = jsonb_set(value, '{aiEnabled}', 'false') where key='ai.importer'`);
await admin.reload();
check("paid AI off: stages say local reader only, override hidden", (await admin.locator("[data-testid=op-ai-config]").getAttribute("data-ai")) === "off" && (await admin.locator("[data-testid=op-ai-override]").count()) === 0 && /Local reader only/.test(await admin.locator("[data-testid=op-ai-stages]").textContent()));
await db.query(`update "Setting" set value = jsonb_set(value, '{aiEnabled}', 'true') where key='ai.importer'`);

section("I. Manual override carries to the cost confirmation (checked there, nothing saved)");
await fillForm(admin);
const models = (await admin.locator("[data-testid=op-ai-override] option").allTextContents()).filter((m) => !/Automatic/.test(m));
check("override lists the importer's own models", models.length > 0, models);
const pick = models.find((m) => m === "mockvision/mid") ?? models[0];
await admin.selectOption("[data-testid=op-ai-override]", pick);
await admin.locator("[data-testid=op-upload-input]").setInputFiles(file("Override scan.pdf", readFileSync(path.join(FX, "scanned.pdf")), "application/pdf"));
const oJob = await submitAndWait(admin);
check("URL carries the override", new URL(admin.url()).searchParams.get("model") === pick, admin.url());
await until(async () => (await admin.locator("[data-testid=selected-model]").count()) > 0 || (await admin.reload(), false), 90000, 2000);
check("confirmation shows the override for this import", (await admin.locator("[data-testid=selected-model]").textContent()).includes(pick) && /override for this import/.test(await admin.locator("[data-testid=selected-model]").textContent()));
check("override not saved as the importer default", JSON.stringify((await db.query(`select value->'selection' s from "Setting" where key='ai.importer'`)).rows[0].s) === JSON.stringify(savedSettings.selection));
check("override job: nothing charged before confirmation", Number((await db.query(`select "spentInr" from "AiImportJob" where id=$1`, [oJob])).rows[0].spentInr) === 0);

section("J. Single-request reference route still answers JSON (job details panel compatibility)");
const small = await admin.evaluate(async (id) => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "tiny.pdf"));
  const r = await fetch(`/api/admin/ai-importer/references/${id}`, { method: "POST", body: fd });
  return { status: r.status, body: await r.text() };
}, oJob);
check("malformed tiny PDF via the old route → JSON reason, not a bare refusal", small.status === 400 && /"error"/.test(small.body), small);

section("K. Mobile layout");
const mobile = await newPage({ mobile: true });
await adminLogin(mobile);
await mobile.goto(`${BASE}/admin/ai-importer`);
await mobile.locator("[data-testid=op-upload-input]").setInputFiles(file("A very long question paper file name for the mobile layout check 2024 final.docx", readFileSync(path.join(FX, "paper.docx"))));
await mobile.locator("[data-testid=op-reference-input]").setInputFiles(file("Another long reference paper name that should wrap on a phone.pdf", syntheticPdf(), "application/pdf"));
check("375 px: no horizontal overflow with files chosen", await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check("375 px: Submit button visible full width", (await mobile.locator("[data-testid=op-submit]").boundingBox()).width >= 300);

check("no page errors", admin.errors.length === 0 && mobile.errors.length === 0, [...admin.errors, ...mobile.errors]);
await browser.close();
await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
