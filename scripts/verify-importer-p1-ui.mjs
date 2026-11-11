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
