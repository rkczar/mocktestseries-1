/**
 * Teacher Portal enhancements — browser / HTTP regression on a scratch build.
 *   BASE=http://localhost:<port> FIXTURE=/tmp/tpb.json APP_DIR=<worktree> DATABASE_URL=<scratch mts_*> NODE_PATH=<playwright dir> node scripts/verify-teacher-portal-b-http.mjs
 * Teachers A (exam X), B (Y), C (X + Y). Every teacher page must render for
 * its own exams, return 404 for other exams' ids, and never contain a seeded
 * email, mobile, Razorpay order / payment / refund id or webhook payload.
 * Admin pages must still show what they showed before.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const APP = process.env.APP_DIR ?? process.cwd();
const DBURL = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/\/mts_[a-z0-9_]+$/.test(DBURL)) throw new Error("DATABASE_URL must be the scratch mts_* database the server uses");
const sql = (q) => execFileSync("psql", [DBURL, "-Atc", q], { encoding: "utf8" }).trim();
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
async function login(key) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill('input[name="username"]', F.accounts[key].username);
  await page.fill('input[name="password"]', F.accounts[key].password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/admin/login"), { timeout: 30000 }), page.click('button[type="submit"]')]);
  return { ctx, page };
}
const path = (p) => new URL(p.url()).pathname;
async function get(sess, url) {
  const res = await sess.page.goto(`${BASE}${url}`);
  return { status: res?.status(), html: await sess.page.content(), text: await sess.page.locator("body").innerText() };
}
const leaksIn = (html) => F.leaks.filter((l) => html.includes(l));

const A = await login("a");
const B = await login("b");
const C = await login("c");
const M = await login("master");

console.log("\n== Pages render for own exams, with no contact / gateway data");
const ownPages = [
  "/teacher/students",
  "/teacher/students/history",
  `/teacher/students/${F.students.x}`,
  "/teacher/payments",
  "/teacher/payments?tab=orders",
  "/teacher/payments?tab=payments",
  "/teacher/payments?tab=revenue",
  `/teacher/payments/orders/${F.orders.x1.id}`,
  `/teacher/payments/orders/${F.orders.x2.id}`,
  `/teacher/tests/${F.mocks.x}/results`,
  `/teacher/tests/${F.mocks.held}/results`,
  "/teacher/questions?expand=all",
  `/teacher/questions/${F.questions.x[0]}`,
  `/teacher/questions/${F.questions.x[0]}/edit`,
];
for (const u of ownPages) {
  const r = await get(A, u);
  const leaked = leaksIn(r.html);
  check(`A ${u.replace(/c[a-z0-9]{20,}/g, "<id>")} → 200, no leak`, r.status === 200 && leaked.length === 0, `${r.status} ${leaked.join(",")}`);
}
for (const [who, s] of [["B", B], ["C", C]]) {
  for (const u of ["/teacher/students", "/teacher/payments?tab=orders", "/teacher/payments?tab=payments", "/teacher/students/history"]) {
    const r = await get(s, u);
    check(`${who} ${u} → 200, no leak`, r.status === 200 && leaksIn(r.html).length === 0, leaksIn(r.html).join(","));
  }
}

console.log("\n== Cross-exam isolation (404)");
const cross = [
  [A, "A", `/teacher/students/${F.students.y}`],
  [A, "A", `/teacher/students/${F.students.z}`],
  [A, "A", `/teacher/payments/orders/${F.orders.y1.id}`],
  [A, "A", `/teacher/payments/orders/${F.orders.z1.id}`],
  [A, "A", `/teacher/payments/orders/${F.orders.xtest.id}`],
  [A, "A", `/teacher/tests/${F.mocks.y}/results`],
  [B, "B", `/teacher/students/${F.students.x}`],
  [B, "B", `/teacher/payments/orders/${F.orders.x1.id}`],
  [C, "C", `/teacher/payments/orders/${F.orders.z1.id}`],
  [C, "C", `/teacher/students/${F.students.z}`],
];
for (const [s, who, u] of cross) {
  const r = await get(s, u);
  check(`${who} ${u.replace(/c[a-z0-9]{20,}/g, "<id>")} → 404`, r.status === 404, r.status);
}
let r = await get(A, "/teacher/payments?tab=orders");
check("A's transactions: own orders only (no Y / Z / TEST order numbers)", r.text.includes(F.orders.x1.orderNumber) && r.text.includes(F.orders.x3.orderNumber) && !r.text.includes(F.orders.y1.orderNumber) && !r.text.includes(F.orders.z1.orderNumber) && !r.text.includes(F.orders.xtest.orderNumber));
r = await get(A, `/teacher/payments?tab=orders&exam=${F.exams.Y}`);
check("URL exam filter for another exam does not widen access", !r.text.includes(F.orders.y1.orderNumber));
r = await get(C, "/teacher/payments?tab=orders");
check("C sees X and Y orders, never Z", r.text.includes(F.orders.x1.orderNumber) && r.text.includes(F.orders.y1.orderNumber) && !r.text.includes(F.orders.z1.orderNumber));
r = await get(A, `/teacher/students/history?examId=${F.exams.Y}`);
check("teacher Test History: another exam in the URL does not widen access", r.status === 200 && !r.text.includes(F.studentNames.y) && !r.text.includes(F.studentNames.z) && !r.html.includes("/admin/students/"));
r = await get(A, "/teacher/students");
check("A's student list: no Y / Z students", !r.text.includes(F.studentNames.y) && !r.text.includes(F.studentNames.z) && r.text.includes("TPH Student x"));
r = await get(A, `/teacher/students?q=${encodeURIComponent(F.leaks[0])}`);
check("searching students by email finds nothing", !r.text.includes("TPH Student x2") && !r.text.includes(`TPHX-`));

console.log("\n== Transaction content (read-only)");
r = await get(A, `/teacher/payments/orders/${F.orders.x1.id}`);
check("detail shows student, product, coupon, discount, amount paid, status, method", r.text.includes("TPH Student x") && r.text.includes("TPH SeriesX") && r.text.includes(F.coupon) && /₹\s?50/.test(r.text) && r.text.includes("PAID") && r.text.includes("UPI"));
check("detail shows status history (webhook event type)", r.text.includes("payment.captured"));
check("detail has no refund / reconcile controls", !r.text.includes("Request refund") && !r.text.includes("Re-check with Razorpay"));
r = await get(A, `/teacher/payments/orders/${F.orders.x2.id}`);
check("refund shown (amount + status), refund gateway id hidden", r.text.includes("PROCESSED") && /₹\s?20/.test(r.text) && leaksIn(r.html).length === 0);
r = await get(A, "/teacher/payments");
const low = r.text.toLowerCase(); // StatCard labels are CSS-uppercased in innerText
check("overview = Admin OverviewPanel cards (gross, successful, failed, pending, refunded, net)", ["Gross Sales", "Successful Payments", "Failed Payments", "Pending Payments", "Refunded Amount", "Net Collected"].every((k) => low.includes(k.toLowerCase())));
check("platform-wide subscription / free-grant cards hidden", !low.includes("active subscriptions") && !low.includes("free access grants"));
for (const st of ["PAID", "PAYMENT_PENDING", "FAILED", "REFUNDED"]) {
  r = await get(A, `/teacher/payments?tab=orders&status=${st}`);
  check(`transactions list filters by status ${st}`, r.status === 200 && leaksIn(r.html).length === 0);
}
r = await get(A, "/teacher/students");
check("student list has no Access / Email column", !/Email \/ Mobile/i.test(r.text) && !/\bPREMIUM\b/.test(r.text));

console.log("\n== Results (unreleased included) and student detail");
r = await get(A, `/teacher/tests/${F.mocks.held}/results`);
check("unreleased result: score shown to staff (Live CBT Monitor, teacher mode)", r.text.includes("2 / 3") && r.text.includes("scores shown to staff only") && r.text.includes("Live CBT Monitor"));
r = await get(A, `/teacher/students/${F.students.x}`);
check("student detail: analytics sections (accuracy, exam perf, weak topics, score trend) + attempts; no email", ["Accuracy", "Exam Performance", "Weak Topics", "Score over time", "Test Attempts", "TPH Mock X"].every((k) => r.text.includes(k)) && leaksIn(r.html).length === 0);

console.log("\n== Questions: full preview, expand all, Save & next");
r = await get(A, `/teacher/questions?exam=${F.exams.X}&expand=all`);
const previews = await A.page.locator('[data-testid="full-preview"]').count();
check("expand all: every row shows the full preview", previews >= 4 && r.text.includes("end-of-text-1") && r.text.includes("TPH explanation 1") && r.text.includes("Correct answer"));
await get(A, `/teacher/questions?exam=${F.exams.X}`);
const firstOpen = await A.page.locator("details[open]").count();
check("collapsed by default", firstOpen === 0);
await A.page.locator("details").first().locator("summary").click();
check("expand one row", (await A.page.locator("details[open] [data-testid=full-preview]").count()) === 1);
const firstEdit = await A.page.locator("details[open] a:has-text('Edit')").first().getAttribute("href");
await A.page.goto(`${BASE}${firstEdit}`);
const before = path(A.page);
await A.page.fill("#text", `TPH saved via save and next ${F.sfx}`);
await Promise.all([A.page.waitForURL((u) => u.pathname !== before, { timeout: 30000 }), A.page.click("button:has-text('Save & next')")]);
check("Save & next opens the next question's editor, keeping the filter", /\/teacher\/questions\/[^/]+\/edit$/.test(path(A.page)) && path(A.page) !== before && new URL(A.page.url()).searchParams.get("from")?.includes(F.exams.X));
check("…and the saved message is shown", (await A.page.locator("text=Draft saved").count()) + (await A.page.locator("text=Revision saved").count()) >= 1);
await Promise.all([A.page.waitForURL((u) => u.pathname === "/teacher/questions", { timeout: 30000 }), A.page.click("a:has-text('Back to the question list')")]);
check("Back to list returns to the same filtered list", new URL(A.page.url()).searchParams.get("exam") === F.exams.X);

console.log("\n== Admin unchanged + no write path for teachers");
r = await get(M, `/admin/payments/orders/${F.orders.x2.id}`);
check("admin order page still shows gateway ids and refund history", r.html.includes("pay_LEAK") && r.html.includes("rfnd_LEAK"));
r = await get(M, `/admin/students/${F.students.x}`);
check("admin student page still shows email", r.html.includes(F.leaks[0]));
r = await get(M, `/admin/tests/mock/${F.mocks.held}/live-monitor`);
check("admin live monitor still holds unreleased scores (no score, no staff note) and shows contact", r.text.includes("Held until") && !r.text.includes("2 / 3") && !r.text.includes("scores shown to staff only") && r.html.includes(F.leaks[0]));
r = await get(M, `/admin/students/history?examId=${F.exams.Y}`);
check("admin Test History (shared view) still lists any exam, admin links", r.status === 200 && r.text.includes(F.studentNames.y) && r.html.includes("/admin/students/"));
r = await get(M, "/admin/students/history");
check("admin Test History lists every exam", r.text.includes(F.studentNames.y) && r.text.includes("TPH Student x"));
r = await get(M, "/admin/payments?tab=transactions");
check("admin transactions still list Payment IDs", r.html.includes("pay_LEAK"));
const manifest = JSON.parse(readFileSync(join(APP, ".next/server/server-reference-manifest.json"), "utf8")).node;
const refundId = Object.entries(manifest).find(([, v]) => v.exportedName === "requestRefundAction")?.[0];
const refundsBefore = sql(`select count(*) from "Refund"`);
await A.page.goto(`${BASE}/teacher`);
const st = await A.page.evaluate(async ({ url, id, orderId }) => {
  const fd = new FormData();
  fd.append("_1_orderId", orderId); fd.append("_1_paymentId", "x"); fd.append("_1_amount", "1"); fd.append("_1_reason", "forged"); fd.append("_1_confirm", "REFUND");
  fd.append("0", JSON.stringify([{}, "$K1"]));
  const res = await fetch(url, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component" }, body: fd });
  return res.status;
}, { url: `${BASE}/teacher`, id: refundId, orderId: F.orders.x1.id });
check("teacher's forged refund Server Action changes nothing", sql(`select count(*) from "Refund"`) === refundsBefore, st);
const apiStatus = await A.page.evaluate(async (u) => (await fetch(u)).status, `${BASE}/api/admin/payments/invoices/x`);
check("teacher cannot reach admin payment APIs (403)", apiStatus === 403, apiStatus);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
