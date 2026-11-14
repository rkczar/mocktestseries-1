/**
 * Admin → Students: exam filter / counts / Exams column and Delete Student Account, in a real browser against a
 * LOCAL build on a DISPOSABLE database (fixture: scripts/admin-students-ui-fixture.ts).
 *
 *   BASE=http://127.0.0.1:3681 FIXTURE=fx.json DATABASE_URL=<scratch> SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-admin-students-ui.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import pg from "pg";

const load = createRequire(import.meta.url);
const { chromium, devices } = load("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:3681";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS || "";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) || !/\/mts_[a-z0-9_]+/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Local server + scratch database only.");
  process.exit(2);
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=[^&]*/, "") });
await db.connect();

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
};
const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
const [E0, E1] = F.exams;
const { a, b, c } = F.students;
const enrolled = async (examId) =>
  Number((await db.query(`select count(*) from "StudentExamEnrollment" e join "Student" s on s.id = e."studentId" where e."examId" = $1 and s.status <> 'DELETED'`, [examId])).rows[0].count);

async function login(browser, username, device) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport: { width: 1440, height: 1000 } });
  await ctx.route((url) => !url.href.startsWith(BASE), (route) => route.abort()); // never reach third parties
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", F.password);
  await page.locator("form button[type=submit]").first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/admin/login"), { timeout: 30000 });
  return { ctx, page };
}
const rowOf = (page, code) => page.locator("[data-testid=students-table] tbody tr", { hasText: code });

const browser = await chromium.launch();
try {
  console.log("MASTER_ADMIN — exam filter");
  const { ctx, page } = await login(browser, F.master.username);
  await page.goto(`${BASE}/admin/students?tab=all&q=${F.run}`);
  await page.getByLabel("Exam", { exact: true }).selectOption(E1.id);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForURL((u) => u.searchParams.get("exam") === E1.id);
  const shown = await page.locator("[data-testid=students-table] tbody tr").allInnerTexts();
  check("select exam → only students enrolled in it (incl. the multi-exam one)", shown.length === 2 && shown.some((t) => t.includes(b.code)) && shown.some((t) => t.includes(c.code)) && !shown.some((t) => t.includes(a.code)), shown.length);
  const exCell = await rowOf(page, c.code).getByTestId("student-exams").innerText();
  check("multi-exam student shows both exams in the Exams column", exCell.includes(",") && exCell.split(",").length === 2, exCell);
  const countText = await page.locator(`[data-testid=students-exam-counts] a[data-exam-id="${E1.id}"]`).innerText();
  check("per-exam count = database count", countText.endsWith(`: ${(await enrolled(E1.id)).toLocaleString("en-IN")}`), countText);
  check("filter survives pagination links (exam kept in the URL)", (await page.locator("[data-testid=students-pagination]").count()) === 1 && new URL(page.url()).searchParams.get("exam") === E1.id);
  await shot(page, "admin-students-exam-filter");

  console.log("MASTER_ADMIN — delete from All Students");
  await page.goto(`${BASE}/admin/students?tab=all&q=${F.run}`);
  await rowOf(page, a.code).getByTestId("delete-student").click();
  const dlg = page.getByTestId("delete-student-dialog");
  await dlg.getByTestId("delete-student-summary").waitFor();
  const summary = await dlg.getByTestId("delete-student-summary").innerText();
  check("confirmation shows name, mobile, exams, registration, access and payments", [a.name, a.mobile, "Registered", "Exams", "Active access", "Payments"].every((s) => summary.includes(s)), summary);
  await dlg.getByTestId("delete-student-reason").fill("Duplicate account");
  await dlg.getByTestId("delete-student-code").fill(b.code);
  check("wrong Student ID → Delete stays disabled", await dlg.getByTestId("delete-student-confirm").isDisabled());
  await dlg.getByTestId("delete-student-code").fill(a.code);
  await shot(page, "admin-delete-dialog");
  await dlg.getByTestId("delete-student-confirm").click();
  await dlg.waitFor({ state: "detached", timeout: 30000 });
  const row = (await db.query(`select status, mobile, email from "Student" where id = $1`, [a.id])).rows[0];
  check("account deleted: status DELETED, mobile + email released", row.status === "DELETED" && row.mobile === null && row.email === null, row);
  const req = (await db.query(`select status, reason from "DeletionRequest" where "studentId" = $1`, [a.id])).rows;
  check("recorded in the existing Deletion Requests queue as APPROVED (admin-initiated)", req.length === 1 && req[0].status === "APPROVED" && /^Admin-initiated by UI Master/.test(req[0].reason), req);
  const gone = await rowOf(page, a.code).waitFor({ state: "detached", timeout: 15000 }).then(() => true, () => false);
  check("deleted student leaves All Students without a manual reload", gone);
  await page.goto(`${BASE}/admin/students/${b.id}`);
  check("Student Details page offers Delete (MASTER_ADMIN)", (await page.getByTestId("delete-student").count()) === 1);
  check("no page errors (master)", page.errors.length === 0, page.errors);
  await ctx.close();

  console.log("FULL_ADMIN — no delete anywhere");
  const f = await login(browser, F.full.username);
  await f.page.goto(`${BASE}/admin/students?tab=all&q=${F.run}`);
  check("FULL_ADMIN sees the list + exam filter", (await f.page.locator("[data-testid=students-table] tbody tr").count()) === 2 && (await f.page.getByLabel("Exam", { exact: true }).count()) === 1);
  check("FULL_ADMIN: no Delete button in the list", (await f.page.getByTestId("delete-student").count()) === 0);
  await f.page.goto(`${BASE}/admin/students/${b.id}`);
  check("FULL_ADMIN: no Delete button on Student Details", (await f.page.getByTestId("delete-student").count()) === 0);
  await f.ctx.close();

  console.log("Phone layout");
  const m = await login(browser, F.master.username, "Pixel 7");
  await m.page.goto(`${BASE}/admin/students?tab=all&q=${F.run}`);
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("phone: filters + table without page-level sideways scroll (table scrolls in its own box)", overflow <= 1, overflow);
  await shot(m.page, "admin-students-phone");
  await m.ctx.close();
} finally {
  await browser.close();
  await db.end();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL ADMIN STUDENTS UI CHECKS PASSED");
process.exit(failures ? 1 : 0);
