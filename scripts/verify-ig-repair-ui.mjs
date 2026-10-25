/**
 * Instagram Studio repair — browser checks on a SCRATCH server (never
 * production): Checks tab categories, Fix This Error, Master Fix (preview →
 * Apply), revision conflicts, printed question number, Generate with AI
 * (Accept / Reject / Retry), provider failure + retry, medical review, the
 * export guard, both design modes and the phone layout. Claude is a LOCAL
 * mock (scripts/mock-anthropic.mjs); no Instagram token is installed.
 *
 *   set -a; . <secret-free env, *igstudio* scratch DB>; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-studio-fixture.ts setup
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-repair-fixture.ts setup
 *   node scripts/mock-anthropic.mjs 3652 &
 *   ANTHROPIC_TEST_BASE_URL=http://127.0.0.1:3652 NEXTAUTH_URL=http://localhost:3651 AUTH_URL=http://localhost:3651 \
 *     node_modules/.bin/next start -H 127.0.0.1 -p 3651 &
 *   BASE=http://localhost:3651 SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-ig-repair-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3651";
const SHOTS = process.env.SHOTS ?? "/tmp/ig-repair-shots";
const PASSWORD = "IgStudio#Fixture2026";
const CODE = "IGFIX-REPAIR-UI";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();
const fixture = (...args) => execFileSync("npx", ["tsx", "scripts/ig-repair-fixture.ts", ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } });

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 500)}` : ""}`);
  if (ok) passes++;
  else failures++;
}

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
const editor = (page) => page.getByTestId("carousel-editor");
async function waitPreview(page, expectCounter) {
  if (expectCounter) await page.getByTestId("slide-counter").filter({ hasText: expectCounter }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await page.waitForFunction(() => {
    const frame = document.querySelector('[data-testid="preview-frame"]');
    const img = document.querySelector('[data-testid="slide-preview"]');
    return frame && frame.getAttribute("data-busy") === "false" && img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 30000 });
}
async function editorMessage(page, re) {
  const m = page.getByTestId("editor-message");
  await m.waitFor({ timeout: 60000 });
  if (re) await page.waitForFunction((r) => new RegExp(r).test(document.querySelector('[data-testid="editor-message"]')?.textContent ?? ""), re.source, { timeout: 60000 });
  return (await m.innerText()).trim();
}
async function approveCost(page) {
  const sel = '[data-testid="cost-preview-generate"]';
  await page.locator(sel).first().waitFor({ timeout: 30000 });
  await page.waitForFunction((s) => { const b = document.querySelector(s); return b && !b.disabled; }, sel, { timeout: 30000 });
  await page.locator(sel).first().click();
}
const issue = (page, code) => page.locator(`[data-testid="issue-list"] [data-code="${code}"]`);
const codesIn = (page, cat) => page.locator(`[data-testid="issues-${cat}"] [data-code]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-code")));
async function openEditor(page) {
  const exam = sql(`SELECT id FROM "Exam" WHERE code = 'IGFIX-RUHS'`);
  const paper = sql(`SELECT "previousYearPaperId" FROM "Question" WHERE code = '${CODE}'`);
  await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${paper}`);
  await page.locator(`[data-row="${CODE}"] [data-testid="open-question"]`).click();
  await editor(page).waitFor();
  await waitPreview(page, "/ 6");
}
const post = () => JSON.parse(sql(`SELECT json_build_object('rev', revision, 'content', content, 'design', design, 'qn', "questionNumber", 'qv', "questionNumberVerified") FROM "InstagramPost" WHERE "questionCode" = '${CODE}'`));
const question = () => JSON.parse(sql(`SELECT json_build_object('difficulty', difficulty, 'rr', "reviewRequired", 'reason', "reviewReason", 'text', text, 'key', (SELECT label FROM "QuestionOption" WHERE "questionId" = q.id AND "isCorrect")) FROM "Question" q WHERE code = '${CODE}'`));

sql(`DELETE FROM "LoginAttempt"; DELETE FROM "AiCostQuote";`);
// Question Bank fingerprint: questions (incl. difficulty, review flags, taxonomy, PYQ mapping, explanation), options, papers.
const qbFingerprint = () =>
  sql(`SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) FROM (
         SELECT q.id || q.code || q.text || q.status || q.difficulty || q."reviewRequired" || coalesce(q."reviewReason", '') || q."subjectId" || coalesce(q."topicId", '') || coalesce(q."previousYearPaperId", '') || coalesce(q.explanation, '') || q."updatedAt" AS x FROM "Question" q
         UNION ALL SELECT o.id || o."questionId" || o.text || o."isCorrect" || o.label || o."order" FROM "QuestionOption" o
         UNION ALL SELECT p.id || p.title || p.year FROM "PreviousYearPaper" p) t`);
const qbBefore = qbFingerprint();
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  await login(page, "igmaster");

  console.log("\n--- 1. Reopen the draft, screenshot problems classified ---");
  await openEditor(page);
  check("existing draft reopened (no Create panel)", (await page.getByTestId("create-draft-panel").count()) === 0);
  await page.getByTestId("tab-checks").click();
  await page.getByTestId("checks-status").waitFor();
  const auto = await codesIn(page, "auto");
  const admin = await codesIn(page, "admin");
  const medical = await codesIn(page, "medical");
  check("A — automatic: Quick Revision glyph, missing hook", ["GLYPHS:Quick Revision", "SLIDE_MISSING:0"].every((c) => auto.includes(c)), auto);
  check("legacy difficulty is reported only (no Fix button; Question Bank not changed here)", admin.includes("QB_DIFFICULTY_LEGACY") && !auto.includes("QB_DIFFICULTY_LEGACY") && (await issue(page, "QB_DIFFICULTY_LEGACY").getByTestId("fix-this").count()) === 0 && /does not edit the Question Bank/.test(await issue(page, "QB_DIFFICULTY_LEGACY").innerText()));
  check("U+2011 in Explanation is no longer an error (drawn as '-')", (await issue(page, "GLYPHS:Explanation").count()) === 0);
  check("B — your input: printed question number (optional)", admin.includes("QUESTION_NUMBER_MISSING") && /Optional/.test(await issue(page, "QUESTION_NUMBER_MISSING").innerText()), admin);
  check("C — medical review: AI content + the MRI note", medical.includes("AI_CONTENT") && medical.includes("AI_FLAG:0"), medical);
  check("status line counts blocking issues and offers Master Fix", /blocking issue/.test(await page.getByTestId("checks-status").innerText()) && /Master Fix/.test(await page.getByTestId("checks-status").innerText()));
  check("blocking / warning badges shown per item", /Blocking/.test(await issue(page, "GLYPHS:Quick Revision").innerText()) && /Warning/.test(await issue(page, "AI_FLAG:0").innerText()));
  check("passed checks listed", /Passed checks \(\d+\)/.test(await page.getByTestId("passed-checks").innerText()));
  await page.screenshot({ path: `${SHOTS}/01-checks-before.png`, fullPage: true });

  console.log("\n--- 2. Export guard (no □ in exported images) ---");
  const postId = sql(`SELECT id FROM "InstagramPost" WHERE "questionCode" = '${CODE}'`);
  const dl = await page.evaluate(async ([b, id]) => { const r = await fetch(`${b}/api/admin/instagram/slide?postId=${id}&i=4&download=1`); return [r.status, (await r.json().catch(() => ({}))).error ?? ""]; }, [BASE, postId]);
  check("slide download refuses while an undrawable character remains (409)", dl[0] === 409 && /unsupported characters/.test(dl[1]), dl);

  console.log("\n--- 3. Fix This Error (single issue): preview → Cancel → Apply ---");
  const q0 = question();
  await issue(page, "SLIDE_MISSING:0").getByTestId("fix-this").click();
  await page.getByTestId("fix-preview").waitFor();
  const prevText = await page.getByTestId("fix-preview").innerText();
  check("preview shows the exact change (first AI hook) before anything is saved", /Hook/.test(prevText) && /Can You Identify the Best Scan/.test(prevText) && !/Question Bank/.test(prevText), prevText);
  check("only the one issue is in this preview", (await page.getByTestId("fix-change").count()) === 1);
  await page.getByTestId("cancel-fixes").click();
  check("Cancel → nothing changed", post().rev === 2 && post().content.hookText === "");
  await issue(page, "SLIDE_MISSING:0").getByTestId("fix-this").click();
  await page.getByTestId("apply-fixes").click();
  await page.getByTestId("fix-result").waitFor({ timeout: 60000 });
  const q1 = question();
  check("Apply → hook saved in the post; Question Bank row identical (difficulty, review flag, text, answer key)", post().content.hookText === "Can You Identify the Best Scan for Acute Osteomyelitis?" && JSON.stringify(q1) === JSON.stringify(q0) && q1.difficulty === "MEDIUM" && q1.rr === true, q1);
  check("the hook issue is gone; the others are still there", (await issue(page, "SLIDE_MISSING:0").count()) === 0 && (await issue(page, "GLYPHS:Quick Revision").count()) === 1 && (await issue(page, "QB_DIFFICULTY_LEGACY").count()) === 1);

  console.log("\n--- 4. Revision conflict: another tab edits after the preview ---");
  await page.getByTestId("master-fix").click();
  await page.getByTestId("fix-preview").waitFor();
  const page2 = await ctx.newPage();
  await openEditor(page2);
  await page2.getByTestId("field-trick").fill("MRI = Marrow Inflammation Revealed (edited in tab 2)");
  await page2.getByTestId("save-draft").click();
  await editorMessage(page2, /Saved/);
  const revAfterTab2 = post().rev;
  await page.getByTestId("apply-fixes").click();
  await page.getByTestId("checks-error").waitFor({ timeout: 30000 });
  check("Apply refuses with a clear message; nothing changed", /changed in another window/.test(await page.getByTestId("checks-error").innerText()) && post().rev === revAfterTab2);
  await page2.close();

  console.log("\n--- 5. Master Fix after reloading ---");
  await editor(page).getByRole("button", { name: "Close" }).first().click();
  await openEditor(page);
  await page.getByTestId("tab-checks").click();
  await page.getByTestId("master-fix").click();
  await page.getByTestId("fix-preview").waitFor();
  const mf = await page.getByTestId("fix-preview").innerText();
  check("Master Fix groups changes by root cause and shows before → after counts", /Unsupported characters/i.test(mf) && !/Question Bank/.test(mf) && /Before: \d+ blocking/.test(mf), mf);
  await page.screenshot({ path: `${SHOTS}/02-master-fix-preview.png`, fullPage: true });
  await page.getByTestId("apply-fixes").click();
  await page.getByTestId("fix-result").waitFor({ timeout: 60000 });
  const res = await page.getByTestId("fix-result").innerText();
  const p1 = post();
  check("result summary: before/after + re-rendered slides at 1080×1350", /now: 0 blocking/.test(res) && /Re-rendered slide/.test(res) && /1080×1350/.test(res), res);
  check("saved: Ca²⁺ → Ca2+, X‑ray → X-ray, first hook selected; tab-2 edit kept", p1.content.quickRevision[1] === "Serum Ca2+ is normal" && !/‑/.test(JSON.stringify(p1.content)) && p1.content.hookText === "Can You Identify the Best Scan for Acute Osteomyelitis?" && /edited in tab 2/.test(p1.content.memoryTrick), p1.content);
  check("medical-review items are NOT resolved by Master Fix", (await issue(page, "AI_CONTENT").count()) === 1 && (await issue(page, "AI_FLAG:0").count()) === 1);
  check("Master Fix disabled when nothing is left to fix automatically", await page.getByTestId("master-fix").isDisabled());
  await page.screenshot({ path: `${SHOTS}/03-after-master-fix.png`, fullPage: true });

  console.log("\n--- 6. Rendering: Handwritten + Professional ---");
  await page.getByRole("tab", { name: /5\. / }).click();
  await waitPreview(page, "5 / 6");
  await editor(page).getByTestId("preview-frame").screenshot({ path: `${SHOTS}/04-handwritten-pearl-revision.png` });
  const dl2 = await page.evaluate(async ([b, id]) => { const r = await fetch(`${b}/api/admin/instagram/slide?postId=${id}&i=4&download=1`); const bmp = await createImageBitmap(await r.blob()); return [r.status, bmp.width, bmp.height]; }, [BASE, postId]);
  check("download now works: JPEG 1080 × 1350", dl2[0] === 200 && dl2[1] === 1080 && dl2[2] === 1350, dl2);
  await page.getByTestId("tab-design").click();
  await page.getByTestId("design-template").selectOption("navy-premium");
  await waitPreview(page, "5 / 6");
  await editor(page).getByTestId("preview-frame").screenshot({ path: `${SHOTS}/05-professional-pearl-revision.png` });
  await page.getByTestId("save-draft").click();
  await editorMessage(page, /Saved/);

  console.log("\n--- 7. Printed question number (admin input) ---");
  await page.getByTestId("tab-checks").click();
  await issue(page, "QUESTION_NUMBER_MISSING").getByTestId("q-number").fill("70");
  await issue(page, "QUESTION_NUMBER_MISSING").getByTestId("q-verified").check();
  await issue(page, "QUESTION_NUMBER_MISSING").getByTestId("q-save").click();
  await editorMessage(page, /Question number saved/);
  check("number saved as verified; the warning is gone", post().qn === 70 && post().qv === true && (await issue(page, "QUESTION_NUMBER_MISSING").count()) === 0);
  check("status: no blocking issues; medical review still required (the Question Bank warning stays as information)", /^No blocking issues\..*medical review is still required\.$/.test((await page.getByTestId("checks-status").innerText()).trim()), await page.getByTestId("checks-status").innerText());

  console.log("\n--- 8. Generate with AI: Reject, Retry, Accept ---");
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-provider").selectOption("anthropic");
  await page.getByTestId("tab-checks").click();
  const before = post();
  await page.getByTestId("section-ai-pick").selectOption("explanation");
  await page.getByTestId("section-ai-generate").click();
  await approveCost(page);
  await page.getByTestId("ai-proposal").waitFor({ timeout: 60000 });
  check("suggestion shows current and suggested text side by side", (await page.getByTestId("proposal-before").innerText()).includes("MRI is the imaging of choice") && /T-type calcium/.test(await page.getByTestId("proposal-after").innerText()));
  check("a suggestion saves nothing", post().rev === before.rev);
  await page.screenshot({ path: `${SHOTS}/06-ai-suggestion.png`, fullPage: true });
  await page.getByTestId("proposal-reject").click();
  check("Reject → suggestion closed, content unchanged", (await page.getByTestId("ai-proposal").count()) === 0 && post().content.explanation === before.content.explanation);

  console.log("\n--- 9. Provider failure (D) → safe Retry ---");
  fixture("key", "overload");
  await page.getByTestId("section-ai-generate").click();
  await approveCost(page);
  await page.getByTestId("provider-error").waitFor({ timeout: 60000 });
  check("provider error shown as 'AI provider problem' with Retry; nothing changed", /AI provider problem/.test(await page.getByTestId("provider-error").innerText()) && (await page.getByTestId("provider-retry").count()) === 1 && post().rev === before.rev, await page.getByTestId("provider-error").innerText());
  fixture("key", "valid");
  await page.getByTestId("provider-retry").click();
  await approveCost(page);
  await page.getByTestId("ai-proposal").waitFor({ timeout: 60000 });
  check("Retry → suggestion generated", true);
  await page.getByTestId("proposal-retry").click();
  await approveCost(page);
  await page.getByTestId("ai-proposal").waitFor({ timeout: 60000 });
  await page.getByTestId("proposal-accept").click();
  await editorMessage(page, /accepted/);
  const after = post();
  check("Accept → one new revision; only the explanation changed; answer key / question untouched", after.rev === before.rev + 1 && /T-type calcium/.test(after.content.explanation) && after.content.quickRevision.join() === before.content.quickRevision.join() && question().key === "D" && after.qn === 70, after.content);
  check("accepted AI text is flagged for medical review", (await issue(page, "AI_CONTENT").count()) === 1);
  const revs = sql(`SELECT note FROM "InstagramPostRevision" r JOIN "InstagramPost" p ON p.id = r."postId" WHERE p."questionCode" = '${CODE}' ORDER BY r.revision DESC LIMIT 1`);
  check("revision note records the accepted suggestion (Undo restores the original)", /AI suggestion accepted: explanation/.test(revs), revs);

  console.log("\n--- 10. Medical review (C) ---");
  await page.getByTestId("open-medical-review-main").click();
  await page.getByTestId("medical-review-form").waitFor();
  check("submit disabled until the reviewer attests", await page.getByTestId("review-submit").isDisabled());
  await page.getByTestId("flag-0").getByText("correct in this exam context").click();
  await page.getByTestId("flag-note-0").fill("MRI is the investigation of choice for early acute osteomyelitis; plain radiographs are the initial test.");
  await page.getByTestId("review-attest").check();
  await page.getByTestId("review-submit").click();
  await editorMessage(page, /Medical review recorded/);
  check("review recorded with the reviewer's name; medical warnings resolved", /Medical review recorded by IG Master/.test(await page.getByTestId("medical-review-status").innerText()) && (await issue(page, "AI_CONTENT").count()) === 0 && (await issue(page, "AI_FLAG:0").count()) === 0);
  check("status: no blocking issues, no medical review pending", (await page.getByTestId("checks-status").innerText()).trim() === "No blocking issues. Check the warnings below before publishing.", await page.getByTestId("checks-status").innerText());
  await page.screenshot({ path: `${SHOTS}/07-after-medical-review.png`, fullPage: true });
  // Editing voids the review.
  await page.getByTestId("tab-content").click();
  await page.getByTestId("field-explanation").fill(`${after.content.explanation} Bone scan if MRI is unavailable.`);
  await page.getByTestId("tab-checks").click();
  check("unsaved edits lock fixes and AI (save first)", (await page.getByTestId("checks-dirty").count()) === 1 && (await page.getByTestId("section-ai-generate").isDisabled()));
  await page.getByTestId("save-draft").click();
  await editorMessage(page, /Saved/);
  check("an edit after the review brings the medical warning back", (await issue(page, "AI_CONTENT").count()) === 1 && /no longer applies/.test(await page.getByTestId("medical-review-status").innerText()));

  console.log("\n--- 11. Publishing gate stays active ---");
  check("Publish button still governed by the publishing switch / gate", (await page.getByTestId("publish-open").count()) === 1);

  console.log("\n--- 12. Generate all content asks before replacing written text ---");
  await page.getByTestId("tab-ai").click();
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); void d.dismiss(); });
  const r0 = post().rev;
  await page.getByTestId("ai-generate-all").click();
  await page.waitForTimeout(500);
  check("confirmation shown; dismissing changes nothing", /replaces the current hook/.test(asked) && post().rev === r0, asked);

  console.log("\n--- 13. Phone layout ---");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("tab-checks").click();
  await page.waitForTimeout(300);
  check("Checks tab has no horizontal scroll at 390 px", await page.evaluate(() => { const el = document.querySelector('[data-testid="carousel-editor"]'); return el.scrollWidth <= el.clientWidth + 1; }));
  await page.screenshot({ path: `${SHOTS}/08-phone-checks.png`, fullPage: true });
  console.log("\n--- 14. Question Bank unchanged ---");
  check("Question Bank fingerprint identical after the whole run", qbFingerprint() === qbBefore);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
