/**
 * Importer recovery UI (2026-11-11) — real browser (Chromium; desktop 1366×900 and Pixel 7) against a LOCAL production
 * build on a DISPOSABLE database (fixture: scripts/importer-recovery-ui-fixture.ts; paid AI OFF, so no click can reach
 * an AI provider). Every result is checked in the database, not only on screen:
 *   Review list: View / Edit / Re-scan on every row, "Q3 — Missing / Not Extracted" row with Re-scan (refused with its
 *   reason, nothing created) · question page: suggestion card (Keep current / Use suggestion), language checks card,
 *   structure-image note, re-scan candidate comparison with Hindi rows and explicit Save, placeholder candidate pre-ticked.
 *
 *   BASE=http://localhost:<p> FIXTURE=<fx.json> DATABASE_URL=<scratch mts_*> SHOTS=<dir> NODE_PATH=<playwright dir> \
 *     node scripts/verify-importer-recovery-ui.mjs
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
const state = () => JSON.parse(execFileSync("npx", ["tsx", "scripts/importer-recovery-ui-fixture.ts", "state", process.env.FIXTURE], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } }).trim().split("\n").pop());
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {}); };
const settle = async (page) => { await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(800); };

async function adminLogin(browser, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", F.accounts.master.username);
  await page.fill("input[name=password]", F.accounts.master.password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }).catch(() => null), page.locator("form button[type=submit]").click()]);
  return { ctx, page, ok: !page.url().includes("/admin/login") };
}
const openQuestion = async (page, id) => {
  await page.goto(`${BASE}/admin/ai-importer/questions/${id}`);
  await page.locator("text=Edit question").first().waitFor({ timeout: 30000 });
};

async function main() {
  const browser = await chromium.launch();
  const { page, ok } = await adminLogin(browser, { viewport: { width: 1366, height: 900 } });
  check("master admin logs in (local build, scratch DB)", ok, page.url());
  const s0 = state();

  console.log("\n=== Review list: row actions and missing-question rows");
  await page.goto(`${BASE}/admin/ai-importer/exceptions?job=${F.jobId}&status=all`);
  await page.locator("[data-testid=exceptions-table]").waitFor({ timeout: 30000 });
  await shot(page, "01-review-list");
  const rows = page.locator("[data-testid=exception-row]");
  const n = await rows.count();
  check("5 question rows listed (Q1, Q2, Q4, Q5 and the Q6 placeholder)", n === 5, n);
  let allActions = true;
  for (let i = 0; i < n; i++) {
    const a = rows.nth(i).locator("[data-testid=row-actions]");
    allActions &&= (await a.locator("[data-testid=row-view]").count()) === 1 && (await a.locator("[data-testid=row-edit]").count()) === 1 && (await a.locator("[data-testid=row-rescan]").count()) === 1;
  }
  check("every row has View · Edit · Re-scan", allActions);
  const missing = page.locator("[data-testid=missing-row]");
  check("exactly one placeholder row: Q3 — Missing / Not Extracted, expected on page 1", (await missing.count()) === 1 && (await missing.first().getAttribute("data-number")) === "3" && /Q3 — Missing \/ Not Extracted/.test(await missing.first().innerText()) && /expected on page 1/.test(await missing.first().innerText()), await missing.first().innerText().catch(() => null));
  const order = await page.locator("[data-testid=exception-row] td:nth-child(2), [data-testid=missing-row] td:nth-child(2)").allInnerTexts();
  check("…placed between Q2 and Q4", order.map((x) => x.trim()).join(",").includes("Q2,Q3,Q4"), order);
  await missing.first().locator("[data-testid=missing-rescan]").click();
  await page.getByText(/paid AI is switched off/).first().waitFor({ timeout: 20000 }).catch(() => {});
  check("Re-scan on the missing row is refused with its reason (paid AI off)…", (await page.getByText(/paid AI is switched off/).count()) > 0);
  const s1 = state();
  check("…and nothing was created or queued", s1.count === s0.count && !s1.numbers.includes(3) && s1.rescanRequests === 0 && s1.job === "NEEDS_REVIEW", s1);
  await rows.nth(1).locator("[data-testid=row-rescan]").click();
  await settle(page);
  check("row Re-scan of Q2 is refused with its reason; nothing queued", (await page.getByText(/paid AI is switched off/).count()) > 0 && state().rescanRequests === 0);
  check("Edit opens the question's edit form", (await rows.first().locator("[data-testid=row-edit]").getAttribute("href"))?.endsWith("#edit"));

  console.log("\n=== Question page: suggestion card");
  await openQuestion(page, F.rows.q1);
  await shot(page, "02-q1-cards");
  const sug = page.locator("[data-testid=rv-suggestion]");
  check("Q1 (Pinacol filed under Physics) shows Current: Physics › Mechanics, Suggested: Chemistry › Organic", (await sug.count()) === 1 && /Physics/.test(await page.locator("[data-testid=rv-suggestion-current]").innerText()) && /Chemistry/.test(await page.locator("[data-testid=rv-suggestion-suggested]").innerText()) && /Organic/.test(await page.locator("[data-testid=rv-suggestion-suggested]").innerText()));
  check("…with confidence and evidence", /\d+%/.test(await page.locator("[data-testid=rv-suggestion-suggested]").innerText()) && /pinacol/.test(await page.locator("[data-testid=rv-suggestion-evidence]").innerText()));
  console.log("\n=== Question page: language checks and structure note");
  const lang = page.locator("[data-testid=rv-language-row]");
  const outcomes = await lang.evaluateAll((els) => els.map((e) => e.getAttribute("data-outcome")));
  check("language card: Hindi question text verified, options A–D non-linguistic (structures)", outcomes[0] === "HINDI_VERIFIED" && outcomes.slice(1, 5).every((o) => o === "NON_LINGUISTIC"), outcomes);
  check("…no 'Hindi text needs review' flag on Q1", !(await page.getByText("Hindi text needs review").count()));
  check("structure note: students see the original image, the formula is alt text only", /students see the original cropped image/.test(await page.locator("[data-testid=rv-structure-note]").innerText()));
  await page.locator("[data-testid=rv-suggestion-keep]").click();
  await settle(page);
  const s2 = state();
  check("Keep current → the administrator's decision is recorded; subject unchanged", s2.rows["1"].taxonomySource === "admin" && s2.rows["1"].subjectId === F.subjects.phys && s2.kept === 1, s2.rows["1"]);
  await openQuestion(page, F.rows.q1);
  check("…the suggestion is not shown again", (await page.locator("[data-testid=rv-suggestion]").count()) === 0);
  await openQuestion(page, F.rows.q2);
  await page.locator("[data-testid=rv-suggestion-use]").click();
  await settle(page);
  const s3 = state();
  check("Use suggestion on Q2 → Chemistry › Organic saved (validated edit)", s3.rows["2"].subjectId === F.subjects.chem && s3.rows["2"].topicId === F.topics.organic && s3.rows["2"].taxonomySource === "admin", s3.rows["2"]);

  console.log("\n=== Question page: re-scan candidate comparison and explicit Save");
  await openQuestion(page, F.rows.q4);
  await shot(page, "03-q4-compare");
  const cmp = page.locator("[data-testid=rv-compare]");
  check("Q4: candidate comparison shown, with the Hindi text compared", (await cmp.count()) === 1 && (await page.locator("[data-testid=rv-compare-row][data-field='hi:stem'][data-same=false]").count()) === 1 && /nothing was changed/.test(await cmp.innerText()));
  check("…nothing is ticked by default for an existing question", (await page.locator("[data-testid='rv-take-stem']").isChecked()) === false);
  check("…Q4 is unchanged before Save", state().rows["4"].stem === "Garbled first read of question 4");
  await page.locator("[data-testid='rv-take-stem']").check();
  await page.locator("[data-testid='rv-take-hi:stem']").check();
  check("…the button says Save", /Save 2 ticked field/.test(await page.locator("[data-testid=rv-compare-apply]").innerText()));
  await page.locator("[data-testid=rv-compare-apply]").click();
  await settle(page);
  const s4 = state();
  check("explicit Save takes the ticked English + Hindi text; the first read stays in history", s4.rows["4"].stem === "Correct text of question 4" && s4.rows["4"].hiStem === "प्रश्न 4 का सही पाठ" && s4.rows["4"].dataStem === "Garbled first read of question 4" && s4.rows["4"].versions.includes("RESCAN:APPLIED") && s4.rows["4"].versions.includes("ADMIN_EDIT:"), s4.rows["4"]);
  await openQuestion(page, F.rows.q6);
  check("Q6 placeholder: the candidate's fields are pre-ticked and explained", /missing from the extraction/.test(await page.locator("[data-testid=rv-compare]").innerText()) && (await page.locator("[data-testid='rv-take-stem']").isChecked()));
  await page.locator("[data-testid=rv-compare-apply]").click();
  await settle(page);
  check("…Save fills the placeholder", state().rows["6"].stem === "Question 6 found by the re-scan");

  console.log("\n=== Mobile (Pixel 7)");
  const m = await adminLogin(browser, { ...devices["Pixel 7"] });
  await openQuestion(m.page, F.rows.q1);
  await shot(m.page, "04-mobile-q1");
  check("language card readable on a phone", await m.page.locator("[data-testid=rv-language]").isVisible());
  const over = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("question page has no horizontal page scroll on a phone", over <= 1, over);
  await m.page.goto(`${BASE}/admin/ai-importer/exceptions?job=${F.jobId}&status=all`);
  await m.page.locator("[data-testid=exceptions-table]").waitFor({ timeout: 30000 });
  await shot(m.page, "05-mobile-list");
  check("review list loads on a phone (table scrolls inside its own box)", await m.page.locator("[data-testid=exceptions-table]").isVisible());
  await browser.close();
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    console.log(`\n${pass} passed, ${fail + 1} failed`);
    process.exit(1);
  });
