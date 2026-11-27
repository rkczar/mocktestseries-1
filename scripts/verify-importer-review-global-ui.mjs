/**
 * Browser suite for the global AI Importer review improvements (scratch server + synthetic fixture only):
 * Previous / Next / Save & Next, Student preview, separate verification / answer-key / approval labels, Verify All Answers.
 *   AI_IMPORT_VAULT_DIR=<scratch> … npx tsx scripts/verify-importer-review-global.ts setup /tmp/irg.json
 *   NODE_PATH=<playwright> BASE=http://localhost:3611 ADMIN_USER=… ADMIN_PASS=… node scripts/verify-importer-review-global-ui.mjs /tmp/irg.json
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
// Playwright is not a project dependency: pass its location with NODE_PATH (as the other UI suites do).
const { chromium } = createRequire(import.meta.url)("playwright");

const F = JSON.parse(readFileSync(process.argv[2], "utf8"));
const BASE = process.env.BASE ?? "http://localhost:3611";
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
};
const qUrl = (i) => `${BASE}/admin/ai-importer/questions/${F.ids[i]}`;

const browser = await chromium.launch();
const MOBILE = process.env.MOBILE === "1";
const page = await browser.newPage({ viewport: MOBILE ? { width: 390, height: 844 } : { width: 1400, height: 1000 }, ...(MOBILE ? { isMobile: true, hasTouch: true } : {}) });
console.log(`viewport: ${MOBILE ? "phone 390×844" : "desktop 1400×1000"}`);
const noSideScroll = () => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
const dialogs = [];
let acceptDialog = true;
page.on("dialog", (d) => {
  dialogs.push(d.message());
  (acceptDialog ? d.accept() : d.dismiss()).catch(() => {});
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", process.env.ADMIN_USER);
  await page.fill("input[name=password]", process.env.ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);

  // ---- Q1: labels + student preview ----
  await page.goto(qUrl(0));
  const status = await page.locator("[data-testid=q-status]").textContent();
  const answer = await page.locator("[data-testid=q-answer-status]").textContent();
  const approval = await page.locator("[data-testid=q-approval-status]").textContent();
  check("labels: question verification shown separately ('Checks passed', not 'Ready')", /^Question verification: Checks passed$/.test(status.trim()), status);
  check("labels: answer-key verification shown separately", /^Answer key: /.test(answer.trim()), answer);
  check("labels: admin approval shown separately (Approved)", approval.trim() === "Admin approval: Approved", approval);
  check("labels: approval card titled 'Admin approval'", (await page.getByText("Admin approval", { exact: true }).count()) >= 1);
  const strip = await page.locator("[data-testid=q-status-strip]").textContent();
  check("labels: answer source never a bare 'Verified'", !/Answer: Verified\b/.test(strip), strip);

  const sp = page.locator("[data-testid=student-preview]");
  check("preview: Student preview card above the editor", (await sp.count()) === 1 && (await sp.boundingBox()).y < (await page.locator("[data-testid=question-review] [data-testid=rv-stem]").boundingBox()).y);
  check("preview: stem rendered with the test-player class", (await sp.locator("p.text-question").textContent()).includes("IRG stem 1"));
  check("preview: four options", (await sp.locator("ul > li").count()) === 4);
  // The preview is the test-player view (no answer); the saved answer is behind Answer Key (verification workspace).
  check("preview: no correct-answer mark (student view)", (await sp.getByText("Correct answer").count()) === 0);
  await page.locator("[data-testid=rv-answer-key]").click();
  check("preview: Answer Key shows saved answer A", (await page.locator("[data-testid=answer-key-final]").textContent()).trim() === "A");
  const img = sp.locator("img[src*='/api/admin/ai-importer/figures/']");
  check("preview: stem image present", (await img.count()) === 1);
  if (await img.count()) {
    await img.first().scrollIntoViewIfNeeded();
    await page.waitForFunction((el) => el.complete, await img.first().elementHandle(), { timeout: 10000 }).catch(() => {});
    const w = await img.first().evaluate((el) => el.naturalWidth);
    check("preview: stem image actually loads (400 px wide)", w === 400, w);
    check("preview: image alt from the figure description", (await img.first().getAttribute("alt")) === "IRG blue figure");
  }

  // ---- Verify All Answers (before any edit: saving re-runs the checks, which can apply the official key) ----
  await page.goto(`${BASE}/admin/ai-importer/answers?job=${F.jobId}`);
  check("verify: nothing computed until asked", (await page.locator("[data-testid=verify-answer-rows]").count()) === 0);
  await Promise.all([page.waitForURL(/verify=1/), page.locator("[data-testid=verify-all-answers-run]").click()]);
  const count = async (v) => Number(await page.locator(`[data-testid=verify-answer-counts] [data-verdict=${v}]`).getAttribute("data-count"));
  const counts = { MATCH: await count("MATCH"), MISMATCH: await count("MISMATCH"), UNVERIFIED: await count("UNVERIFIED"), NO_KEY: await count("NO_KEY") };
  check("verify: counts Match 2 / Mismatch 2 / Unverified 4 / No key 1", JSON.stringify(counts) === JSON.stringify({ MATCH: 2, MISMATCH: 2, UNVERIFIED: 4, NO_KEY: 1 }), counts);
  const verdicts = await page.locator("[data-testid=verify-answer-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-verdict")));
  check("verify: one row per question, in paper order", verdicts.join() === "MATCH,MISMATCH,MISMATCH,NO_KEY,UNVERIFIED,UNVERIFIED,UNVERIFIED,MATCH,UNVERIFIED", verdicts);
  const q2 = await page.locator("[data-testid=verify-answer-row]").nth(1).textContent();
  check("verify: mismatch row explains saved vs key", /Saved B; the key says C/.test(q2), q2);
  check("layout: answers page has no horizontal page scroll", await noSideScroll());
  check("verify: question links open the review page", (await page.locator("[data-testid=verify-answer-row] a").first().getAttribute("href")) === `/admin/ai-importer/questions/${F.ids[0]}`);


  await page.goto(qUrl(0));
  // ---- Previous / Next ----
  check("nav: first question has Previous disabled", await page.locator("[data-testid=rv-prev]").first().isDisabled());
  check("nav: Next names Q2", /Next \(Q2\)/.test(await page.locator("[data-testid=rv-next]").first().textContent()));
  await Promise.all([page.waitForURL(qUrl(1)), page.locator("[data-testid=rv-next]").first().click()]);
  check("nav: Next opens Q2 directly", page.url() === qUrl(1));
  await Promise.all([page.waitForURL(qUrl(0)), page.locator("[data-testid=rv-prev]").first().click()]);
  check("nav: Previous returns to Q1", page.url() === qUrl(0));

  // Unsaved edit: leaving asks first; dismiss keeps the edit and the page.
  await page.goto(qUrl(1));
  await page.locator("[data-testid=rv-stem]").fill("IRG stem 2 edited");
  acceptDialog = false;
  dialogs.length = 0;
  await page.locator("[data-testid=rv-next]").first().click();
  await page.waitForTimeout(800);
  check("nav: unsaved edit → confirm asked, dismiss stays on Q2", dialogs.some((m) => /unsaved changes/.test(m)) && page.url() === qUrl(1), { dialogs, url: page.url() });
  check("nav: the edit is still in the form", (await page.locator("[data-testid=rv-stem]").inputValue()) === "IRG stem 2 edited");
  acceptDialog = true;

  // Save & Next on Q2 (saved B, official key C): the re-check sets the answer from the key — shown, and it stays on Q2.
  await page.locator("[data-testid=rv-save-next]").click();
  await page.locator("[data-testid=review-msg]").waitFor({ timeout: 30000 });
  const msg = await page.locator("[data-testid=review-msg]").textContent();
  check("save&next: answer changed by the re-check is shown (B → C)", /changed this question's saved answer from B to C/.test(msg), msg);
  check("save&next: stays on Q2 when the answer changed", page.url() === qUrl(1));
  const shows = (t) => page.locator("[data-testid=student-preview] p.text-question", { hasText: t }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  check("save&next: the edit was saved (student preview shows it)", await shows("IRG stem 2 edited"));

  // Save & Next with no answer change (Q1: saved A = official key A): saves and opens Q2.
  // (Q4 — no key, saved A unconfirmed — is held instead: the re-check clears an unconfirmed answer, and that is shown.)
  await page.goto(qUrl(0));
  await page.locator("[data-testid=rv-stem]").fill("IRG stem 1 edited");
  await Promise.all([page.waitForURL(qUrl(1), { timeout: 30000 }), page.locator("[data-testid=rv-save-next]").click()]);
  check("save&next: unchanged answer → opens the next question (Q2)", page.url() === qUrl(1));
  await page.goto(qUrl(0));
  check("save&next: Q1 edit saved", await shows("IRG stem 1 edited"));
  check("save&next: editing withdrew Q1's approval (shown separately)", (await page.locator("[data-testid=q-approval-status]").textContent()).trim() === "Admin approval: Not approved");
  await page.goto(qUrl(3));
  check("labels: unapproved question shows 'Admin approval: Not approved'", (await page.locator("[data-testid=q-approval-status]").textContent()).trim() === "Admin approval: Not approved");

  // Imported (view-only) last question: navigation still there, no editor, no Save & Next.
  await page.goto(qUrl(F.ids.length - 1));
  check("view-only: imported question has no editor", (await page.locator("[data-testid=rv-stem]").count()) === 0);
  check("view-only: Previous works", !(await page.locator("[data-testid=rv-prev]").first().isDisabled()));
  check("view-only: last question has Next disabled, no Save & Next", (await page.locator("[data-testid=rv-next]").first().isDisabled()) && (await page.locator("[data-testid=rv-save-next]").count()) === 0);
  check("view-only: student preview shown", (await page.locator("[data-testid=student-preview] p.text-question").count()) === 1);
  check("workspace: Word file → no page images message, no viewer", (await page.locator("[data-testid=source-missing]").count()) === 1 && (await page.locator("[data-testid=source-viewer]").count()) === 0);
  check("layout: question page has no horizontal page scroll", await noSideScroll());
  await Promise.all([page.waitForURL(qUrl(F.ids.length - 2)), page.locator("[data-testid=rv-prev]").first().click()]);
  check("view-only: Previous opens Q8", page.url() === qUrl(F.ids.length - 2));

  check("no client-side errors", errors.length === 0, errors);
} catch (e) {
  check("suite ran to the end", false, String(e).slice(0, 400));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
