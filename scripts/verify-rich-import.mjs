/**
 * NEET Phase 3 — rich import in a real browser (scratch only).
 *
 * Needs a production build on a DISPOSABLE database behind a scratch nginx that
 * serves /media/ from <STORAGE_DIR>/media (same snippet + limits as production:
 * 20 MB body, 60 s read timeout), STORAGE_DIR / IMPORT_STAGING_DIR scratch.
 *
 *   npx tsx scripts/verify-rich-import.ts setup > /tmp/ri.json
 *   PHASE=import BASE=http://localhost:3132 FIXTURE=/tmp/ri.json FX_DIR=<rich-import-fixtures out> \
 *     ADMIN_USER=… ADMIN_PASS=… FULL_ADMIN_USER=… DATABASE_URL=<scratch> [SHOTS=<dir>] node scripts/verify-rich-import.mjs
 *   npx tsx scripts/verify-rich-import.ts attempts /tmp/ri.json
 *   PHASE=player … node scripts/verify-rich-import.mjs
 *   npx tsx scripts/verify-rich-import.ts cleanup /tmp/ri.json
 */
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const { Client } = require("pg");

const BASE = process.env.BASE ?? "http://localhost:3132";
const PHASE = process.env.PHASE ?? "import";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const FX = process.env.FX_DIR;
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

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

async function newPage({ mobile = false } = {}) {
  const ctx = await browser.newContext(mobile ? { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message.slice(0, 160)));
  return page;
}
const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const inPage = (page, url, init) =>
  page.evaluate(
    async ([u, i]) => {
      const r = await fetch(u, i);
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: r.status, json, text };
    },
    [url, init ?? {}]
  );
async function adminLogin(page, user, pass) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", user);
  await page.fill("input[name=password]", pass);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
async function studentLogin(page, email) {
  await db.query(`delete from "StudentDevice" where "studentId" in (select id from "Student" where email = $1)`, [email]);
  await db.query(`delete from "StudentLoginAttempt" where identifier = $1`, [email]);
  await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
}
const imagesLoaded = (page, scope) =>
  page.locator(`${scope} [data-testid=question-media] img`).evaluateAll(async (imgs) => {
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => i.addEventListener("load", r, { once: true }) || i.addEventListener("error", r, { once: true })))));
    return imgs.map((i) => ({ ok: i.complete && i.naturalWidth > 0, alt: i.getAttribute("alt"), src: i.getAttribute("src") }));
  });

async function selectByText(select, re) {
  const value = await select.evaluate((el, src) => {
    const rx = new RegExp(src, "i");
    return [...el.options].find((o) => rx.test(o.textContent))?.value ?? null;
  }, re.source);
  if (!value) throw new Error(`no option matching ${re}`);
  await select.selectOption(value);
}

/** Drives the real upload form; returns the runId once the workspace is shown. */
async function uploadViaUi(page, { examRe, paperRe, rich, xlsx, zip, label }) {
  await page.goto(`${BASE}/admin/questions/bulk-import`);
  await selectByText(page.locator("select").first(), examRe);
  if (paperRe) {
    await page.locator("input[name=importTarget][value=PREVIOUS_YEAR_PAPER]").check();
    await selectByText(page.locator("fieldset select").first(), paperRe);
  }
  if (rich) await page.locator("input[name=importMode][value=RICH]").check();
  await page.locator("#file-upload").setInputFiles(path.join(FX, xlsx));
  if (zip) await page.locator("#bundle-upload").setInputFiles(path.join(FX, zip));
  if (label) await page.getByPlaceholder("e.g. NEET UG 2026 Code 12").fill(label);
  const t0 = Date.now();
  await page.getByRole("button", { name: /Upload & Validate/ }).click();
  await page.waitForURL(/runId=/, { timeout: 180000 });
  await page.getByText("Start New Import").waitFor({ timeout: 60000 });
  const runId = new URL(page.url()).searchParams.get("runId");
  info(`${xlsx}: upload → validated workspace in ${Date.now() - t0} ms`);
  return runId;
}

