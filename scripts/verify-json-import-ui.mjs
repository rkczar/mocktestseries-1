/**
 * JSON question import (docs/JSON-IMPORT.md) — real browser + real upload route.
 *
 * Drives a LOCAL production build on a DISPOSABLE database (a production copy
 * with RUHS MO + NEET UG) as an admin through Admin → Questions → Bulk Import:
 *   - the five example .json downloads equal docs/json-import-examples/, and the
 *     JSON package .zip downloads;
 *   - Standard mode: a .json file → validated workspace → Import → DRAFT
 *     questions, run format JSON; a broken file and a Rich-only file are
 *     refused with their precise problems and no run;
 *   - Rich mode: a JSON package .zip (questions.json + images) in the question
 *     file slot → images processed → preview → import → DRAFT with assets;
 *     a .json + separate image bundle; package + bundle together is refused;
 *   - Standard mode's file picker does not offer .zip; no page errors.
 * Runs created by ADMIN_USER are removed at the start and the end (scratch only).
 *
 *   BASE=http://localhost:3131 ADMIN_USER=… ADMIN_PASS=… DATABASE_URL=<scratch> STORAGE_DIR=<server's storage> \
 *     NODE_PATH=<dir with playwright> node scripts/verify-json-import-ui.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const { chromium } = load("playwright");
const { Client } = load("pg");

const BASE = process.env.BASE || "http://localhost:3131";
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
}

const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, "") });
await db.connect();
const admin = (await db.query(`select id from "AdminUser" where username = $1`, [process.env.ADMIN_USER])).rows[0];
async function cleanup() {
  const runs = (await db.query(`select id, "bundleId" from "BulkImportRun" where "adminUserId" = $1`, [admin.id])).rows;
  for (const r of runs) {
    await db.query(`delete from "Question" where "importBatchId" = $1`, [r.id]);
    await db.query(`delete from "BulkImportRun" where id = $1`, [r.id]);
    if (r.bundleId) await db.query(`delete from "ImportBundle" where id = $1`, [r.bundleId]);
  }
  await db.query(`delete from "ImportBundle" where "createdById" = $1`, [admin.id]);
}
await cleanup();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-import-ui-"));
const suffix = Date.now().toString(36).toUpperCase();
const examples = path.join(process.cwd(), "docs", "json-import-examples");
/** An example with codes and question text made unique to this run. */
function fixture(id, name = `${id}.json`) {
  const d = JSON.parse(fs.readFileSync(path.join(examples, `${id}.json`), "utf8"));
  for (const q of d.questions) {
    q.code = `${q.code}-UI${suffix}`;
    if (typeof q.question === "string") q.question += ` [UI ${suffix}]`;
    else q.question.text += ` [UI ${suffix}]`;
  }
  fs.writeFileSync(path.join(dir, name), JSON.stringify(d, null, 2));
  return path.join(dir, name);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
// Production serves /media/ from storage with nginx (never Node); with STORAGE_DIR set, do the same here.
if (process.env.STORAGE_DIR) {
  await ctx.route("**/media/**", (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/media\//, ""));
    const file = path.join(process.env.STORAGE_DIR, "media", rel);
    if (rel.includes("..") || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: file.endsWith(".webp") ? "image/webp" : "application/octet-stream", body: fs.readFileSync(file) });
  });
}

const inPage = (url) =>
  page.evaluate(async (u) => {
    const r = await fetch(u);
    const buf = new Uint8Array(await r.arrayBuffer());
    let bin = "";
    for (const b of buf) bin += String.fromCharCode(b);
    return { status: r.status, type: r.headers.get("content-type"), b64: btoa(bin) };
  }, url);

async function selectByText(select, re) {
  const value = await select.evaluate((el, src) => [...el.options].find((o) => new RegExp(src, "i").test(o.textContent))?.value ?? null, re.source);
  if (!value) throw new Error(`no option matching ${re}`);
  await select.selectOption(value);
}

