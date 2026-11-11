/**
 * Admin UI for the per-question practice exclusion — real browser (Chromium; desktop 1366×900 and Pixel 7) against a
 * LOCAL production build on a DISPOSABLE database (fixture: scripts/practice-exclusion-ui-fixture.ts). Every result is
 * checked in the database, not only on screen:
 *   form checkbox set / removed, reason saved and edited · Question Bank badge · Practice filter · bulk exclude /
 *   include with an audit-log row each · teacher: no admin controls, a crafted form field and the admin API are refused ·
 *   question / answer / image / student-attempt data unchanged · practice-picker counts follow every change.
 *
 *   BASE=http://localhost:<p> FIXTURE=<fx.json> DATABASE_URL=<scratch mts_*> SHOTS=<dir> NODE_PATH=<playwright dir> \
 *     node scripts/verify-practice-exclusion-ui.mjs
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
const state = () => JSON.parse(execFileSync("npx", ["tsx", "scripts/practice-exclusion-ui-fixture.ts", "state", process.env.FIXTURE], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }).trim().split("\n").pop());
const Q = F.questions.map((q) => q.id);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {}); };

async function adminLogin(browser, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", F.accounts.master.username);
  await page.fill("input[name=password]", F.accounts.master.password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }).catch(() => null), page.locator("form button[type=submit]").click()]);
  return { ctx, page, ok: !page.url().includes("/admin/login") };
}
async function saveForm(page) {
  await Promise.all([page.waitForURL((u) => !/\/add\?id=/.test(String(u)) || true, { timeout: 30000 }).catch(() => null), page.getByRole("button", { name: /Save Changes/ }).first().click()]);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
}
async function openForm(page, id) {
  await page.goto(`${BASE}/admin/questions/add?id=${id}`);
  await page.locator("[data-testid=exclude-from-practice]").waitFor({ timeout: 20000 });
}
const checked = async (page) => (await page.locator("[data-testid=exclude-from-practice]").getAttribute("data-state")) === "checked";
async function openList(page) {
  await page.goto(`${BASE}/admin/questions`);
  await page.locator("[data-testid=question-row]").first().waitFor({ timeout: 30000 });
}
const row = (page, id) => page.locator(`[data-testid=question-row][data-question-id="${id}"]`);
async function bulk(page, ids, action) {
  for (const id of ids) await row(page, id).locator("[data-testid=select-question]").click();
  await page.locator("[data-testid=bulk-action]").selectOption(action);
  page.once("dialog", (d) => d.accept());
  await page.locator("[data-testid=bulk-apply]").click();
  await page.getByText(/(Excluded|Included) \d+ question\(s\)/).first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
}
async function filterPractice(page, value) {
  await page.getByLabel("Practice", { exact: true }).selectOption(value);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(800);
  return page.locator("[data-testid=question-row]").evaluateAll((rs) => rs.map((r) => r.getAttribute("data-question-id")));
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const s0 = state();
console.log(`fixture: ${Q.length} published + 1 teacher draft; pool ${s0.counts.pool}; attempt questions ${s0.fingerprint.attemptQuestions}`);
check("start: nothing excluded, pool = 8, no bulk audit rows", Object.values(s0.flags).every((f) => !f.excluded) && s0.counts.pool === 8 && s0.audit.length === 0, s0.counts);

const browser = await chromium.launch();
try {
  for (const device of [{ name: "desktop", opts: { viewport: { width: 1366, height: 900 } }, form: 0, bulkSet: [1, 2], bulkClear: [1] }, { name: "phone", opts: { ...devices["Pixel 7"] }, form: 4, bulkSet: [5, 6], bulkClear: [6] }]) {
    console.log(`\n--- ${device.name}: Master Admin ---`);
    const A = await adminLogin(browser, device.opts);
    check(`${device.name}: Master Admin signs in`, A.ok, A.page.url());
    const page = A.page;
    const qid = Q[device.form];
    const before = state();

    // Form: set, reason, edit reason, remove.
    await openForm(page, qid);
    check(`${device.name}: form shows the checkbox, unchecked, with its explanation`, !(await checked(page)) && (await page.getByText("Exclude from automatic practice").isVisible()));
    await page.locator("[data-testid=exclude-from-practice]").click();
    await page.locator("input[name=excludeFromPracticeReason]").fill("Historical current affairs (FSO 2019)");
    await shot(page, `${device.name}-form-set`);
    await saveForm(page);
    let s = state();
    check(`${device.name}: saving with the box ticked sets the flag and the reason`, s.flags[qid].excluded && s.flags[qid].reason === "Historical current affairs (FSO 2019)", s.flags[qid]);
    check(`${device.name}: picker counts drop by one (pool ${before.counts.pool} → ${s.counts.pool}, subject overview ${s.counts.subjectOverview})`, s.counts.pool === before.counts.pool - 1 && s.counts.subjectOverview === before.counts.pool - 1, s.counts);
    await openForm(page, qid);
    check(`${device.name}: reopened form shows the box ticked and the saved reason`, (await checked(page)) && (await page.locator("input[name=excludeFromPracticeReason]").inputValue()) === "Historical current affairs (FSO 2019)");
    await page.locator("input[name=excludeFromPracticeReason]").fill("Edited: dated figure (FSO 2019 paper)");
    await saveForm(page);
    s = state();
    check(`${device.name}: edited reason saved, flag kept`, s.flags[qid].excluded && s.flags[qid].reason === "Edited: dated figure (FSO 2019 paper)", s.flags[qid]);
    await openForm(page, qid);
    await page.locator("[data-testid=exclude-from-practice]").click();
    check(`${device.name}: unticking hides the reason field`, (await page.locator("input[name=excludeFromPracticeReason]").count()) === 0);
    await saveForm(page);
    s = state();
    check(`${device.name}: saving unticked removes the flag and clears the reason`, !s.flags[qid].excluded && s.flags[qid].reason === null, s.flags[qid]);
    check(`${device.name}: picker counts back to ${before.counts.pool}`, s.counts.pool === before.counts.pool && s.counts.subjectOverview === before.counts.pool, s.counts);

    // List: bulk exclude → badges, audit, filter; bulk include → audit.
    await openList(page);
    const auditBefore = state().audit.length;
    const setIds = device.bulkSet.map((i) => Q[i]);
    await bulk(page, setIds, "SET_EXCLUDE_FROM_PRACTICE");
    s = state();
    check(`${device.name}: bulk "Exclude from practice" flags exactly the 2 selected`, setIds.every((id) => s.flags[id].excluded) && Object.entries(s.flags).filter(([, f]) => f.excluded).length === setIds.length + (device.name === "phone" ? 1 : 0), Object.entries(s.flags).filter(([, f]) => f.excluded).map(([id]) => id));
    const a1 = s.audit[s.audit.length - 1];
    check(`${device.name}: one audit row for the bulk exclude (actor, ids, excluded=true)`, s.audit.length === auditBefore + 1 && a1.actorId === F.accounts.master.id && a1.metadata.excludeFromPractice === true && JSON.stringify([...a1.metadata.ids].sort()) === JSON.stringify([...setIds].sort()) && a1.metadata.count === 2, a1);
    await openList(page);
    check(`${device.name}: "Practice excluded" badge on the excluded rows only`, (await Promise.all(setIds.map((id) => row(page, id).locator("[data-testid=badge-practice-excluded]").isVisible()))).every(Boolean) && (await row(page, Q[3]).locator("[data-testid=badge-practice-excluded]").count()) === 0);
    await shot(page, `${device.name}-list-badges`);
    const excludedNow = Object.entries(state().flags).filter(([, f]) => f.excluded).map(([id]) => id).sort();
    const onlyExcluded = (await filterPractice(page, "true")).filter((id) => Q.includes(id)).sort();
    check(`${device.name}: filter "Excluded from practice" lists exactly the excluded fixture questions`, JSON.stringify(onlyExcluded) === JSON.stringify(excludedNow), { onlyExcluded, excludedNow });
    await shot(page, `${device.name}-filter-excluded`);
    const onlyIn = (await filterPractice(page, "false")).filter((id) => Q.includes(id));
    check(`${device.name}: filter "In practice" lists none of them`, onlyIn.length === Q.length - excludedNow.length && onlyIn.every((id) => !excludedNow.includes(id)), { onlyIn: onlyIn.length });
    if (device.name === "phone") check("phone: the Question Bank page itself does not scroll sideways", await noHScroll(page));
    await openList(page);
    const clearIds = device.bulkClear.map((i) => Q[i]);
    await bulk(page, clearIds, "CLEAR_EXCLUDE_FROM_PRACTICE");
    s = state();
    const a2 = s.audit[s.audit.length - 1];
    check(`${device.name}: bulk "Include in practice" clears exactly the selected (flag + reason)`, clearIds.every((id) => !s.flags[id].excluded && s.flags[id].reason === null), clearIds.map((id) => s.flags[id]));
    check(`${device.name}: one audit row for the bulk include (excluded=false)`, s.audit.length === auditBefore + 2 && a2.metadata.excludeFromPractice === false && JSON.stringify(a2.metadata.ids) === JSON.stringify(clearIds), a2);
    const stillOut = Object.values(s.flags).filter((f) => f.excluded).length;
    check(`${device.name}: picker counts follow the bulk changes (pool = 8 − ${stillOut} excluded = ${s.counts.pool})`, s.counts.pool === 8 - stillOut && s.counts.subjectOverview === 8 - stillOut, s.counts);
    await A.ctx.close();
  }

  console.log("\n--- Teacher (admin-only controls) ---");
  const tctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const tp = await tctx.newPage();
  await tp.goto(`${BASE}/teacher`);
  await tp.getByRole("tab", { name: "Username & Password" }).click();
  await tp.fill("#teacher-username", F.accounts.teacher.username);
  await tp.fill("#teacher-password", F.accounts.teacher.password);
  await tp.getByRole("button", { name: "Login" }).click();
  await tp.getByText("Welcome,").first().waitFor({ timeout: 30000 }).catch(() => {});
  check("teacher signs in to the Teacher Portal", await tp.getByText("Welcome,").first().isVisible().catch(() => false));
  await tp.goto(`${BASE}/admin/questions`);
  await tp.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  check("teacher cannot open the admin Question Bank (no bulk / practice controls)", !/\/admin\/questions/.test(tp.url()) || (await tp.locator("[data-testid=bulk-action]").count()) === 0, tp.url());
  await tp.goto(`${BASE}/teacher/questions/${F.draftId}/edit`);
  await tp.locator("form").first().waitFor({ timeout: 20000 });
  check("teacher's question form has no practice-exclusion control", (await tp.locator("[data-testid=exclude-from-practice]").count()) === 0 && (await tp.getByText("Exclude from automatic practice").count()) === 0);
  const auditT = state().audit.length;
  // The question form is the one that owns "Save Draft" (the page has another form in its header).
  const editedText = `PXUI teacher draft edited ${Date.now()}`;
  await tp.fill("#text", editedText);
  const injected = await tp.getByRole("button", { name: "Save Draft" }).evaluate((btn) => {
    const form = btn.closest("form");
    for (const [n, v] of [["excludeFromPractice", "on"], ["excludeFromPracticeReason", "teacher tried"]]) {
      const i = document.createElement("input");
      i.type = "hidden"; i.name = n; i.value = v; form.appendChild(i);
    }
    return form.querySelectorAll("input[name=excludeFromPractice]").length;
  });
  await tp.getByRole("button", { name: "Save Draft" }).click();
  await tp.waitForURL(/ok=draft/, { timeout: 30000 }).catch(() => {});
  let s = state();
  check("teacher's save really ran (draft text updated) with the crafted practice fields inside its form", injected === 1 && s.draftText === editedText, { injected, draftText: s.draftText, url: tp.url() });
  check("…and the crafted practice field was ignored server-side (flag and reason unchanged)", !s.flags[F.draftId].excluded && s.flags[F.draftId].reason === null, s.flags[F.draftId]);
  const api = await tp.request.post(`${BASE}/api/admin/questions/bulk-actions`, { data: { action: "SET_EXCLUDE_FROM_PRACTICE", ids: [Q[3]], excludeFromPractice: true } });
  s = state();
  check(`teacher's direct call to the admin bulk API is refused (HTTP ${api.status()}) and changes nothing`, [401, 403].includes(api.status()) && !s.flags[Q[3]].excluded && s.audit.length === auditT, api.status());
  const list = await tp.request.get(`${BASE}/api/admin/questions?excludeFromPractice=true`, { maxRedirects: 0 });
  check(`teacher cannot list questions by practice flag through the admin API (HTTP ${list.status()})`, list.status() !== 200, list.status());
  await tctx.close();
} finally {
  await browser.close();
}

const end = state();
check("question text, options, correct answers and images unchanged by every flag change", end.fingerprint.content === s0.fingerprint.content, [s0.fingerprint.content, end.fingerprint.content]);
check("the student attempt started before (snapshots + answers) unchanged", end.fingerprint.attempt === s0.fingerprint.attempt && end.fingerprint.attemptQuestions === s0.fingerprint.attemptQuestions);
check("every bulk operation has its audit row (4 bulk operations → 4 rows)", end.audit.length === 4, end.audit.length);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
