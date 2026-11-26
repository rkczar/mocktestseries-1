/**
 * Phase 0 source protection — browser check (Playwright, desktop + mobile) against the scratch `next start` the
 * importer UI suite uses, AFTER verify-ai-import-ui.mjs (it reuses one of that suite's finished jobs). Scratch DB only.
 *
 *   BASE=http://localhost:3461 ADMIN_USER=… ADMIN_PASS=… DATABASE_URL=<scratch> NODE_PATH=<playwright> \
 *   node scripts/verify-source-protection-ui.mjs
 */
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import pg from "pg";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE;
if (!/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("refusing: scratch mts_* DATABASE_URL only");
  process.exit(2);
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};

// A finished job with a stored paper; give it one Question Bank question with source evidence on that paper and
// expire its originals, so it is protected everywhere.
const job = (await db.query(`select j.id, j."examId", f.id as "fileId", f."originalName" from "AiImportJob" j join "AiImportFile" f on f."jobId" = j.id
  where j.status in ('COMPLETED','COMPLETED_WITH_ISSUES','CANCELLED','FAILED') and (j."leaseUntil" is null or j."leaseUntil" < now()) and f.role = 'PAPER'
    and f."storageKey" is not null and f.status <> 'PURGED' order by j."createdAt" desc limit 1`)).rows[0];
if (!job) {
  console.error("no finished job with a stored paper — run verify-ai-import-ui.mjs first");
  process.exit(2);
}
const subject = (await db.query(`select id from "Subject" limit 1`)).rows[0];
const qid = `spui${randomBytes(8).toString("hex")}`;
await db.query(`insert into "Question" (id, code, "examId", "subjectId", text, "updatedAt") values ($1, $2, $3, $4, 'SP UI dependency', now())`, [qid, `SPUI-${qid}`, job.examId, subject.id]);
await db.query(`insert into "QuestionSourceEvidence" (id, "questionId", "jobId", "fileId", pages, "updatedAt") values ($1, $2, $3, $4, '{1}', now())`, [`ev${qid}`, qid, job.id, job.fileId]);
await db.query(`update "AiImportFile" set "retainUntil" = now() - interval '400 days' where "jobId" = $1`, [job.id]);
await db.query(`delete from "LoginAttempt" where username = $1`, [process.env.ADMIN_USER]);
// An empty cancelled import nothing depends on: Delete must stay available (regression of the normal path).
const freeJob = `spuifree${randomBytes(6).toString("hex")}`;
await db.query(`insert into "AiImportJob" (id, title, "examId", "createdById", "budgetInr", status, "updatedAt") select $1, 'SP UI free job', $2, "createdById", 0, 'CANCELLED', now() from "AiImportJob" where id = $3`, [freeJob, job.examId, job.id]);

const browser = await chromium.launch();
try {
  for (const mobile of [false, true]) {
    const tag = mobile ? "mobile" : "desktop";
    const ctx = await browser.newContext(mobile ? { viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true } : { viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await page.goto(`${BASE}/admin/login`);
    await page.fill("input[name=username]", process.env.ADMIN_USER);
    await page.fill("input[name=password]", process.env.ADMIN_PASS);
    await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);

    await page.goto(`${BASE}/admin/ai-importer/jobs/${job.id}`);
    await page.locator("[data-testid=job-delete]").first().click();
    const del = page.locator("[data-testid=delete-job-dialog]");
    await del.locator("[data-testid=delete-preview]").waitFor({ timeout: 20000 });
    const blocked = del.locator("[data-testid=delete-blocked]");
    const text = (await blocked.count()) ? await blocked.textContent() : "";
    check(`${tag}: blocked reason visible in the delete dialog`, (await blocked.isVisible()) && /cannot be deleted/.test(text) && /\d+ Question Bank question\(s\) depend on it \(/.test(text), text);
    check(`${tag}: no DELETE box, confirm button disabled`, (await del.locator("[data-testid=delete-confirm]").count()) === 0 && (await del.locator("[data-testid=delete-job-confirm]").isDisabled()));
    const fileTexts = await del.locator("[data-testid=delete-preview-file]").allTextContents();
    check(`${tag}: files say kept, nothing listed as removed`, fileTexts.length > 0 && fileTexts.every((t) => /kept/.test(t) && !/deleted/.test(t)) && !/Removed:/.test(await del.textContent()), fileTexts);
    await page.keyboard.press("Escape");

    await page.goto(`${BASE}/admin/ai-importer/jobs/${freeJob}`);
    await page.locator("[data-testid=job-delete]").first().click();
    const free = page.locator("[data-testid=delete-job-dialog]");
    await free.locator("[data-testid=delete-preview]").waitFor({ timeout: 20000 });
    const confirm = free.locator("[data-testid=delete-job-confirm]");
    const beforeTyping = await confirm.isDisabled();
    await free.locator("[data-testid=delete-confirm]").fill("DELETE");
    check(`${tag}: unprotected import: no block, Removed list shown, confirm enabled only after typing DELETE`, (await free.locator("[data-testid=delete-blocked]").count()) === 0 && /Removed:/.test(await free.textContent()) && beforeTyping && !(await confirm.isDisabled()));
    await page.keyboard.press("Escape");

    await page.goto(`${BASE}/admin/ai-importer/vault`);
    const row = page.locator("[data-testid=vault-table] tr", { hasText: job.originalName }).first();
    check(`${tag}: vault shows "Expired — protected, retained" (not just "(expired)")`, /Expired — protected, retained/.test(await row.textContent()) && !/\(expired\)/.test(await row.textContent()), await row.textContent());

    await page.goto(`${BASE}/admin/ai-importer/storage`);
    await page.locator("[data-testid=scan-storage]").click();
    await page.locator("[data-testid=storage-report]").waitFor({ timeout: 60000 });
    const prot = page.locator("[data-testid=expired-protected]");
    check(`${tag}: Storage Manager shows protected expired originals`, (await prot.count()) === 1 && /protected and retained/.test(await prot.textContent()), (await prot.count()) ? await prot.textContent() : null);
    check(`${tag}: no page errors`, !errors.length, errors);
    await ctx.close();
  }
  check("job still exists after the UI checks", (await db.query(`select count(*)::int n from "AiImportJob" where id = $1`, [job.id])).rows[0].n === 1);
} finally {
  await browser.close();
  await db.query(`delete from "Question" where id = $1`, [qid]); // evidence cascades
  await db.query(`delete from "AiImportJob" where id = $1`, [freeJob]);
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