/** Upload form → returns { runId } once the workspace shows, or { error } for a refused file. */
async function upload({ examRe, rich, file, bundle }) {
  await page.goto(`${BASE}/admin/questions/bulk-import`);
  await selectByText(page.locator("select").first(), examRe);
  if (rich) await page.locator("input[name=importMode][value=RICH]").check();
  await page.locator("#file-upload").setInputFiles(file);
  if (bundle) await page.locator("#bundle-upload").setInputFiles(bundle);
  await page.getByRole("button", { name: /Upload & Validate/ }).click();
  const outcome = await Promise.race([
    page.waitForURL(/runId=/, { timeout: 180000 }).then(() => "run"),
    page.getByText(/JSON file refused|JSON package ZIP already contains|Failed to parse/).first().waitFor({ timeout: 180000 }).then(() => "error"),
  ]);
  if (outcome === "error") return { error: await page.getByText(/JSON file refused|JSON package ZIP already contains|Failed to parse/).first().innerText() };
  await page.getByText("Start New Import").waitFor({ timeout: 60000 });
  return { runId: new URL(page.url()).searchParams.get("runId") };
}
const runApi = async (runId) => JSON.parse(Buffer.from((await inPage(`/api/admin/questions/bulk-import/runs/${runId}?pageSize=all`)).b64, "base64").toString("utf8"));

// ------------------------------------------------------------------ login
await page.goto(`${BASE}/admin/login`);
await page.fill("input[name=username]", process.env.ADMIN_USER);
await page.fill("input[name=password]", process.env.ADMIN_PASS);
await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);

// ------------------------------------------------------------------ downloads
await page.goto(`${BASE}/admin/questions/bulk-import`);
check("Standard mode: JSON example links shown", (await page.locator("[data-testid=json-examples]").count()) === 1);
check("Standard mode: file picker takes .json, not .zip", (await page.locator("#file-upload").getAttribute("accept")) === ".csv,.xls,.xlsx,.json");
for (const id of ["ruhs-mo", "neet-ug-rich", "with-images", "multiple-correct", "match-the-following"]) {
  const r = await inPage(`/api/admin/questions/bulk-import/rich-template?file=json&example=${id}`);
  check(`download ${id}.json = docs file`, r.status === 200 && /application\/json/.test(r.type) && Buffer.from(r.b64, "base64").toString("utf8") === fs.readFileSync(path.join(examples, `${id}.json`), "utf8"), r.status);
}
const unknown = await inPage(`/api/admin/questions/bulk-import/rich-template?file=json&example=../../etc/passwd`);
check("unknown example id → 404", unknown.status === 404);
const pkg = await inPage(`/api/admin/questions/bulk-import/rich-template?file=json-package`);
const pkgBytes = Buffer.from(pkg.b64, "base64");
check("JSON package .zip download", pkg.status === 200 && pkgBytes.subarray(0, 2).toString() === "PK" && pkgBytes.includes(Buffer.from("questions.json")));
const pkgPath = path.join(dir, "json-package-example.zip");
fs.writeFileSync(pkgPath, pkgBytes);
const sample = await inPage(`/api/admin/questions/bulk-import/rich-template?file=zip`);
const samplePath = path.join(dir, "sample-images.zip");
fs.writeFileSync(samplePath, Buffer.from(sample.b64, "base64"));

