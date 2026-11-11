/**
 * Importer P1 UI (2026-11-11) — academic-review hold card and permission, real browser against a LOCAL production
 * build on a DISPOSABLE database (fixture: scripts/importer-p1-ui-fixture.ts; paid AI OFF). Results checked in the DB.
 *
 *   BASE=http://localhost:<p> FIXTURE=<fx.json> DATABASE_URL=<scratch mts_*> SHOTS=<dir> NODE_PATH=<playwright dir> \
 *     node scripts/verify-importer-p1-ui.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium, devices } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? "";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE) || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Runs only against a local server on a scratch mts_* database.");
  process.exit(2);
}
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  ok ? pass++ : fail++;
};
const state = () => JSON.parse(execFileSync("npx", ["tsx", "scripts/importer-p1-ui-fixture.ts", "state", process.env.FIXTURE], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }).trim().split("\n").pop());
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {}); };
const settle = async (page) => { await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(800); };

async function login(browser, acct, ctxOpts = { viewport: { width: 1366, height: 900 } }) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", acct.username);
  await page.fill("input[name=password]", acct.password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }).catch(() => null), page.locator("form button[type=submit]").click()]);
  return { ctx, page, ok: !page.url().includes("/admin/login") };
}
const open = async (page, id) => {
  await page.goto(`${BASE}/admin/ai-importer/questions/${id}`);
  await page.locator("main").first().waitFor({ timeout: 30000 }).catch(() => {});
  await settle(page);
};

async function main() {
  const browser = await chromium.launch();
  const s0 = state();
  const m = await login(browser, F.accounts.master);
  check("Master Admin logs in (local build, scratch DB)", m.ok, m.page.url());

  console.log("\n=== Master Admin: academic-review hold card");
  await open(m.page, F.rows.qa);
  await shot(m.page, "01-hold-card");
  const card = m.page.locator("[data-testid=rv-academic]");
  check("hold card shown on the held question", (await card.count()) === 1);
  check("…shows the affected question (number + page)", /Q1 · page 1/.test(await m.page.locator("[data-testid=rv-academic-question]").innerText()));
  check("…shows the reason and the stored note", /AMBIGUOUS_PENDING_ACADEMIC_REVIEW/.test(await m.page.locator("[data-testid=rv-academic-reason]").innerText()) && /alternative: S03-T02/.test(await m.page.locator("[data-testid=rv-academic-reason]").innerText()));
  check("…shows the current mapping", /Food Technology/.test(await m.page.locator("[data-testid=rv-academic-current]").innerText()) && /Post-harvest/.test(await m.page.locator("[data-testid=rv-academic-current]").innerText()));
  check("…import shown as blocked by the hold", /blocked — taxonomy pending academic review/.test(await m.page.locator("body").innerText()));
  const btn = m.page.locator("[data-testid=rv-academic-clear]");
  check("Clear is disabled until the decision is confirmed and a reason written", await btn.isDisabled());
  await m.page.locator("[data-testid=rv-academic-confirm]").check();
  check("…still disabled with the tick but no reason", await btn.isDisabled());
  await m.page.locator("[data-testid=rv-academic-note]").fill("Post-harvest handling per syllabus unit VIII (UI test decision)");
  check("…enabled with tick + reason", await btn.isEnabled());
  // Record the server-action request so the same call can be replayed by an account without the right.
  let actionReq = null;
  m.page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"] && !actionReq) actionReq = { url: r.url(), headers: r.headers(), body: r.postData() }; });
  await btn.click();
  await m.page.getByText(/Academic hold cleared/).first().waitFor({ timeout: 20000 }).catch(() => {});
  await settle(m.page);
  const s1 = state();
  check("clicking Clear removes the hold of QA only", s1.rows[F.rows.qa].hold === null && s1.rows[F.rows.qb].hold === "AMBIGUOUS_PENDING_ACADEMIC_REVIEW", s1.rows);
  check("…approval and subject/topic untouched (not approved, same mapping)", !s1.rows[F.rows.qa].approved && s1.rows[F.rows.qa].reviewedAt === s0.rows[F.rows.qa].reviewedAt && s1.rows[F.rows.qa].subjectId === s0.rows[F.rows.qa].subjectId && s1.rows[F.rows.qa].topicId === s0.rows[F.rows.qa].topicId, s1.rows[F.rows.qa]);
  check("…event with the decision reason + audit log written", s1.cleared === 1 && /syllabus unit VIII/.test(s1.clearedNote ?? "") && s1.audit === s0.audit + 1, s1);
  await open(m.page, F.rows.qa);
  check("…the card is gone and import is no longer blocked by a hold", (await m.page.locator("[data-testid=rv-academic]").count()) === 0 && !/taxonomy pending academic review/.test(await m.page.locator("body").innerText()));
  await shot(m.page, "02-after-clear");

  const msgAfterApprove = async (page) => {
    await page.locator("[data-testid=rv-approve]").click();
    // The message renders after the server action returns and the page refreshes: wait for its text, not just the element.
    await page.waitForFunction(() => (document.querySelector("[data-testid=review-msg]")?.textContent ?? "").trim().length > 0, null, { timeout: 30000 }).catch(() => {});
    await settle(page);
    return (await page.locator("[data-testid=review-msg]").innerText().catch(() => "")).trim();
  };

  console.log("\n=== Academic hold: refusal explains the fix; valid mapping approves after an explicit clear");
  await open(m.page, F.rows.qb);
  const holdMsg = await msgAfterApprove(m.page);
  await shot(m.page, "05-hold-refusal");
  check("approving a held question is refused with the code AND how to clear it", /AMBIGUOUS_PENDING_ACADEMIC_REVIEW\) — choosing a subject\/topic does not clear this hold/.test(holdMsg) && /Clear hold — mapping confirmed/.test(holdMsg), holdMsg);
  check("…QB still held and not approved", (() => { const r = state().rows[F.rows.qb]; return r.hold === "AMBIGUOUS_PENDING_ACADEMIC_REVIEW" && !r.approved; })());
  await open(m.page, F.rows.qa);
  const qaMsg = await msgAfterApprove(m.page);
  check("QA (hold cleared, valid exam→subject→topic) approves only when the admin clicks Approve", /^Approved\./.test(qaMsg) && state().rows[F.rows.qa].approved, qaMsg);

  console.log("\n=== Formula text damaged (copy of FSO Q136) — blocking, never repaired automatically");
  await open(m.page, F.rows.qc);
  await shot(m.page, "06-formula-damaged");
  const qcBody = await m.page.locator("[data-testid=q-issues]").innerText().catch(() => "");
  check("flag shown with its label", /Formula text damaged \(control characters\)/.test(qcBody), qcBody.slice(0, 400));
  check("…the hidden TAB is shown visibly (⟨TAB⟩ext) with a suggested repair", /⟨TAB⟩ext/.test(qcBody) && /Suggested: “\$13\^\{\\text\{th\}\}\$/.test(qcBody), qcBody.slice(0, 600));
  // Like prod Q136, QC was approved before the check existed: the page offers "withdraw", and import is blocked.
  check("…already-approved QC shows import blocked by the damage", /blocked — Formula text damaged/.test(await m.page.locator("body").innerText()), (await m.page.locator("body").innerText()).match(/blocked[^\n]*/)?.[0]);
  if (await m.page.locator("[data-testid=rv-unapprove]").count()) {
    await m.page.locator("[data-testid=rv-unapprove]").click();
    await m.page.locator("[data-testid=rv-approve]").waitFor({ timeout: 20000 }).catch(() => {});
    await settle(m.page);
  }
  const qcMsg = await msgAfterApprove(m.page);
  check("Approve refused: Formula text damaged", /^Not approved: .*Formula text damaged/.test(qcMsg), qcMsg);
  const qcAfter = state().rows[F.rows.qc];
  check("…stored text untouched (no automatic repair, no edit)", qcAfter.data === s0.rows[F.rows.qc].data && !qcAfter.edited && JSON.parse(qcAfter.data)[1][0] === "$13^{\text{th}}$ February, 1986", qcAfter);

  console.log("\n=== Formula needs manual verification (formula read by local OCR)");
  await open(m.page, F.rows.qd);
  await shot(m.page, "07-formula-manual");
  const qdBody = await m.page.locator("[data-testid=q-issues]").innerText().catch(() => "");
  check("flag shown with its label and reason", /Formula needs manual verification against the page/.test(qdBody) && /local OCR/.test(qdBody), qdBody.slice(0, 400));
  check("…not repaired or edited", !state().rows[F.rows.qd].edited);
  await m.page.goto(`${BASE}/admin/ai-importer/exceptions?job=${F.jobId}&status=all`);
  await settle(m.page);
  const rowOf = (n) => m.page.locator("[data-testid=exception-row]").filter({ has: m.page.locator(`input[aria-label="Select Q${n}"]`) });
  check("QC, QD and QE listed on the exceptions page", (await rowOf(3).count()) === 1 && (await rowOf(4).count()) === 1 && (await rowOf(5).count()) === 1);
  for (const n of [3, 4, 5]) await m.page.locator(`input[aria-label="Select Q${n}"]`).check();
  await m.page.locator("[data-testid=bulk-approve]").click();
  await m.page.locator("[data-testid=bulk-msg]").waitFor({ timeout: 20000 }).catch(() => {});
  await settle(m.page);
  await shot(m.page, "08-bulk-approve");
  const bulkMsg = (await m.page.locator("[data-testid=bulk-msg]").innerText().catch(() => "")).trim();
  const sb = state();
  check("bulk approval: clean QE approved; QD refused (decide on its own page); QC refused (damaged)", /^1 approved; 2 not approved/.test(bulkMsg) && /Q4: unresolved formula needs manual verification against the page — open the question and decide it on its own/.test(bulkMsg) && /Q3: Formula text damaged/.test(bulkMsg) && sb.rows[F.rows.qe].approved && !sb.rows[F.rows.qd].approved, bulkMsg);
  await open(m.page, F.rows.qd);
  const qdMsg = await msgAfterApprove(m.page);
  check("individual approval on QD's own page (the admin's check) → Approved", /^Approved\./.test(qdMsg) && state().rows[F.rows.qd].approved, qdMsg);
  const sEnd = state();
  check("no question imported or published by any of this (Question Bank count unchanged)", sEnd.bankQuestions === s0.bankQuestions && Object.values(sEnd.rows).every((r) => !r.questionId), { before: s0.bankQuestions, after: sEnd.bankQuestions });

  console.log("\n=== Refusal logging");
  if (actionReq && process.env.SERVER_LOG) {
    await m.page.evaluate(async ({ url, action, tree, body }) => { await fetch(url, { method: "POST", headers: { "next-action": action, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", ...(tree ? { "next-router-state-tree": tree } : {}) }, body }); }, { url: actionReq.url, action: actionReq.headers["next-action"], tree: actionReq.headers["next-router-state-tree"], body: actionReq.body.replace(F.rows.qa, F.rows.qe) });
    await m.page.waitForTimeout(1500);
    const log = fs.readFileSync(process.env.SERVER_LOG, "utf8");
    check("an expected refusal (clear on a question with no hold) is written to the server log", /\[ai-importer\] refused: .*no academic-review hold/.test(log), log.split("\n").filter((l) => /ai-importer/.test(l)).slice(-3));
  } else check("refusal logging checked (needs SERVER_LOG and a captured action)", false, { SERVER_LOG: !!process.env.SERVER_LOG, actionReq: !!actionReq });

  console.log("\n=== Full Admin (not Master Admin): no decision, server refuses");
  const f = await login(browser, F.accounts.full);
  check("Full Admin logs in", f.ok, f.page.url());
  await open(f.page, F.rows.qb);
  await shot(f.page, "03-full-admin");
  check("no Clear button for a Full Admin", (await f.page.locator("[data-testid=rv-academic-clear]").count()) === 0);
  check("…the hold is still visible in the status line", /AMBIGUOUS_PENDING_ACADEMIC_REVIEW/.test(await f.page.locator("body").innerText()));
  check("captured the Master Admin's server-action request", !!actionReq?.headers?.["next-action"], actionReq?.headers);
  if (actionReq) {
    const r = await f.page.evaluate(async ({ url, action, tree, body }) => {
      const res = await fetch(url, { method: "POST", headers: { "next-action": action, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component", ...(tree ? { "next-router-state-tree": tree } : {}) }, body });
      return { status: res.status, text: (await res.text()).slice(0, 600) };
    }, { url: actionReq.url, action: actionReq.headers["next-action"], tree: actionReq.headers["next-router-state-tree"], body: actionReq.body.replace(F.rows.qa, F.rows.qb) });
    const s2 = state();
    check("the same action replayed by a Full Admin for QB is refused; QB stays held", s2.rows[F.rows.qb].hold === "AMBIGUOUS_PENDING_ACADEMIC_REVIEW" && s2.cleared === 1 && /do not have permission/.test(r.text), { r, s2 });
  }
  const anon = await (await browser.newContext()).newPage();
  if (actionReq) {
    await anon.goto(`${BASE}/admin/login`);
    await anon.evaluate(async ({ url, action, body }) => { await fetch(url, { method: "POST", headers: { "next-action": action, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" }, body }).catch(() => null); }, { url: actionReq.url, action: actionReq.headers["next-action"], body: actionReq.body.replace(F.rows.qa, F.rows.qb) });
    check("…and without any session; QB stays held", state().rows[F.rows.qb].hold === "AMBIGUOUS_PENDING_ACADEMIC_REVIEW");
  }

  console.log("\n=== Phone (Pixel 7)");
  const p = await login(browser, F.accounts.master, { ...devices["Pixel 7"] });
  await open(p.page, F.rows.qb);
  await shot(p.page, "04-phone");
  check("hold card visible on a phone", await p.page.locator("[data-testid=rv-academic]").isVisible());
  const over = await p.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no horizontal page scroll on a phone", over <= 1, over);
  await browser.close();
}

main()
  .then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.error(e); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });
