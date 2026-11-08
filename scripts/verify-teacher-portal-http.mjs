/**
 * Teacher Portal Phase A — HTTP / browser regression against a scratch server.
 *   BASE=http://localhost:<port> FIXTURE=/tmp/tp.json APP_DIR=<worktree> NODE_PATH=<dir containing playwright> node scripts/verify-teacher-portal-http.mjs
 * Role crawl: every static /admin page and every /api/admin route is refused
 * for a TEACHER session; Teacher Portal pages work and stay inside the
 * teacher's exams; create → submit → approve and unpublish → restore through
 * the real UI; FULL_ADMIN views the queue without decision controls.
 */
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE;
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const APP = process.env.APP_DIR ?? process.cwd();
const DBURL = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/\/mts_[a-z0-9_]+$/.test(DBURL)) throw new Error("DATABASE_URL must be the scratch mts_* database the server uses");
const sql = (q) => execFileSync("psql", [DBURL, "-Atc", q], { encoding: "utf8" }).trim();
const manifest = JSON.parse(readFileSync(join(APP, ".next/server/server-reference-manifest.json"), "utf8")).node;
const actionId = (name) => Object.entries(manifest).find(([, v]) => v.exportedName === name && v.filename.includes("users/teachers/actions"))?.[0];
/** Raw Server Action POST from inside the page (keeps that session's cookies). FormData arg → fields; otherwise JSON args. */
async function callAction(sess, path, name, { fields, args, prev } = {}) {
  const id = actionId(name);
  if (!id) throw new Error(`no action id for ${name}`);
  return sess.page.evaluate(async ({ url, id, fields, args, prev }) => {
    let body;
    if (fields) {
      body = new FormData();
      for (const [k, v] of Object.entries(fields)) body.append(`_1_${k}`, v);
      body.append("0", JSON.stringify(prev ? [{}, "$K1"] : ["$K1"]));
    } else body = JSON.stringify(args);
    const r = await fetch(url, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component" }, body, redirect: "manual" });
    return { status: r.status, text: (await r.text()).slice(0, 300) };
  }, { url: `${BASE}${path}`, id, fields, args, prev });
}
let pass = 0, fail = 0;
const check = (label, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ""}`); ok ? pass++ : fail++; };

function walk(dir, file) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, file));
    else if (e === file) out.push(p);
  }
  return out;
}
const toRoute = (p, root, prefix) => prefix + relative(root, p).split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).map((s) => s).join("/");
const adminPages = walk(join(APP, "app/admin"), "page.tsx").map((p) => toRoute(p, join(APP, "app/admin"), "/admin/").replace(/\/$/, "")).filter((r) => !r.includes("[") && r !== "/admin/login");
const apiRoutes = walk(join(APP, "app/api/admin"), "route.ts").map((p) => toRoute(p, join(APP, "app/api/admin"), "/api/admin/").replace(/\[\.\.\.[^\]]+\]/g, "x").replace(/\[[^\]]+\]/g, "x"));

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
const path = (page) => new URL(page.url()).pathname;

// ---------------------------------------------------------------- teacher lockout
console.log("\n== Teacher session: admin area refused");
const T = await login("teacher");
await T.page.waitForURL((u) => u.pathname.startsWith("/teacher"), { timeout: 15000 }).catch(() => {});
check("teacher lands on the Teacher Portal after sign-in", path(T.page) === "/teacher", T.page.url());
let leaked = [];
for (const r of adminPages) {
  const res = await T.page.goto(`${BASE}${r}`);
  const p = path(T.page);
  if (!(p === "/teacher" || p.startsWith("/teacher/"))) leaked.push(`${r} → ${p} (${res?.status()})`);
}
check(`all ${adminPages.length} static /admin pages redirect a teacher to /teacher`, leaked.length === 0, leaked.join(", "));
leaked = [];
for (const r of apiRoutes) {
  for (const method of ["GET", "POST"]) {
    const res = await T.ctx.request.fetch(`${BASE}${r}`, { method, maxRedirects: 0, failOnStatusCode: false });
    if (res.status() !== 403) leaked.push(`${method} ${r} → ${res.status()}`);
  }
}
check(`all ${apiRoutes.length} /api/admin routes return 403 for a teacher (GET+POST)`, leaked.length === 0, leaked.join(", "));
const tr = await T.ctx.request.get(`${BASE}/storage/test-resources/anything.pdf`, { failOnStatusCode: false, maxRedirects: 0 });
check("test-resource files refused (404) for a teacher", tr.status() === 404, tr.status());
await T.page.goto(`${BASE}/admin/login`);
check("signed-in teacher opening /admin/login is sent to /teacher", path(T.page) === "/teacher");

// ---------------------------------------------------------------- portal + scope
console.log("\n== Teacher Portal and exam scope");
for (const p of ["/teacher", "/teacher/questions", "/teacher/tests", "/teacher/requests", `/teacher/questions/${F.qa[0]}`, `/teacher/tests/${F.mockA}`, `/teacher/questions/new`]) {
  const res = await T.page.goto(`${BASE}${p}`);
  check(`${p.replace(/c[a-z0-9]{20,}/, "<id>")} → 200`, res?.status() === 200 && path(T.page) === p.split("?")[0], `${res?.status()} ${T.page.url()}`);
}
let res = await T.page.goto(`${BASE}/teacher/questions/${F.qb[0]}`);
check("question of an unassigned exam → 404", res?.status() === 404, res?.status());
res = await T.page.goto(`${BASE}/teacher/tests/${F.mockB}`);
check("mock test of an unassigned exam → 404", res?.status() === 404, res?.status());
res = await T.page.goto(`${BASE}/teacher/questions?exam=${F.examB}`);
check("question list ignores an unassigned exam filter", !(await T.page.content()).includes("TPH question 1 of B"));
const body = await T.page.goto(`${BASE}/teacher/questions`).then(() => T.page.content());
check("question list shows only assigned-exam questions", body.includes("TPH question 1 of A") && !body.includes("of B"));

// ---------------------------------------------------------------- create → submit
console.log("\n== Create Draft → submit for publication (UI)");
await T.page.goto(`${BASE}/teacher/questions/new`);
await T.page.selectOption("#subjectId", F.subjA);
await T.page.fill("#text", `TPH teacher created ${F.sfx}`);
for (const l of ["A", "B", "C", "D"]) await T.page.fill(`input[name="option${l}"]`, `Opt ${l}`);
await T.page.check('input[name="correctOption"][value="C"]');
check("form has no Status / Source / PYQ / image-upload controls", (await T.page.locator("#status, #source, #previousYearPaperId, input[type=file]").count()) === 0);
await Promise.all([T.page.waitForURL(/\/teacher\/questions\/[^/]+\?ok=created/, { timeout: 30000 }), T.page.click('button[type="submit"]:has-text("Save as Draft")')]);
const newId = path(T.page).split("/").pop();
check("question created and shown as Draft", (await T.page.content()).includes("Draft") && (await T.page.locator("text=Question created as Draft").count()) === 1);
await T.page.click("summary:has-text('Submit for publication')");
await T.page.fill("details[open] textarea[name=reason]", "Ready for the students of this exam");
await Promise.all([T.page.waitForURL(/ok=1/), T.page.click("details[open] button:has-text('Submit for approval')")]);
check("publication request sent", (await T.page.content()).includes("Waiting for publication approval"));

// ---------------------------------------------------------------- unpublish
console.log("\n== Unpublish from Mock Test (UI)");
await T.page.goto(`${BASE}/teacher/tests/${F.mockA}`);
await T.page.locator("summary:has-text('Unpublish from this test')").first().click();
await T.page.fill("details[open] textarea[name=reason]", "Wrong answer key in this test");
await Promise.all([T.page.waitForURL(/ok=1/), T.page.click("details[open] button:has-text('Unpublish now')")]);
check("question shown as unpublished from the test", (await T.page.locator("text=/^Unpublished /").count()) === 1);
await T.page.goto(`${BASE}/teacher/requests`);
const reqText = await T.page.locator("main").innerText();
check("My Requests lists both requests with status", /Publish question/.test(reqText) && /Unpublished from Mock Test/.test(reqText) && /Pending/.test(reqText));

// ---------------------------------------------------------------- full admin view
console.log("\n== FULL_ADMIN: view only");
const FA = await login("full");
await FA.page.goto(`${BASE}/admin/users/teachers/approvals`);
const faText = await FA.page.locator("main").innerText();
check("FULL_ADMIN sees the queue", /Teacher Content Approvals/.test(faText) && /Publish question/.test(faText));
await Promise.all([FA.page.waitForURL(/approvals\/[^/?]+/), FA.page.click("a:has-text('Publish question')")]);
check("FULL_ADMIN has no decision controls", (await FA.page.locator("text=Approve and publish").count()) === 0 && (await FA.page.locator("summary:has-text('Reject')").count()) === 0);
await FA.page.goto(`${BASE}/teacher`);
check("FULL_ADMIN opening /teacher is sent to /admin", path(FA.page) === "/admin");

// ---------------------------------------------------------------- master approves
console.log("\n== MASTER_ADMIN decides");
const MA = await login("master");
await MA.page.goto(`${BASE}/admin`);
check("dashboard shows Teacher content approvals", (await MA.page.locator("text=Teacher content approvals").count()) > 0);
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
check("Teachers tab lists the teacher and the queue link", (await MA.page.locator(`text=@${F.accounts.teacher.username}`).count()) === 1 && (await MA.page.locator("text=Open the approval queue").count()) === 1);
await MA.page.goto(`${BASE}/admin/users/teachers/approvals`);
await Promise.all([MA.page.waitForURL(/approvals\/[^/?]+/), MA.page.click("a:has-text('Publish question')")]);
await MA.page.click("summary:has-text('Approve and publish')");
await Promise.all([MA.page.waitForURL(/ok=/), MA.page.click("details[open] button:has-text('Approve and publish')")]);
check("approval publishes the question", (await MA.page.locator("text=Approved — the question is now published.").count()) === 1);
await MA.page.goto(`${BASE}/admin/users/teachers/approvals`);
await Promise.all([MA.page.waitForURL(/approvals\/[^/?]+/), MA.page.click("a:has-text('Unpublished from Mock Test')")]);
const noticeText = await MA.page.locator("main").innerText();
check("unpublish notice shows impact and ranking note", /submitted and/.test(noticeText) && /Ranking:/.test(noticeText) && /currently unpublished from this test/.test(noticeText), noticeText.slice(0, 900));
await MA.page.click("summary:has-text('Restore the question to the test')");
await Promise.all([MA.page.waitForURL(/ok=/), MA.page.click("details[open] button:has-text('Restore')")]);
check("Master Admin restores the question", (await MA.page.locator("text=Restored").count()) >= 1);
await MA.page.goto(`${BASE}/admin/tests/mock/${F.mockA}`);
check("admin Mock Test page still loads", path(MA.page) === `/admin/tests/mock/${F.mockA}`);

await T.page.goto(`${BASE}/teacher/questions/${newId}`);
check("teacher sees the question Published", (await T.page.locator("main").innerText()).includes("Published"));
// ---------------------------------------------------------------- direct Server Action calls
console.log("\n== Approval actions called directly (bypassing the UI)");
await T.page.goto(`${BASE}/teacher/questions/${newId}`);
await T.page.click("summary:has-text('Request permanent deletion')");
await T.page.fill("details[open] textarea[name=reason]", "Duplicate of an existing question");
await Promise.all([T.page.waitForURL(/ok=1/), T.page.click("details[open] button:has-text('Send deletion request')")]);
const delId = sql(`select id from "TeacherContentRequest" where type='DELETE_REQUEST' and status='OPEN' and "questionId"='${newId}'`);
check("deletion request created through the UI", /^c[a-z0-9]+$/.test(delId), delId);
const stateOf = (id) => sql(`select status from "TeacherContentRequest" where id='${id}'`);
for (const [who, sess] of [["TEACHER", T], ["FULL_ADMIN", FA]]) {
  for (const path of ["/teacher", `/admin/users/teachers/approvals/${delId}`]) {
    await sess.page.goto(`${BASE}${who === "TEACHER" ? "/teacher" : "/admin"}`);
    await callAction(sess, path, "approveTeacherRequestAction", { fields: { requestId: delId, note: "forged" } });
    await callAction(sess, path, "rejectTeacherRequestAction", { fields: { requestId: delId, note: "forged" } });
  }
  check(`${who}: direct approve/reject POSTs leave the request OPEN`, stateOf(delId) === "OPEN", stateOf(delId));
}
const usersBefore = sql(`select count(*) from "AdminUser"`);
await T.page.goto(`${BASE}/teacher`);
await callAction(T, "/teacher", "createTeacherAction", { fields: { name: "Forged", username: `forged-${F.sfx}`, email: "", password: "forged-password-1" }, prev: true });
await callAction(T, "/teacher", "setTeacherStatusAction", { args: [F.accounts.teacherB.id, "SUSPENDED"] });
await callAction(T, "/teacher", "assignExamAction", { args: [F.accounts.teacher.id, {}], fields: undefined });
check("TEACHER: direct create-teacher / suspend / assign POSTs change nothing", sql(`select count(*) from "AdminUser"`) === usersBefore && sql(`select status from "TeacherProfile" where "adminUserId"='${F.accounts.teacherB.id}'`) === "ACTIVE" && sql(`select count(*) from "TeacherExamAssignment" where "teacherId"='${F.accounts.teacher.id}' and "examId"='${F.examB}'`) === "0");
await FA.page.goto(`${BASE}/admin`);
await callAction(FA, "/admin", "setTeacherStatusAction", { args: [F.accounts.teacher.id, "DEACTIVATED"] });
check("FULL_ADMIN: direct teacher-status POST changes nothing", sql(`select "isActive" from "AdminUser" where id='${F.accounts.teacher.id}'`) === "t");
await MA.page.goto(`${BASE}/admin`);
const ok = await callAction(MA, `/admin/users/teachers/approvals/${delId}`, "approveTeacherRequestAction", { fields: { requestId: delId, note: "approved via direct call" } });
check("MASTER_ADMIN: the same direct call works (harness sanity)", stateOf(delId) === "APPROVED", ok);

// ---------------------------------------------------------------- statuses + Retire / Replace link
console.log("\n== Approval statuses and Retire / Replace link");
await MA.page.goto(`${BASE}/admin/users/teachers/approvals/${delId}`);
let detail = await MA.page.locator("main").innerText();
check("approved deletion shows 'Approved — action not yet applied'", detail.includes("Approved — action not yet applied"));
const link = MA.page.locator('[data-testid="retire-replace-link"]');
check("direct link to the Retire / Replace preview", (await link.count()) === 1 && (await link.getAttribute("href")) === `/admin/questions/${newId}/replace`);
await Promise.all([MA.page.waitForURL(new RegExp(`/admin/questions/${newId}/replace`)), link.click()]);
check("Retire / Replace preview page opens", (await MA.page.locator("main").innerText()).length > 50 && path(MA.page) === `/admin/questions/${newId}/replace`);
// teacher: grand test + live CBT requests
await T.page.goto(`${BASE}/teacher/questions/${F.qa[1]}`);
await T.page.locator("summary:has-text('Request unpublish')").first().click();
await T.page.fill("details[open] textarea[name=reason]", "Remove from the grand test please");
await Promise.all([T.page.waitForURL(/ok=1/), T.page.click("details[open] button:has-text('Send unpublish request')")]);
await T.page.goto(`${BASE}/teacher/tests/${F.liveA}`);
await T.page.locator("summary:has-text('Request unpublish')").first().click();
await T.page.fill("details[open] textarea[name=reason]", "Remove from the live CBT please");
await Promise.all([T.page.waitForURL(/ok=1/), T.page.click("details[open] button:has-text('Send unpublish request')")]);
const reqId = (kind) => sql(`select id from "TeacherContentRequest" where type='UNPUBLISH_REQUEST' and "targetKind"='${kind}' order by "createdAt" desc limit 1`);
const grandReq = reqId("GRAND_TEST"), liveReq = reqId("MOCK_TEST");
await MA.page.goto(`${BASE}/admin/users/teachers/approvals`);
check("queue shows both as Pending", (await MA.page.locator('[data-status="PENDING"]').count()) >= 2);
const decide = async (id, which, label) => {
  await MA.page.goto(`${BASE}/admin/users/teachers/approvals/${id}`);
  await MA.page.click(`summary:has-text('${label}')`);
  if (which === "reject") await MA.page.fill("details[open] textarea[name=note]", "Not needed — keep the question");
  else await MA.page.fill("details[open] textarea[name=note]", "Approved via the UI with a note");
  await Promise.all([MA.page.waitForURL(/(ok|err)=/), MA.page.click(`details[open] button:has-text('${label === "Reject" ? "Reject" : label}')`)]);
  return MA.page.locator("main").innerText();
};
detail = await decide(grandReq, "approve", "Approve (then apply with Retire / Replace)");
check("Grand Test approved → 'Approved — action not yet applied' + Retire / Replace link", detail.includes("Approved — action not yet applied") && (await MA.page.locator('[data-testid="retire-replace-link"]').count()) === 1);
detail = await decide(liveReq, "approve", "Approve and unpublish from this test");
check("Live CBT approved → 'Applied'", (await MA.page.locator('[data-status="APPLIED"]').count()) === 1, detail.slice(0, 300));
await T.page.goto(`${BASE}/teacher/questions/${F.qa[1]}`);
await T.page.locator("summary:has-text('Request unpublish')").first().click();
await T.page.fill("details[open] textarea[name=reason]", "Second request for the grand test");
await Promise.all([T.page.waitForURL(/ok=1/), T.page.click("details[open] button:has-text('Send unpublish request')")]);
detail = await decide(reqId("GRAND_TEST"), "reject", "Reject");
check("rejected request → 'Rejected'", (await MA.page.locator('[data-status="REJECTED"]').count()) === 1, detail.slice(0, 600));
await MA.page.goto(`${BASE}/admin/users/teachers/approvals?status=NOT_APPLIED`);
const naText = await MA.page.locator("main").innerText();
check("'Approved — action not yet applied' tab lists the deletion and the Grand Test request", (await MA.page.locator('tbody [data-status="NOT_APPLIED"]').count()) >= 2 && naText.includes("Permanent deletion request") && naText.includes("Unpublish request"), naText.slice(0, 400));
check("decision notes typed in the UI are stored", sql(`select count(*) from "TeacherContentRequest" where "decisionNote" in ('Approved via the UI with a note','Not needed — keep the question') and id in ('${grandReq}','${liveReq}','${reqId("GRAND_TEST")}')`) === "3");
await T.page.goto(`${BASE}/teacher/requests`);
const myReq = await T.page.locator("main").innerText();
check("teacher sees Pending / Approved — action not yet applied / Applied / Rejected", ["Approved — action not yet applied", "Applied", "Rejected"].every((l) => myReq.includes(l)), myReq.slice(0, 500));

// ---------------------------------------------------------------- concurrent editing in two browsers
console.log("\n== Concurrent editing (two editors, real UI)");
const E2 = await login("teacher");
const qEdit = F.qa[2];
await T.page.goto(`${BASE}/teacher/questions/${qEdit}/edit`);
await E2.page.goto(`${BASE}/teacher/questions/${qEdit}/edit`);
await T.page.fill("#text", "Edited in the first window");
await Promise.all([T.page.waitForURL(/ok=revision/), T.page.click('button[type="submit"]:has-text("Save revision as Draft")')]);
await E2.page.fill("#text", "Edited in the stale second window");
await E2.page.click('button[type="submit"]:has-text("Save revision as Draft")');
await E2.page.waitForSelector("text=Someone else changed this question", { timeout: 15000 }).catch(() => {});
check("second (stale) editor is told about the conflict", (await E2.page.locator("text=Someone else changed this question").count()) === 1);
const proposed = sql(`select "proposedSnapshot"->>'text' from "QuestionRevision" where "questionId"='${qEdit}' and status in ('DRAFT','SUBMITTED')`);
check("the first editor's revision is kept, not overwritten", proposed === "Edited in the first window", proposed);
check("live published question unchanged", sql(`select text from "Question" where id='${qEdit}'`).startsWith("TPH question"));
await E2.ctx.close();

// ---------------------------------------------------------------- live session invalidation
console.log("\n== Session invalidation (real sessions)");
const teacherCard = () => MA.page.locator("div").filter({ has: MA.page.locator(`text=@${F.accounts.teacher.username}`) }).filter({ has: MA.page.locator("button:has-text('Deactivate')") }).last();
MA.page.on("dialog", (d) => d.accept());
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await teacherCard().locator("button:has-text('remove')").first().click();
await MA.page.waitForTimeout(1500);
check("exam revoked (DB)", sql(`select count(*) from "TeacherExamAssignment" where "teacherId"='${F.accounts.teacher.id}' and "revokedAt" is null`) === "0");
res = await T.page.goto(`${BASE}/teacher/questions/${F.qa[0]}`);
check("revocation: the teacher's very next request gets 404 for that exam's question", res?.status() === 404, res?.status());
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await teacherCard().locator('select[name="examId"]').selectOption(F.examA);
await teacherCard().locator("button:has-text('Assign')").click();
await MA.page.waitForTimeout(1500);
res = await T.page.goto(`${BASE}/teacher/questions/${F.qa[0]}`);
check("re-assignment restores access without a new sign-in", res?.status() === 200, res?.status());
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await teacherCard().locator("button:has-text('Suspend')").click();
await MA.page.waitForTimeout(1500);
const reqCount = sql(`select count(*) from "TeacherContentRequest"`);
await T.page.goto(`${BASE}/teacher`);
check("suspension: the teacher's existing session is dead at once (sent to sign-in)", path(T.page) === "/admin/login", T.page.url());
const forged = await T.page.evaluate(async (u) => (await fetch(u, { method: "POST", headers: { "Next-Action": "x" }, body: "[]" })).status, `${BASE}/teacher/tests/${F.mockA}`);
check("suspension: old session can't create requests", sql(`select count(*) from "TeacherContentRequest"`) === reqCount, forged);
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await teacherCard().getByRole("button", { name: "Activate", exact: true }).click();
await MA.page.waitForTimeout(1500);
await T.page.goto(`${BASE}/teacher`);
check("re-activation does not revive the old session", path(T.page) === "/admin/login");
const T2 = await login("teacher");
await T2.page.waitForURL((u) => u.pathname.startsWith("/teacher"), { timeout: 15000 }).catch(() => {});
check("after re-activation the teacher can sign in again", path(T2.page) === "/teacher", T2.page.url());
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await teacherCard().locator("button:has-text('Deactivate')").click();
await MA.page.waitForTimeout(1500);
await T2.page.goto(`${BASE}/teacher`);
check("deactivation: the session is dead at once", path(T2.page) === "/admin/login", T2.page.url());
await T2.page.fill('input[name="username"]', F.accounts.teacher.username);
await T2.page.fill('input[name="password"]', F.accounts.teacher.password);
await T2.page.click('button[type="submit"]');
await T2.page.waitForTimeout(3000);
check("deactivation: sign-in refused", path(T2.page) === "/admin/login");

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