// ------------------------------------------------------------------ Standard
{
  const { runId, error } = await upload({ examRe: /RUHS/, rich: false, file: fixture("ruhs-mo") });
  check("Standard .json → validated workspace", !!runId, error);
  const r = await runApi(runId);
  check("Standard run: 3 rows, 0 errors", r.summary.total === 3 && r.summary.errors === 0, r.summary);
  const run = (await db.query(`select format, filename from "BulkImportRun" where id = $1`, [runId])).rows[0];
  check("import history: format JSON + file name", run.format === "JSON" && run.filename === "ruhs-mo.json", run);
  await page.getByRole("button", { name: "Import Questions" }).click();
  const ack = page.locator("[data-testid=ack-warnings]");
  if (await ack.isVisible({ timeout: 3000 }).catch(() => false)) {
    await ack.click();
    await page.locator("[data-testid=confirm-import]").click();
  }
  await page.getByText(/Import finished/).waitFor({ timeout: 60000 });
  const qs = (await db.query(`select status from "Question" where "importBatchId" = $1`, [runId])).rows;
  check("Standard import: 3 questions, all DRAFT", qs.length === 3 && qs.every((q) => q.status === "DRAFT"), qs);
}
{
  const bad = path.join(dir, "broken.json");
  fs.writeFileSync(bad, JSON.stringify({ questions: [{ subject: "Anatomy", question: "x", options: ["a", "b", "c"], correct: "E" }] }));
  const before = (await db.query(`select count(*)::int n from "BulkImportRun" where "adminUserId" = $1`, [admin.id])).rows[0].n;
  const { error } = await upload({ examRe: /RUHS/, rich: false, file: bad });
  check("broken JSON refused with the precise problem", /JSON file refused/.test(error ?? "") && /Question 1 › options/.test(error ?? ""), error);
  check("…and no run is created", (await db.query(`select count(*)::int n from "BulkImportRun" where "adminUserId" = $1`, [admin.id])).rows[0].n === before);
  const { error: e2 } = await upload({ examRe: /NEET/, rich: false, file: fixture("neet-ug-rich", "neet-standard.json") });
  check("Rich-only JSON in Standard mode → asks for Rich content mode", /Rich content/.test(e2 ?? ""), e2);
  const notJson = path.join(dir, "notjson.json");
  fs.writeFileSync(notJson, "{ this is not json");
  const { error: e3 } = await upload({ examRe: /RUHS/, rich: false, file: notJson });
  check("invalid JSON syntax refused", /not valid JSON/.test(e3 ?? ""), e3);
}

// ------------------------------------------------------------------ CSV / XLS / XLSX through the same route (regression)
{
  const XLSX = load("xlsx");
  const rows = (tag) => [
    { "Question Code": "", Subject: "Anatomy", "Question Text": `Spreadsheet regression ${tag} [${suffix}]`, "Option A": "1", "Option B": "2", "Option C": "3", "Option D": "4", "Correct Answer": "B", Difficulty: "EASY", Status: "DRAFT" },
  ];
  const files = {
    csv: () => fs.writeFileSync(path.join(dir, "reg.csv"), XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows("csv")))),
    xlsx: () => XLSX.writeFile(Object.assign(XLSX.utils.book_new(), { SheetNames: ["Q"], Sheets: { Q: XLSX.utils.json_to_sheet(rows("xlsx")) } }), path.join(dir, "reg.xlsx")),
    xls: () => XLSX.writeFile(Object.assign(XLSX.utils.book_new(), { SheetNames: ["Q"], Sheets: { Q: XLSX.utils.json_to_sheet(rows("xls")) } }), path.join(dir, "reg.xls"), { bookType: "xls" }),
  };
  for (const [ext, write] of Object.entries(files)) {
    write();
    const { runId, error } = await upload({ examRe: /RUHS/, rich: false, file: path.join(dir, `reg.${ext}`) });
    const run = runId ? (await db.query(`select format from "BulkImportRun" where id = $1`, [runId])).rows[0] : null;
    const r = runId ? await runApi(runId) : null;
    check(`${ext.toUpperCase()} upload unchanged: run format ${ext.toUpperCase()}, 1 row, 0 errors`, run?.format === ext.toUpperCase() && r.summary.total === 1 && r.summary.errors === 0, error ?? { run, s: r?.summary });
  }
}

