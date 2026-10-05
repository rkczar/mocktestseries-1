/**
 * Inactive-exam draft-leak regression over HTTP — a signed-in student posts
 * the real Server Actions and opens the real pages with the ids of an
 * INACTIVE exam that still holds an active Previous Year Paper, PUBLISHED
 * questions, a PUBLISHED Mock Test and a Custom Module. Every call must be
 * refused or empty, and the same calls against an ACTIVE control exam must
 * work (so a refusal is the gate, not a broken fixture).
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-exam-live-gate.ts setup > /tmp/elg.json
 *   BASE=http://localhost:3111 FIXTURE=/tmp/elg.json DATABASE_URL=<scratch> \
 *     NODE_PATH=/root/.claude/skills/gstack/node_modules node scripts/verify-exam-live-gate.mjs
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-exam-live-gate.ts cleanup /tmp/elg.json
 *
 * BASE must match the server's NEXTAUTH_URL origin (use localhost, not 127.0.0.1).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { Client } = require("pg");

const BASE = process.env.BASE ?? "http://localhost:3111";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../.next/server/server-reference-manifest.json", import.meta.url), "utf8")).node;
const actionId = (name, file) => Object.entries(manifest).find(([, v]) => v.exportedName === name && v.filename.includes(file))?.[0];

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
}

const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/\?schema=.*$/, "") });
await db.connect();
const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].n);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

await page.goto(`${BASE}/login`);
await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
await page.fill("#identifier", F.email);
await page.fill("input[name=password]", F.password);
await page.locator("form:has(#identifier) button[type=submit]").click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
await page.waitForLoadState("load");

/** In-page navigation fetch (keeps the Secure device cookie): final path + body text. */
async function open(url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "same-origin" });
    const at = new URL(r.url);
    return { status: r.status, at: at.pathname + at.search, body: await r.text() };
  }, url);
}
/** Server Action with JSON args. */
async function jsonAction(path, id, args) {
  return page.evaluate(
    async ({ path, id, args }) => {
      const r = await fetch(path, { method: "POST", headers: { "Next-Action": id, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" }, body: JSON.stringify(args) });
      return { status: r.status, text: await r.text() };
    },
    { path, id, args }
  );
}
/** useActionState Server Action: (prevState, formData). */
async function formAction(path, id, fields) {
  return page.evaluate(
    async ({ path, id, fields }) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(`_1_${k}`, v);
      fd.append("0", JSON.stringify([{}, "$K1"]));
      const r = await fetch(path, { method: "POST", headers: { "Next-Action": id, Accept: "text/x-component" }, body: fd, redirect: "manual" });
      return { status: r.status, text: await r.text(), redirect: r.headers.get("x-action-redirect") };
    },
    { path, id, fields }
  );
}
/** Last RSC line of an action response = its return value. */
const actionValue = (text) => {
  const line = text.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line.slice(line.indexOf(":") + 1));
  } catch {
    return line;
  }
};

const ids = {
  subjectCount: actionId("countAvailableQuestionsAction", "subject-test/actions"),
  subjectStart: actionId("startSubjectTestAction", "subject-test/actions"),
  moduleCount: actionId("countCustomModuleQuestionsAction", "custom-module/builder/actions"),
  moduleCreate: actionId("createCustomModuleAction", "student/(dashboard)/custom-module/builder/actions"),
};
check("all four student Server Action ids found in the build manifest", Object.values(ids).every(Boolean), ids);

