/**
 * NEET Phase 3 — rich import scale / resource test over HTTP (scratch only).
 *
 * Drives exactly the calls the Bulk Import workspace makes (chunked bundle
 * upload → spreadsheet upload → time-sliced image processing → validate →
 * import), through the scratch nginx with production limits, while it:
 *   - probes student-facing pages every 300 ms (latency p50 / p95 / max),
 *   - samples the Next server process (SERVER_PID) CPU % and RSS every 250 ms.
 *
 *   PKG=pilot45|scale180|stress180 BASE=http://localhost:3132 FIXTURE=/tmp/ri.json FX_DIR=… \
 *   ADMIN_USER=… ADMIN_PASS=… SERVER_PID=<pid of next start> DATABASE_URL=<scratch> node scripts/verify-rich-import-scale.mjs
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { Client } = require("pg");

const BASE = process.env.BASE ?? "http://localhost:3132";
const PKG = process.env.PKG ?? "scale180";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const FX = process.env.FX_DIR;
const PID = Number(process.env.SERVER_PID);
const PROBES = (process.env.PROBES ?? "/,/login,/exams").split(",");

let failed = 0;
const check = (n, ok, d) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${!ok && d !== undefined ? `  ${JSON.stringify(d).slice(0, 300)}` : ""}`);
};
const info = (m) => console.log(`INFO  ${m}`);
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);

// --- process sampler (CPU % of one core, RSS MB) — includes child processes of the server
const CLK = Number(execSync("getconf CLK_TCK").toString().trim());
const pids = () => [PID, ...execSync(`pgrep -P ${PID} || true`).toString().split("\n").filter(Boolean).map(Number)];
function cpuTicks() {
  return pids().reduce((s, p) => {
    try {
      const f = readFileSync(`/proc/${p}/stat`, "utf8").split(") ")[1].split(" ");
      return s + Number(f[11]) + Number(f[12]);
    } catch {
      return s;
    }
  }, 0);
}
const rssMb = () => pids().reduce((s, p) => {
  try {
    return s + Number(readFileSync(`/proc/${p}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024;
  } catch {
    return s;
  }
}, 0);
const samples = [];
let lastT = Date.now(), lastC = cpuTicks();
let stage = "idle";
const sampler = setInterval(() => {
  const t = Date.now(), c = cpuTicks();
  samples.push({ stage, cpu: ((c - lastC) / CLK / ((t - lastT) / 1000)) * 100, rss: rssMb() });
  lastT = t;
  lastC = c;
}, 250);

// --- student-site probe
const probes = [];
let probing = true;
(async function probeLoop() {
  let i = 0;
  while (probing) {
    const url = BASE + PROBES[i++ % PROBES.length];
    const t0 = performance.now();
    let ok = false;
    try {
      const r = await fetch(url, { redirect: "manual" });
      await r.arrayBuffer();
      ok = r.status < 500;
    } catch {}
    probes.push({ stage, ms: performance.now() - t0, ok });
    await new Promise((r) => setTimeout(r, 300));
  }
})();

const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, "") });
await db.connect();
const dbSize = async () => Number((await db.query("select pg_database_size(current_database()) s")).rows[0].s);
const mediaDir = path.join(process.env.STORAGE_DIR, "media");
const du = (d) => Number(execSync(`du -sb ${d} 2>/dev/null || echo 0`).toString().split(/\s/)[0]);

// Each package gets its own synthetic paper (scratch), so QNos never collide with an earlier package.
await db.query(`update "PreviousYearPaper" set "paperCode" = 'SYN-25-old-' || left(id, 8) where "paperCode" = 'SYN-25' and title like 'SYNTHETIC NEET 2025%'`);
const paperId = (await db.query(`insert into "PreviousYearPaper" (id, "examId", year, title, "paperCode", "isActive", "createdAt") values ('p3' || md5(random()::text), $1, 2025, $2, 'SYN-25', true, now()) returning id`, [F.neetId, `SYNTHETIC NEET 2025 E2E ${F.suffix} ${PKG}`])).rows[0].id;

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto(`${BASE}/admin/login`);
await page.fill("input[name=username]", process.env.ADMIN_USER);
await page.fill("input[name=password]", process.env.ADMIN_PASS);
await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);

// idle baseline
stage = "idle";
await page.waitForTimeout(4000);
const before = { db: await dbSize(), media: du(mediaDir), mediaObjects: Number((await db.query(`select count(*) c from "MediaObject"`)).rows[0].c) };

const zip = readFileSync(path.join(FX, `${PKG}.zip`));
const xlsx = readFileSync(path.join(FX, `${PKG}.xlsx`));
const timings = {};
const api = (fn, arg) => page.evaluate(fn, arg);

// 1. chunked bundle upload (bytes are passed into the page in 8 MB slices)
stage = "upload";
let t = Date.now();
const start = await api(async ([name, size]) => (await fetch("/api/admin/questions/bulk-import/bundles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: name, size }) })).json(), [`${PKG}.zip`, zip.length]);
for (let i = 0; i < start.chunkCount; i++) {
  const part = zip.subarray(i * start.chunkBytes, (i + 1) * start.chunkBytes);
  const r = await api(async ([id, idx, b64]) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return (await fetch(`/api/admin/questions/bulk-import/bundles/${id}/chunks/${idx}`, { method: "PUT", body: bin })).status;
  }, [start.bundleId, i, part.toString("base64")]);
  if (r !== 200) throw new Error(`chunk ${i} → ${r}`);
}
const done = await api(async (id) => (await fetch(`/api/admin/questions/bulk-import/bundles/${id}/complete`, { method: "POST" })).json(), start.bundleId);
timings.bundleUploadAndInspect = Date.now() - t;
check(`${PKG}: ${(zip.length / 1024 / 1024).toFixed(1)} MB bundle uploaded in ${start.chunkCount} chunk(s) and inspected`, done.status === "UPLOADED", done.errorMessage);

// 2. spreadsheet upload
t = Date.now();
const up = await api(async ([b64, examId, paperId, bundleId, label]) => {
  const fd = new FormData();
  fd.append("file", new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]), "e2e-scale.xlsx");
  fd.append("examId", examId);
  fd.append("previousYearPaperId", paperId);
  fd.append("importMode", "RICH");
  fd.append("bundleId", bundleId);
  fd.append("label", label);
  fd.append("idempotencyKey", crypto.randomUUID());
  return (await fetch("/api/admin/questions/bulk-import/upload", { method: "POST", body: fd })).json();
}, [xlsx.toString("base64"), F.neetId, paperId, start.bundleId, `E2E ${F.suffix} ${PKG}`]);
timings.spreadsheetUpload = Date.now() - t;
check(`${PKG}: spreadsheet staged (${up.total} rows)`, !!up.runId, up);

// 3. image processing slices
stage = "process";
t = Date.now();
let slices = 0, maxSlice = 0, proc;
for (;;) {
  const s0 = Date.now();
  proc = await api(async (id) => (await fetch(`/api/admin/questions/bulk-import/runs/${id}/process-images`, { method: "POST" })).json(), up.runId);
  maxSlice = Math.max(maxSlice, Date.now() - s0);
  slices++;
  if (proc.done || slices > 300) break;
}
timings.processImages = Date.now() - t;
check(`${PKG}: images processed (${proc.ready} ready, ${proc.invalid} invalid) in ${slices} slice(s)`, proc.done && proc.invalid === 0, proc);
check(`${PKG}: every processing request stayed under nginx's 60 s limit (max ${maxSlice} ms)`, maxSlice < 45000);

// 4. validate
stage = "validate";
t = Date.now();
const val = await api(async (id) => (await fetch("/api/admin/questions/bulk-import/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: id }) })).json(), up.runId);
timings.validate = Date.now() - t;
check(`${PKG}: validation — ${val.valid} valid, ${val.invalid} errors`, val.invalid === 0, val);

// 5. preview + workspace responsiveness
stage = "preview";
t = Date.now();
const runGet = await api(async (id) => (await fetch(`/api/admin/questions/bulk-import/runs/${id}?pageSize=all`)).json(), up.runId);
timings.workspaceLoadAllRows = Date.now() - t;
const someRow = runGet.rows.find((r) => /Q1/.test(JSON.stringify(r.merged.questionImageFilename ?? ""))) ?? runGet.rows[0];
t = Date.now();
await api(async (id) => (await fetch(`/api/admin/questions/bulk-import/rows/${id}/preview`)).json(), someRow.id);
timings.rowPreview = Date.now() - t;

// 6. import (commit)
stage = "commit";
t = Date.now();
const imp = await api(async (id) => {
  const r = await fetch("/api/admin/questions/bulk-import/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: id, acknowledgeWarnings: true }) });
  return { status: r.status, body: await r.json() };
}, up.runId);
timings.commit = Date.now() - t;
check(`${PKG}: committed ${imp.body.successCount} questions, ${imp.body.failedCount} failed (HTTP ${imp.status})`, imp.status === 200 && imp.body.failedCount === 0 && imp.body.successCount === up.total, imp);
const dedup = await db.query(`select count(*)::int refs, count(distinct "storageKey")::int files from "QuestionAsset" a join "Question" q on q.id = a."questionId" where q."importBatchId" = $1`, [up.runId]);
info(`${PKG}: ${dedup.rows[0].refs} asset references → ${dedup.rows[0].files} distinct immutable files (dedup)`);
// The 45-question pilot has no repeated figure by design; the 180 packages do.
if (PKG === "pilot45") check(`${PKG}: never more files than references`, dedup.rows[0].files <= dedup.rows[0].refs, dedup.rows[0]);
else check(`${PKG}: repeated figures deduplicated (refs > files)`, dedup.rows[0].refs > dedup.rows[0].files, dedup.rows[0]);

stage = "after";
await page.waitForTimeout(2000);
probing = false;
clearInterval(sampler);
const after = { db: await dbSize(), media: du(mediaDir), mediaObjects: Number((await db.query(`select count(*) c from "MediaObject"`)).rows[0].c) };

// --- report
const byStage = (arr, key) =>
  Object.fromEntries(
    ["idle", "upload", "process", "validate", "preview", "commit"].map((s) => {
      const v = arr.filter((x) => x.stage === s).map((x) => x[key]);
      return [s, v.length ? { n: v.length, p50: Math.round(pct(v, 50)), p95: Math.round(pct(v, 95)), max: Math.round(Math.max(...v)) } : null];
    })
  );
const peakRss = Math.max(...samples.map((s) => s.rss));
const idleRss = Math.max(...samples.filter((s) => s.stage === "idle").map((s) => s.rss));
console.log(`\nRESULT ${PKG}`);
console.log(JSON.stringify({
  bundleMB: +(zip.length / 1048576).toFixed(1),
  rows: up.total,
  images: proc.ready,
  timingsMs: timings,
  totalMs: Object.values(timings).reduce((a, b) => a + b, 0),
  serverRssMB: { idlePeak: Math.round(idleRss), peak: Math.round(peakRss), growth: Math.round(peakRss - idleRss) },
  serverCpuPctOfOneCore: byStage(samples, "cpu"),
  studentProbeMs: byStage(probes, "ms"),
  probeFailures: probes.filter((p) => !p.ok).length,
  dbGrowthKB: Math.round((after.db - before.db) / 1024),
  mediaGrowthKB: Math.round((after.media - before.media) / 1024),
  newMediaObjects: after.mediaObjects - before.mediaObjects,
}, null, 2));
const busy = probes.filter((p) => p.stage !== "idle" && p.stage !== "after").map((p) => p.ms);
check(`${PKG}: student pages never failed during the import`, probes.filter((p) => !p.ok).length === 0);
check(`${PKG}: student page p95 during import < 2000 ms (got ${Math.round(pct(busy, 95))} ms)`, pct(busy, 95) < 2000);
check(`${PKG}: server memory growth < 600 MB (got ${Math.round(peakRss - idleRss)} MB)`, peakRss - idleRss < 600);
void statSync;
await browser.close();
await db.end();
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