// ------------------------------------------------------------------ Rich: JSON package
{
  await page.goto(`${BASE}/admin/questions/bulk-import`);
  await page.locator("input[name=importMode][value=RICH]").check();
  check("Rich mode: file picker takes .json and .zip", (await page.locator("#file-upload").getAttribute("accept")) === ".csv,.xls,.xlsx,.json,.zip");
  const { runId, error } = await upload({ examRe: /NEET/, rich: true, file: pkgPath });
  check("JSON package .zip → validated workspace", !!runId, error);
  await page.locator("[data-testid=rich-summary]").waitFor({ timeout: 60000 });
  let r = await runApi(runId);
  for (let i = 0; i < 30 && r.rich?.bundle?.status !== "READY"; i++) {
    await page.waitForTimeout(1000);
    r = await runApi(runId);
  }
  check("package images processed (7), none unused, 0 errors", r.rich.bundle.status === "READY" && r.rich.bundle.processedCount === 7 && r.rich.unusedImages.length === 0 && r.summary.errors === 0, { bundle: r.rich.bundle, unused: r.rich.unusedImages, s: r.summary });
  const run = (await db.query(`select format, filename from "BulkImportRun" where id = $1`, [runId])).rows[0];
  check("history: format JSON, package file name", run.format === "JSON" && run.filename === "json-package-example.zip", run);
  await page.locator("[data-testid=preview-row]").first().click();
  const dlg = page.locator("[data-testid=rich-preview]");
  await dlg.waitFor({ timeout: 20000 });
  const imgs = await dlg.locator("img").evaluateAll(async (els) => {
    await Promise.all(els.map((i) => (i.complete ? null : new Promise((r) => (i.addEventListener("load", r, { once: true }), i.addEventListener("error", r, { once: true }))))));
    return els.map((i) => ({ ok: i.complete && i.naturalWidth > 0, src: i.getAttribute("src") }));
  });
  check("preview: images from the package load", imgs.length >= 1 && imgs.every((i) => i.ok), imgs);
  check("preview: formula rendered (KaTeX)", (await dlg.locator(".katex").count()) >= 1);
  await page.keyboard.press("Escape");
  await page.locator("[data-testid=import-questions]").click();
  await page.locator("[data-testid=ack-warnings]").waitFor({ timeout: 10000 });
  await page.locator("[data-testid=ack-warnings]").click();
  await page.locator("[data-testid=confirm-import]").click();
  await page.getByText(/Import finished/).waitFor({ timeout: 60000 });
  const qs = (await db.query(`select q.status, (select count(*)::int from "QuestionAsset" a where a."questionId" = q.id) assets from "Question" q where q."importBatchId" = $1`, [runId])).rows;
  check("package import: 3 DRAFT questions with 9 image assets", qs.length === 3 && qs.every((q) => q.status === "DRAFT") && qs.reduce((s, q) => s + q.assets, 0) === 9, qs);
}

// ------------------------------------------------------------------ Rich: .json + separate bundle; package + bundle refused
{
  const { runId, error } = await upload({ examRe: /NEET/, rich: true, file: fixture("with-images", "with-images-bundle.json"), bundle: samplePath });
  check("Rich .json + image bundle → validated workspace", !!runId, error);
  let r = await runApi(runId);
  for (let i = 0; i < 30 && r.rich?.bundle?.status !== "READY"; i++) {
    await page.waitForTimeout(1000);
    r = await runApi(runId);
  }
  check("…3 rows, 0 errors, images processed", r.summary.total === 3 && r.summary.errors === 0 && r.rich.bundle.status === "READY", { s: r.summary, b: r.rich.bundle });
  const { error: e2 } = await upload({ examRe: /NEET/, rich: true, file: pkgPath, bundle: samplePath });
  check("package + separate bundle → refused", /already contains its images/.test(e2 ?? ""), e2);
}

check("no page errors", errors.length === 0, errors);
await cleanup();
await browser.close();
await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