if (PHASE === "import") {
  // ---------------------------------------------------------------- RBAC
  {
    const anon = await newPage();
    await anon.goto(`${BASE}/`);
    const r1 = await inPage(anon, "/api/admin/questions/bulk-import/bundles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "x.zip", size: 100 }) });
    check("anonymous cannot start a bundle upload", r1.status !== 200 && !r1.json?.bundleId, r1.status);
    const r2 = await inPage(anon, `/api/admin/questions/bulk-import/runs/x/process-images`, { method: "POST" });
    check("anonymous cannot trigger media processing", r2.status !== 200, r2.status);
    const full = await newPage();
    await adminLogin(full, process.env.FULL_ADMIN_USER, process.env.ADMIN_PASS);
    const r3 = await inPage(full, "/api/admin/questions/bulk-import/bundles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "x.zip", size: 100 }) });
    check("FULL_ADMIN (read-only, no QUESTIONS_MANAGE) gets 403 on bundle upload", r3.status === 403, r3);
    const r4 = await inPage(full, "/api/admin/questions/bulk-import/rich-template?file=xlsx");
    check("FULL_ADMIN gets 403 on the rich template", r4.status === 403, r4.status);
    await full.context().close();
    await anon.context().close();
  }

  const admin = await newPage();
  await adminLogin(admin, process.env.ADMIN_USER, process.env.ADMIN_PASS);

  // ---------------------------------------------------------------- Template
  {
    const x = await inPage(admin, "/api/admin/questions/bulk-import/rich-template?file=xlsx");
    const z = await inPage(admin, "/api/admin/questions/bulk-import/rich-template?file=zip");
    check("official XLSX template + sample bundle download", x.status === 200 && z.status === 200 && x.text.startsWith("PK") && z.text.startsWith("PK"));
  }

  // ---------------------------------------------------------------- Legacy flow unchanged
  {
    await admin.goto(`${BASE}/admin/questions/bulk-import`);
    check("Standard import mode is the default", await admin.locator("input[name=importMode][value=LEGACY]").isChecked());
    check("no image-bundle field in Standard mode", (await admin.locator("#bundle-upload").count()) === 0);
    await shot(admin, "01-upload-form-standard");
    const runId = await uploadViaUi(admin, { examRe: new RegExp(F.ruhsName), rich: false, xlsx: "legacy-ruhs.csv", label: `E2E ${F.suffix} legacy` });
    check("legacy workspace has no Rich Content card / Format column / Preview", (await admin.locator("[data-testid=rich-summary]").count()) === 0 && (await admin.locator("th", { hasText: /^Format$/ }).count()) === 0 && (await admin.locator("[data-testid=preview-row]").count()) === 0);
    check("legacy import button keeps its label", (await admin.getByRole("button", { name: "Import Questions" }).count()) === 1);
    await shot(admin, "02-legacy-workspace");
    await admin.getByRole("button", { name: "Import Questions" }).click();
    await admin.getByText(/Import finished/).waitFor({ timeout: 60000 });
    const created = await db.query(`select status, "contentFormat", explanation, "editorialStage" from "Question" where "importBatchId" = $1 order by "createdAt"`, [runId]);
    check("legacy import: 3 created, PUBLISHED honoured, PLAIN, no explanation/stage (unchanged)", created.rows.length === 3 && created.rows[0].status === "PUBLISHED" && created.rows.every((r) => r.contentFormat === "PLAIN" && r.explanation === null && r.editorialStage === null), created.rows);
  }

  // ---------------------------------------------------------------- Rich torture-10 via the UI
  let runId;
  {
    await admin.goto(`${BASE}/admin/questions/bulk-import`);
    await selectByText(admin.locator("select").first(), new RegExp(F.neetName));
    await admin.locator("input[name=importMode][value=RICH]").check();
    check("Rich mode shows the bundle field + template links", (await admin.locator("#bundle-upload").count()) === 1 && (await admin.getByText("Rich XLSX template").count()) === 1);
    await shot(admin, "03-upload-form-rich");
    runId = await uploadViaUi(admin, { examRe: new RegExp(F.neetName), paperRe: new RegExp(F.paperTitle), rich: true, xlsx: "torture10.xlsx", zip: "torture10.zip", label: `E2E ${F.suffix} torture` });
    await admin.locator("[data-testid=rich-summary]").waitFor({ timeout: 30000 });
    const r = (await inPage(admin, `/api/admin/questions/bulk-import/runs/${runId}?pageSize=all`)).json;
    check("rich run: 10 rows, 0 errors", r.summary.total === 10 && r.summary.errors === 0, r.summary);
    check("rich summary: 1 PLAIN / 9 RICH_V1, 4 option images, 2 explanation images, nothing pending/unused", r.rich.plain === 1 && r.rich.richV1 === 9 && r.rich.optionImages === 4 && r.rich.explanationImages === 2 && r.rich.pendingImages === 0 && r.rich.unusedImages.length === 0, r.rich);
    check("bundle READY, 13 processed, junk ignored", r.rich.bundle.status === "READY" && r.rich.bundle.processedCount === 13, r.rich.bundle);
    check("every row carries INFO notes", r.rows.every((row) => (row.infos ?? []).length > 0));
    await shot(admin, "04-rich-workspace");

    // Preview through production components
    const rowIdOf = (n) => r.rows.find((x) => x.rowNumber === n + 1).id;
    const previewCheck = async (n, label, fn) => {
      await admin.locator("tr", { has: admin.locator("td", { hasText: new RegExp(`^${n + 1}$`) }) }).locator("[data-testid=preview-row]").first().click();
      const dlg = admin.locator("[data-testid=rich-preview]");
      await dlg.waitFor({ timeout: 20000 });
      await fn(dlg);
      await shot(admin, `05-preview-${label}`);
      await admin.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
    };
    await previewCheck(3, "circuit", async (dlg) => {
      const imgs = await imagesLoaded(admin, "[data-testid=rich-preview]");
      check("preview Q3: display equation rendered by KaTeX", (await dlg.locator(".katex-display").count()) >= 1);
      check("preview Q3: circuit image + explanation loaded from /media/", imgs.length >= 1 && imgs.every((i) => i.ok && i.src.startsWith("/media/q/")), imgs);
    });
    await previewCheck(8, "image-options", async () => {
      const imgs = await imagesLoaded(admin, "[data-testid=rich-preview]");
      check("preview Q8: four option images", imgs.length === 4 && imgs.every((i) => i.ok), imgs);
    });
    await previewCheck(5, "mhchem", async (dlg) => check("preview Q5: mhchem rendered", (await dlg.locator(".katex").count()) >= 4));
    await previewCheck(9, "multi-images", async (dlg) => {
      const imgs = await imagesLoaded(admin, "[data-testid=rich-preview]");
      check("preview Q9: 2 question + 2 explanation images (decorative alt empty)", imgs.length === 4 && imgs.some((i) => i.alt === ""), imgs);
      check("preview Q9: explanation section shown", (await dlg.locator("[data-testid=human-explanation]").count()) === 1);
    });
    await previewCheck(10, "match", async (dlg) => check("preview Q10: List I / List II composed", /List I[\s\S]*List II/.test(await dlg.innerText())));
    void rowIdOf;

    // Import with explicit acknowledgement
    await admin.locator("[data-testid=import-questions]").click();
    await admin.locator("[data-testid=ack-warnings]").waitFor({ timeout: 10000 });
    check("warnings require explicit acknowledgement (button disabled until ticked)", await admin.locator("[data-testid=confirm-import]").isDisabled());
    await admin.locator("[data-testid=ack-warnings]").click();
    await admin.locator("[data-testid=confirm-import]").click();
    await admin.getByText(/Import finished/).waitFor({ timeout: 60000 });
    await shot(admin, "06-rich-imported");
    const q = await db.query(`select status, "contentFormat", "editorialStage", (select count(*) from "QuestionAsset" a where a."questionId" = q.id)::int as assets from "Question" q where "importBatchId" = $1`, [runId]);
    check("10 questions, all DRAFT, 13 asset references", q.rows.length === 10 && q.rows.every((x) => x.status === "DRAFT") && q.rows.reduce((s, x) => s + x.assets, 0) === 13, q.rows);
    const again = await Promise.all([1, 2].map(() => inPage(admin, "/api/admin/questions/bulk-import/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, acknowledgeWarnings: true }) })));
    const count = (await db.query(`select count(*)::int c from "Question" where "importBatchId" = $1`, [runId])).rows[0].c;
    check("retry / double-click after import creates nothing more", count === 10, { statuses: again.map((a) => a.status), count });
    const hist = await db.query(`select "importMode", "assetCount", "formatCounts", "executingAt" from "BulkImportRun" where id = $1`, [runId]);
    check("import history: RICH, assetCount 13, formatCounts, lease released", hist.rows[0].importMode === "RICH" && hist.rows[0].assetCount === 13 && hist.rows[0].formatCounts.RICH_V1 === 9 && hist.rows[0].executingAt === null, hist.rows[0]);
    await admin.goto(`${BASE}/admin/questions/bulk-import/history`);
    check("history list shows the RICH badge", (await admin.getByText("RICH", { exact: true }).count()) >= 1);
    await admin.goto(`${BASE}/admin/questions/bulk-import/history/${runId}`);
    check("history detail shows image references + format counts", (await admin.getByText("Image References").count()) === 1 && (await admin.getByText("Rich content (always DRAFT)").count()) === 1);
    await shot(admin, "07-history-detail");
  }

  // ---------------------------------------------------------------- Idempotent upload key
  {
    const csv = readFileSync(path.join(FX, "legacy-ruhs.csv"));
    const key = `e2e-key-${F.suffix}-0000000001`;
    const send = () =>
      admin.evaluate(
        async ([bytes, k, examId]) => {
          const fd = new FormData();
          fd.append("file", new Blob([new Uint8Array(bytes)]), "e2e-idem.csv");
          fd.append("examId", examId);
          fd.append("idempotencyKey", k);
          const r = await fetch("/api/admin/questions/bulk-import/upload", { method: "POST", body: fd });
          return r.json();
        },
        [[...csv], key, F.ruhsId]
      );
    const [a, b] = [await send(), await send()];
    check("same upload key twice → the same run (no duplicate batch)", a.runId && a.runId === b.runId && b.reused === true, { a, b });
  }

  // ---------------------------------------------------------------- Failure package + error report
  {
    const failRun = await uploadViaUi(admin, { examRe: new RegExp(F.neetName), paperRe: new RegExp(F.paperTitle), rich: true, xlsx: "failures.xlsx", zip: "failures.zip", label: `E2E ${F.suffix} failures` });
    await admin.locator("[data-testid=rich-summary]").waitFor();
    check("rich import button disabled while ERROR rows exist", await admin.locator("[data-testid=import-questions]").isDisabled());
    await shot(admin, "08-failures-workspace");
    const rep = await inPage(admin, `/api/admin/questions/bulk-import/runs/${failRun}/error-report`);
    const lines = rep.text.trim().split(/\r?\n/);
    check("error report: Row, Question Code, Field, Severity, Message, Suggested Action", lines[0] === "Row,Question Code,Field,Severity,Message,Suggested Action", lines[0]);
    check("error report names the missing file, row and field", lines.some((l) => /^2,SYN-FAIL-001,Question Images,ERROR,"?referenced file ""missing-file.png"" was not found/.test(l)), lines.slice(0, 4));
    check("error report lists the unused bundle image", lines.some((l) => /Image Bundle,WARNING,.*unused\.png/.test(l)));
    check("error report leaks no server paths", !/\/(tmp|var|root|home)\//.test(rep.text));
    const blocked = await inPage(admin, "/api/admin/questions/bulk-import/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: failRun, acknowledgeWarnings: true }) });
    check("server refuses Import Questions with ERROR rows (409, nothing written)", blocked.status === 409 && blocked.json.code === "ROWS_HAVE_ERRORS", blocked);
  }

  // ---------------------------------------------------------------- Hostile bundle via HTTP
  {
    const evil = readFileSync(path.join(FX, "hostile-traversal.zip"));
    const out = await admin.evaluate(async (bytes) => {
      const buf = new Uint8Array(bytes);
      const s = await (await fetch("/api/admin/questions/bulk-import/bundles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "evil.zip", size: buf.length }) })).json();
      await fetch(`/api/admin/questions/bulk-import/bundles/${s.bundleId}/chunks/0`, { method: "PUT", body: buf });
      return (await fetch(`/api/admin/questions/bulk-import/bundles/${s.bundleId}/complete`, { method: "POST" })).json();
    }, [...evil]);
    check("traversal ZIP refused over HTTP with a clear reason", out.status === "FAILED" && /traversal/.test(out.errorMessage), out);
  }

  // ---------------------------------------------------------------- Question Management
  {
    const api = await inPage(admin, `/api/admin/questions?contentFormat=RICH_V1&importBatchId=${runId}&limit=50`);
    check("Question Management API: Content Format filter → 9 RICH_V1", api.json.pagination.total === 9, api.json.pagination);
    const media = await inPage(admin, `/api/admin/questions?hasRichMedia=true&importBatchId=${runId}&limit=50`);
    check("Has Rich Media filter → 7", media.json.pagination.total === 7, media.json.pagination);
    const stage = await inPage(admin, `/api/admin/questions?editorialStage=NEEDS_REVIEW&importBatchId=${runId}&limit=50`);
    check("Editorial Stage filter finds the NEEDS_REVIEW question(s)", stage.json.pagination.total >= 1, stage.json.pagination);
    const legacyStage = await inPage(admin, `/api/admin/questions?editorialStage=NONE&examId=${F.ruhsId}&limit=1`);
    check("RUHS questions have no editorial stage (untouched)", legacyStage.json.pagination.total > 0);
    await admin.goto(`${BASE}/admin/questions`);
    await admin.locator("select[aria-label='Content format']").selectOption("RICH_V1");
    await admin.waitForTimeout(1500);
    await shot(admin, "09-question-bank-rich-filter");
    check("Question Bank UI shows the new filters", (await admin.locator("select[aria-label='Editorial stage']").count()) === 1 && (await admin.locator("select[aria-label='Has rich media']").count()) === 1);
  }

  // ---------------------------------------------------------------- Mobile admin workspace
  {
    const m = await newPage({ mobile: true });
    await adminLogin(m, process.env.ADMIN_USER, process.env.ADMIN_PASS);
    await m.goto(`${BASE}/admin/questions/bulk-import?runId=${runId}`);
    await m.locator("[data-testid=rich-summary]").waitFor({ timeout: 30000 });
    await shot(m, "10-mobile-rich-workspace");
    check("mobile admin workspace renders (no page errors)", m.errors.length === 0, m.errors);
    await m.context().close();
  }
  check("no page errors in the admin session", admin.errors.length === 0, admin.errors);
}

if (PHASE === "player") {
  const order = F.order;
  const idxOf = (re) => order.findIndex((q) => re.test(q.text));
  const position = async (page) => Number(((await page.locator("[data-testid=question-position]").first().textContent()) ?? "").match(/\d+/)?.[0] ?? 1) - 1;
  async function goTo(page, i) {
    for (let g = 0; g < 40 && (await position(page)) !== i; g++) {
      const here = await position(page);
      await page.getByRole("button", { name: here < i ? /^(Save & )?Next/ : /Previous/ }).first().click();
    }
    await page.waitForFunction((n) => (document.querySelector("[data-testid=question-position]")?.textContent ?? "").includes(String(n)), i + 1);
  }
  /** Walks the one-question-at-a-time review: explanation + images on every question. */
  async function walkReview(page, attemptId) {
    await page.goto(`${BASE}/student/attempt/${attemptId}/review`);
    await page.locator("[data-testid=review-nav-position]").waitFor({ timeout: 20000 });
    const out = { withExplanation: 0, explanationImages: 0, figures: 0, allLoaded: true };
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(250);
      if (await page.locator("[data-testid=human-explanation]").count()) out.withExplanation++;
      const ex = await imagesLoaded(page, "[data-testid=human-explanation]");
      const all = await page.locator("[data-testid=question-media] img").evaluateAll((imgs) => imgs.map((im) => im.complete && im.naturalWidth > 0));
      out.explanationImages += ex.length;
      out.figures += all.length;
      if (all.some((ok) => !ok)) out.allLoaded = false;
      if (i < 9) await page.getByRole("button", { name: "Next question" }).first().click();
    }
    return out;
  }

  for (const [tag, mobile] of [["desk", false], ["mobile", true]]) {
    const page = await newPage({ mobile });
    await studentLogin(page, F.students[tag].email);
    await db.query(`update "TestAttempt" set "activeDeviceId" = null, "activeSeenAt" = null where id = $1`, [F.attempts[tag]]);
    await page.goto(`${BASE}/student/attempt/${F.attempts[tag]}/run`);
    await page.locator("[data-testid=test-player]").waitFor({ timeout: 30000 });
    const raw = await page.evaluate((u) => fetch(u).then((r) => r.text()), `/student/attempt/${F.attempts[tag]}/run`);
    check(`${tag}: EXAM payload has no imported explanation text`, !raw.includes("R_{23}") && !raw.includes("left ventricle pumps oxygenated") && !raw.includes("Only the hexagon has six sides"));
    check(`${tag}: EXAM payload has no correct label`, !/"correctLabel"/.test(raw));
    const iFormula = idxOf(/v\^2=u\^2\+2as/);
    await goTo(page, iFormula);
    check(`${tag}: inline LaTeX rendered in the player`, (await page.locator("[data-testid=test-player] .katex").count()) >= 4);
    const iCircuit = idxOf(/R_\{eq\}/);
    await goTo(page, iCircuit);
    const cimg = await imagesLoaded(page, "[data-testid=test-player]");
    check(`${tag}: display equation + circuit image in the player`, (await page.locator("[data-testid=test-player] .katex-display").count()) >= 1 && cimg.length === 1 && cimg[0].ok, cimg);
    await shot(page, `20-${tag}-player-circuit`);
    const iOpts = idxOf(/six sides/);
    await goTo(page, iOpts);
    const oimg = await imagesLoaded(page, "[data-testid=test-player]");
    check(`${tag}: four image options render`, oimg.length === 4 && oimg.every((i) => i.ok), oimg);
    await page.locator("[data-testid=option]").nth(3).click();
    await page.waitForTimeout(800);
    await shot(page, `21-${tag}-player-image-options`);
    const iChem = idxOf(/N2 \+ 3H2/);
    await goTo(page, iChem);
    check(`${tag}: mhchem renders in the player`, (await page.locator("[data-testid=test-player] .katex").count()) >= 3);
    await page.locator("[data-testid=option]").first().click();
    const iMtf = idxOf(/Match List I/);
    await goTo(page, iMtf);
    check(`${tag}: Match the Following lists visible`, /List I[\s\S]*List II/.test(await page.locator("[data-testid=test-player]").innerText()));
    await shot(page, `22-${tag}-player-match`);
    if (mobile) check("mobile: no horizontal page scroll", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.waitForTimeout(1000);
    const saved = await db.query(`select count(*)::int c from "Answer" where "attemptId" = $1 and "selectedOptionLabel" is not null`, [F.attempts[tag]]);
    check(`${tag}: answers saved on the server`, saved.rows[0].c >= 2, saved.rows[0]);
    await page.getByRole("button", { name: "Submit Test" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
    let st;
    for (let i = 0; i < 60; i++) {
      st = await db.query(`select status, score from "TestAttempt" where id = $1`, [F.attempts[tag]]);
      if (st.rows[0].status === "SUBMITTED") break;
      await page.waitForTimeout(500);
    }
    check(`${tag}: submitted and scored (2 correct answers chosen)`, st.rows[0].status === "SUBMITTED" && Number(st.rows[0].score) >= 2, st.rows[0]);
    const rv = await walkReview(page, F.attempts[tag]);
    check(`${tag}: review shows the imported explanation on all 10 questions`, rv.withExplanation === 10, rv);
    check(`${tag}: review shows the 2 explanation images (loaded) + question figures`, rv.explanationImages === 2 && rv.allLoaded, rv);
    await shot(page, `23-${tag}-review`);
    const r = await inPage(page, "/api/admin/questions/bulk-import/bundles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "x.zip", size: 100 }) });
    check(`${tag}: a logged-in student cannot reach import/media endpoints`, r.status !== 200 && !r.json?.bundleId, r.status);
    check(`${tag}: no page errors`, page.errors.length === 0, page.errors);
    await page.context().close();
  }
  // Pre-submitted review attempt (historical snapshot path)
  const rvp = await newPage({ mobile: true });
  await studentLogin(rvp, F.students.review.email);
  const hist = await walkReview(rvp, F.attempts.review);
  check("submitted-attempt review (mobile) renders every frozen explanation + image", hist.withExplanation === 10 && hist.explanationImages === 2 && hist.allLoaded, hist);
  await rvp.context().close();
}

await browser.close();
await db.end();
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`} (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