async function probe(E, live) {
  const tag = live ? "LIVE control" : "INACTIVE";
  const before = await count(`select count(*) n from "TestAttempt" where "examId"=$1`, [E.examId]);
  const modulesBefore = await count(`select count(*) n from "CustomModule" where "examId"=$1`, [E.examId]);

  // --- pages reached by direct id
  const examPage = await open(`/student/exams/${E.examId}`);
  check(`[${tag}] /student/exams/<id> ${live ? "shows" : "hides"} the exam`, examPage.body.includes(E.examName) === live, examPage.at);
  const pyq = await open(`/student/attempt/resume?paper=${E.paperId}`);
  check(`[${tag}] PYQ start page ${live ? "shows" : "refuses"} the Pre-Test Setup`, pyq.body.includes("pre-test-setup") === live, pyq.at);
  const mock = await open(`/student/test-series/${E.mockId}`);
  check(`[${tag}] Mock details by id ${live ? "shows" : "hides"} the mock`, mock.body.includes(`ELG ${live ? "Live" : "Hidden"} Mock`) === live, mock.at);
  const mod = await open(`/student/custom-module/${E.moduleId}`);
  check(`[${tag}] Custom Module by id ${live ? "shows" : "hides"} the module`, mod.body.includes(`ELG ${live ? "Live" : "Hidden"} Module`) === live, mod.at);
  const shared = await open(`/student/custom-module/shared/${E.shareToken}`);
  check(`[${tag}] Shared module link ${live ? "shows" : "hides"} the module`, shared.body.includes(`ELG ${live ? "Live" : "Hidden"} Module`) === live, shared.at);

  // --- Server Actions with the examId posted directly
  const filters = { examId: E.examId, subjectId: E.subjectId };
  const sc = actionValue((await jsonAction(`/student/subject-test/${E.examId}`, ids.subjectCount, [filters])).text);
  check(`[${tag}] Subject Test question count = ${live ? 6 : 0}`, sc === (live ? 6 : 0), sc);
  const mc = actionValue((await jsonAction("/student/custom-module/builder", ids.moduleCount, [filters])).text);
  check(`[${tag}] Custom Module question count = ${live ? 6 : 0}`, mc === (live ? 6 : 0), mc);

  const practice = { answerMode: "EXAM", durationMode: "PER_QUESTION" };
  const st = await formAction(`/student/subject-test/${E.examId}`, ids.subjectStart, { examId: E.examId, subjectId: E.subjectId, count: "3", ...practice });
  if (live) check(`[${tag}] Subject Test start redirects to an attempt`, /\/student\/attempt\//.test(st.redirect ?? ""), st);
  else check(`[${tag}] Subject Test start refused with "This exam is not available."`, st.text.includes("This exam is not available.") && !st.redirect, st.text.slice(-200));

  const cm = await formAction("/student/custom-module/builder", ids.moduleCreate, { examId: E.examId, subjectId: E.subjectId, count: "3", ...practice });
  if (live) check(`[${tag}] Custom Module create redirects to an attempt`, /\/student\/attempt\//.test(cm.redirect ?? ""), cm);
  else check(`[${tag}] Custom Module create refused with "This exam is not available."`, cm.text.includes("This exam is not available.") && !cm.redirect, cm.text.slice(-200));

  const after = await count(`select count(*) n from "TestAttempt" where "examId"=$1`, [E.examId]);
  const modulesAfter = await count(`select count(*) n from "CustomModule" where "examId"=$1`, [E.examId]);
  if (live) check(`[${tag}] attempts were created (2) and one module`, after - before === 2 && modulesAfter - modulesBefore === 1, { before, after, modulesBefore, modulesAfter });
  else check(`[${tag}] no TestAttempt and no CustomModule row was written`, after === before && modulesAfter === modulesBefore, { before, after, modulesBefore, modulesAfter });
}

console.log("— Inactive exam (draft-leak)");
await probe(F.inactive, false);
console.log("— Active control exam");
await probe(F.control, true);

console.log("— Public surfaces");
{
  const sitemap = await open("/sitemap.xml");
  check("sitemap has no inactive-exam paper/exam ids", !sitemap.body.includes(F.inactive.examId) && !sitemap.body.includes(F.inactive.paperId), sitemap.status);
  const exams = await open("/exams");
  check("/exams directory does not list the inactive exam", !exams.body.includes(F.inactive.examName), exams.status);
  const catalog = await open("/student/exams");
  check("student exam catalog does not list the inactive exam", !catalog.body.includes(F.inactive.examName), catalog.at);
}

await browser.close();
await db.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
