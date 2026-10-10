/**
 * Instagram Content Studio — browser checks on a SCRATCH server (never production).
 *
 *   set -a; . ./.env; set +a     # DATABASE_URL must be an *igstudio* scratch DB
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/ig-studio-fixture.ts setup
 *   BASE=http://localhost:3131 SHOTS=<dir> NODE_PATH=<dir containing playwright> node scripts/verify-ig-studio-ui.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3131";
const SHOTS = process.env.SHOTS ?? "/tmp/ig-studio-shots";
const PASSWORD = "IgStudio#Fixture2026";
mkdirSync(SHOTS, { recursive: true });
const DB = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/igstudio/.test(DB.split("/").pop() ?? "")) throw new Error("Refusing to run: DATABASE_URL is not an igstudio scratch database.");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();

let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (ok) passes++;
  else failures++;
}

const fingerprint = () =>
  sql(`SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
         SELECT q.id || q.text || q.status || q."reviewRequired" || q."updatedAt" || coalesce(q."previousYearPaperId", '') AS x FROM "Question" q JOIN "Exam" e ON e.id = q."examId" WHERE e.code LIKE 'IGFIX-%'
         UNION ALL SELECT o.id || o.text || o."isCorrect" || o.label FROM "QuestionOption" o JOIN "Question" q ON q.id = o."questionId" JOIN "Exam" e ON e.id = q."examId" WHERE e.code LIKE 'IGFIX-%'
         UNION ALL SELECT a.id || coalesce(a."selectedOptionLabel", '-') || coalesce(a."isCorrect"::text, '-') FROM "Answer" a JOIN "Question" q ON q.id = a."questionId" JOIN "Exam" e ON e.id = q."examId" WHERE e.code LIKE 'IGFIX-%'
         UNION ALL SELECT x.id || x.content::text || x."updatedAt" FROM "AIExplanation" x JOIN "Question" q ON q.id = x."questionId" JOIN "Exam" e ON e.id = q."examId" WHERE e.code LIKE 'IGFIX-%'
         UNION ALL SELECT p.id || p.title || p.year FROM "PreviousYearPaper" p JOIN "Exam" e ON e.id = p."examId" WHERE e.code LIKE 'IGFIX-%') t`);

async function login(page, username) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", PASSWORD);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}

const editor = (page) => page.getByTestId("carousel-editor");
/** Waits until the preview shows the CURRENT slide, fully rendered from the latest editor state. */
async function waitPreview(page, expectCounter) {
  if (expectCounter) await page.getByTestId("slide-counter").filter({ hasText: expectCounter }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(500); // let a pending debounce start
  await page.waitForFunction(() => {
    const frame = document.querySelector('[data-testid="preview-frame"]');
    const img = document.querySelector('[data-testid="slide-preview"]');
    return frame && frame.getAttribute("data-busy") === "false" && img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 30000 });
}
async function editorMessage(page) {
  const m = page.getByTestId("editor-message");
  await m.waitFor({ timeout: 30000 });
  return (await m.innerText()).trim();
}
async function openQuestion(page, code) {
  await page.locator(`[data-row="${code}"] [data-testid="open-question"]`).click();
  await editor(page).waitFor();
}
async function closeEditor(page) {
  await editor(page).getByRole("button", { name: "Close" }).first().click();
  await editor(page).waitFor({ state: "detached" });
}

// Isolated state for this run.
sql(`DELETE FROM "InstagramPost" WHERE "questionCode" LIKE 'IGFIX-%'; DELETE FROM "Setting" WHERE key = 'instagram.studio'; DELETE FROM "LoginAttempt";`);
const before = fingerprint();
const exam = sql(`SELECT id FROM "Exam" WHERE code = 'IGFIX-RUHS'`);
const p2021 = sql(`SELECT id FROM "PreviousYearPaper" WHERE title = 'IGFIX RUHS MO 2021'`);

const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- Authorization
  console.log("\n--- Authorization ---");
  for (const who of ["igfull", "igteacher"]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page, who);
    await page.goto(`${BASE}/admin/instagram`);
    check(`${who}: Instagram page shows Access Restricted`, (await page.getByText("Access Restricted").count()) === 1);
    await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
    check(`${who}: PYQ section restricted too (no question table)`, (await page.getByTestId("question-table").count()) === 0 && (await page.getByText("Access Restricted").count()) === 1);
    const status = await page.evaluate(async (base) => {
      const a = await fetch(`${base}/api/admin/instagram/preview`, { method: "POST", body: JSON.stringify({ postId: "abcdefghijklmnop", index: 0 }) });
      const b = await fetch(`${base}/api/admin/instagram/slide?postId=abcdefghijklmnop&i=0`);
      const c = await fetch(`${base}/api/admin/instagram/template-sample?t=midnight&i=0`);
      return [a.status, b.status, c.status];
    }, BASE);
    check(`${who}: preview / slide / template image routes → 403`, status.every((s) => s === 403), status);
    await ctx.close();
  }
  sql(`DELETE FROM "LoginAttempt"`);

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const serverErrors = [];
  const external = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 200)}`));
  page.on("response", (r) => r.status() >= 500 && serverErrors.push(`${r.status()} ${r.url()}`));
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith(BASE) && !u.startsWith("data:") && !u.startsWith("blob:")) external.push(u);
  });
  page.on("dialog", (d) => d.accept());
  await login(page, "igmaster");

  // ---------------------------------------------------------------- Navigation
  console.log("\n--- Sidebar + sections (MASTER_ADMIN) ---");
  await page.goto(`${BASE}/admin`);
  check("sidebar has an Instagram entry", (await page.locator('nav[aria-label="Admin navigation"] a[href="/admin/instagram"]').count()) >= 1);
  const sections = [
    ["/admin/instagram", "Create Post"],
    ["/admin/instagram/pyq", "PYQ Series"],
    ["/admin/instagram/most-missed", "Most Missed MCQ"],
    ["/admin/instagram/drafts", "Drafts"],
    ["/admin/instagram/history", "Published History"],
    ["/admin/instagram/templates", "Templates & Branding"],
    ["/admin/instagram/settings", "Settings"],
  ];
  for (const [path, label] of sections) {
    const res = await page.goto(`${BASE}${path}`);
    const active = await page.locator('nav[aria-label="Instagram sections"] a[aria-current="page"]').innerText();
    check(`${label} → ${res?.status()}, tab active, publishing-disabled notice`, res?.status() === 200 && active.trim() === label && (await page.getByTestId("publishing-disabled").count()) === 1, { status: res?.status(), active });
  }
  await page.goto(`${BASE}/admin/instagram`);
  await page.screenshot({ path: `${SHOTS}/01-create-post.png`, fullPage: true });

  // ---------------------------------------------------------------- Settings (needed for the Follow slide)
  console.log("\n--- Settings ---");
  await page.goto(`${BASE}/admin/instagram/settings`);
  await page.getByTestId("set-handle").fill("bad handle!");
  await page.getByTestId("settings-save").click();
  check("invalid Instagram handle refused", /letters, numbers/.test(await page.getByTestId("settings-message").innerText()));
  await page.getByTestId("set-handle").fill("mocktestseries.in");
  await page.locator('input[placeholder="https://t.me/…"]').fill("https://t.me/mocktestseries_fixture");
  await page.getByTestId("settings-save").click();
  await page.getByTestId("settings-message").filter({ hasText: "Settings saved." }).waitFor();
  const stored = JSON.parse(sql(`SELECT value FROM "Setting" WHERE key = 'instagram.studio'`));
  check("settings stored (handle + Telegram)", stored.instagramHandle === "mocktestseries.in" && stored.telegramUrl === "https://t.me/mocktestseries_fixture", stored);
  await page.screenshot({ path: `${SHOTS}/02-settings.png`, fullPage: true });

  // ---------------------------------------------------------------- PYQ selector
  console.log("\n--- PYQ selector: Exam → Year → Paper → Question ---");
  await page.goto(`${BASE}/admin/instagram/pyq`);
  await page.getByTestId("exam-list").getByText("IGFIX RUHS MO").click();
  await page.getByTestId("year-list").getByText("2021").waitFor();
  const years = (await page.getByTestId("year-list").locator("a").allInnerTexts()).map((s) => s.trim());
  check("years listed newest first", JSON.stringify(years) === JSON.stringify(["2021", "2019"]), years);
  await page.getByTestId("paper-list").getByText("IGFIX RUHS MO 2021").click();
  await page.getByTestId("question-table").waitFor();
  const codes = await page.locator('[data-testid="question-table"] tbody tr[data-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row")));
  check("paper questions in stored order", codes.join(",") === "IGFIX-RUHS21-W01,IGFIX-RUHS21-W02,IGFIX-RUHS21-W03,IGFIX-RUHS21-W04,IGFIX-RUHS21-W05,IGFIX-RUHS21-W06,IGFIX-RUHS21-W07", codes);
  const row2 = await page.locator('[data-row="IGFIX-RUHS21-W02"]').innerText();
  check("damaged stem flagged 'Check text' + QB review", /Check text/.test(row2) && /QB review required/.test(row2), row2);
  check("image + answer-key questions flagged", /Has image/.test(await page.locator('[data-row="IGFIX-RUHS21-W03"]').innerText()) && /Answer key issue/.test(await page.locator('[data-row="IGFIX-RUHS21-W04"]').innerText()));
  check("every question starts NOT CREATED", (await page.locator('[data-testid="question-table"] [data-status="NOT_CREATED"]').count()) === 7);
  await page.screenshot({ path: `${SHOTS}/03-pyq-selector.png`, fullPage: true });

  // RPSC: two papers in the same year
  await page.goto(`${BASE}/admin/instagram/pyq`);
  await page.getByTestId("exam-list").getByText("IGFIX RPSC MO").click();
  await page.getByTestId("paper-list").getByText("IGFIX RPSC 2024 Paper II").waitFor();
  check("same-year papers listed separately", (await page.getByTestId("paper-list").locator("a").count()) === 2);

  // ---------------------------------------------------------------- Editor
  console.log("\n--- Carousel editor ---");
  await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
  await openQuestion(page, "IGFIX-RUHS21-W01");
  await page.getByTestId("create-draft-panel").waitFor();
  check("no post yet → Create Draft offered", true);
  await page.getByTestId("create-draft").click();
  await waitPreview(page, "1 / 5");
  const dims = await page.getByTestId("slide-preview").evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  check("preview slide is 1080 × 1350", dims[0] === 1080 && dims[1] === 1350, dims);
  check("snapshot shows the stored answer read-only", /Ethosuximide\s+✓/.test(await page.getByTestId("snapshot").innerText()));
  const draftRows = Number(sql(`SELECT count(*) FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`));
  check("one draft row created", draftRows === 1, draftRows);

  await page.getByRole("button", { name: "Next slide" }).click();
  await waitPreview(page, "2 / 5");
  await page.screenshot({ path: `${SHOTS}/04-editor-question-slide.png` });

  // Edit text
  await page.getByTestId("field-hook").fill("Can You Solve This RUHS MO PYQ?");
  await page.getByTestId("field-explanation").fill("Ethosuximide blocks T-type calcium channels in thalamic neurons, which drive the 3 Hz spike-and-wave rhythm of absence seizures.");
  await page.getByTestId("field-trick").fill("ETHO = Empty THOughts: the child stares blankly.");
  await page.getByTestId("field-caption").fill("Can you solve this RUHS MO 2021 PYQ?\nComment your answer and save this post for revision.");
  check("unsaved-changes badge shown", (await editor(page).getByText("Unsaved changes").count()) === 1);
  await page.getByTestId("save-draft").click();
  check("Save Draft → revision 2", /Saved \(revision 2\)/.test(await editorMessage(page)));
  await page.getByRole("tab", { name: /4\. Explanation/ }).click();
  await waitPreview(page, "4 / 5");
  await page.screenshot({ path: `${SHOTS}/05-editor-explanation-slide.png` });

  // Persistence: close and reopen
  await closeEditor(page);
  await page.reload();
  check("table now shows Draft", /Draft/.test(await page.locator('[data-row="IGFIX-RUHS21-W01"]').innerText()));
  await openQuestion(page, "IGFIX-RUHS21-W01");
  await waitPreview(page, "1 / 5");
  check("reopen → existing draft (no Create panel), text persisted", (await page.getByTestId("create-draft-panel").count()) === 0 && (await page.getByTestId("field-hook").inputValue()) === "Can You Solve This RUHS MO PYQ?");

  // Design: template + slide count, then Undo
  await page.getByTestId("tab-design").click();
  await page.getByTestId("design-template").selectOption("academic");
  await page.getByTestId("slides-3").click();
  await waitPreview(page, "1 / 3");
  await page.screenshot({ path: `${SHOTS}/06-editor-design-academic-3.png` });
  await page.getByTestId("save-draft").click();
  check("design saved → revision 3", /revision 3/.test(await editorMessage(page)));
  await page.getByTestId("undo").click();
  check("Undo → back to the 5-slide midnight design", /Undone/.test(await editorMessage(page)));
  await waitPreview(page, "/ 5");
  check("undo restored template", (await page.getByTestId("design-template").inputValue()) === "midnight");

  // AI box: layout instruction in Hindi (no AI call), then a content request without AI keys
  await page.getByTestId("tab-ai").click();
  await page.getByTestId("ai-instruction").fill("question ka font size bada karo");
  await page.getByTestId("ai-apply-instruction").click();
  check("Hindi layout instruction applied without AI", /Question text size increased/.test(await editorMessage(page)));
  const designNow = JSON.parse(sql(`SELECT design FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`));
  check("questionScale saved as 1.1", designNow.questionScale === 1.1, designNow);
  const revBefore = sql(`SELECT revision FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`);
  await page.getByTestId("ai-generate-all").click();
  const aiMsg = await editorMessage(page);
  check("AI generation without a configured provider fails safely (nothing changed)", /not configured|paused|went wrong|AI/i.test(aiMsg) && sql(`SELECT revision FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`) === revBefore, aiMsg);
  await page.screenshot({ path: `${SHOTS}/07-editor-ai-panel.png` });

  // Prefill from the reviewed student AI explanation (no new AI call)
  await page.getByRole("button", { name: "Use existing AI explanation" }).click();
  check("prefill from existing AI explanation", /Copied/.test(await editorMessage(page)));

  // Review: question number, checklist, warnings → Ready
  await page.getByTestId("tab-review").click();
  const issueText = await page.getByTestId("issue-list").innerText();
  check("review lists the missing printed question number + AI content warning", /No printed question number/.test(issueText) && /written by AI/.test(issueText), issueText);
  check("Mark Ready disabled before review", await page.getByTestId("mark-ready").isDisabled());
  await page.getByTestId("q-number").fill("12");
  await page.getByTestId("q-verified").check();
  await page.getByTestId("q-save").click();
  check("question number saved", /Question number saved/.test(await editorMessage(page)));
  for (const cb of await page.locator('[data-testid="issue-list"] input[type=checkbox]').all()) await cb.check();
  for (const key of ["textMatchesPaper", "answerVerified", "attributionVerified", "medicalReviewed"]) await page.getByTestId(`check-${key}`).check();
  check("no Publish button before approval", (await page.getByTestId("publish-open").count()) === 0 && (await page.getByTestId("publish-from-review").count()) === 0);
  await page.getByTestId("mark-ready").click();
  check("Marked Ready", /Marked Ready/.test(await editorMessage(page)));
  check("status READY in DB", sql(`SELECT status FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`) === "READY");
  await page.screenshot({ path: `${SHOTS}/08-editor-ready.png` });

  // Final JPEG download of the saved post
  const postId = sql(`SELECT id FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`);
  const dl = await page.evaluate(async ([base, id]) => {
    const r = await fetch(`${base}/api/admin/instagram/slide?postId=${id}&i=1&download=1`);
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob);
    return [r.status, r.headers.get("content-type"), r.headers.get("content-disposition"), bmp.width, bmp.height];
  }, [BASE, postId]);
  check("download: JPEG attachment 1080 × 1350", dl[0] === 200 && dl[1] === "image/jpeg" && /attachment/.test(dl[2]) && dl[3] === 1080 && dl[4] === 1350, dl);

  // Editing a Ready post asks first and sends it back to Draft
  await page.getByTestId("tab-content").click();
  await page.getByTestId("field-trick").fill("ETHO = Empty THOughts.");
  await page.getByTestId("save-draft").click();
  await page.getByTestId("confirm-back-to-draft").waitFor();
  check("editing a Ready post asks for confirmation", sql(`SELECT status FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`) === "READY");
  await page.getByTestId("confirm-back-to-draft").click();
  await editor(page).getByText("Saved (revision").waitFor();
  check("confirmed edit → back to Draft", sql(`SELECT status FROM "InstagramPost" WHERE "questionCode" = 'IGFIX-RUHS21-W01'`) === "DRAFT");
  await page.getByTestId("tab-history").click();
  const revs = await page.getByTestId("revision-list").innerText();
  check("history lists every revision with notes", /Draft created/.test(revs) && /Layout:/.test(revs) && /Question number set to 12/.test(revs), revs.slice(0, 300));
  await closeEditor(page);

  // ---------------------------------------------------------------- Duplicate protection (simulated published post)
  console.log("\n--- Posted questions ---");
  sql(`UPDATE "InstagramPost" SET status = 'PUBLISHED', "publishedAt" = now(), "igPermalink" = 'https://www.instagram.com/p/fixture/' WHERE "questionCode" = 'IGFIX-RUHS21-W01'`);
  await page.reload();
  check("table shows 'Instagram ✓ Posted'", /Instagram ✓ Posted/.test(await page.locator('[data-row="IGFIX-RUHS21-W01"]').innerText()));
  await openQuestion(page, "IGFIX-RUHS21-W01");
  await page.getByTestId("readonly-note").waitFor();
  check("published post is read-only in the editor", (await page.getByTestId("save-draft").isDisabled()) && (await page.getByTestId("field-hook").isDisabled()));
  await page.getByTestId("tab-history").click();
  await page.getByTestId("new-version").click();
  check("Create New Version asks for confirmation first", (await page.getByTestId("confirm-new-version").count()) === 1);
  await page.getByTestId("confirm-new-version").click();
  check("version 2 created as Draft", /Version 2 created/.test(await editorMessage(page)));
  await page.screenshot({ path: `${SHOTS}/09-editor-new-version.png` });
  await closeEditor(page);
  await page.reload();
  const r1 = await page.locator('[data-row="IGFIX-RUHS21-W01"]').innerText();
  check("table shows Posted + new version Draft", /Instagram ✓ Posted/.test(r1) && /New version: Draft/.test(r1), r1);
  await page.goto(`${BASE}/admin/instagram/history`);
  check("Published History lists the posted v1", /IGFIX-RUHS21-W01 · v1/.test(await page.getByTestId("published-table").innerText()));
  await page.screenshot({ path: `${SHOTS}/10-published-history.png`, fullPage: true });

  // ---------------------------------------------------------------- Quality gate blocks damaged questions
  console.log("\n--- Quality gate on damaged questions ---");
  await page.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
  await openQuestion(page, "IGFIX-RUHS21-W07");
  await page.getByTestId("create-draft").click();
  await waitPreview(page, "1 / 5");
  await page.getByTestId("tab-review").click();
  const gate = await page.getByTestId("issue-list").innerText();
  check("undrawable '⁺' blocks Ready and says to fix it in the Question Bank", /can't draw/.test(gate) && /Question Bank/.test(gate), gate);
  await page.getByRole("tab", { name: /2\. Question/ }).click();
  await waitPreview(page, "2 / 5");
  await page.screenshot({ path: `${SHOTS}/11-gate-glyph.png` });
  await closeEditor(page);
  await openQuestion(page, "IGFIX-RUHS21-W02");
  await page.getByTestId("create-draft").click();
  await waitPreview(page, "1 / 5");
  await page.getByTestId("tab-review").click();
  check("truncated PYQ stem reported (never auto-corrected)", /may be cut off/.test(await page.getByTestId("issue-list").innerText()));
  check("snapshot keeps the original damaged text", /ll are types of RCT except/.test(await page.getByTestId("snapshot").innerText()));
  await page.screenshot({ path: `${SHOTS}/12-gate-truncated.png` });
  await closeEditor(page);

  // ---------------------------------------------------------------- Most Missed
  console.log("\n--- Most Missed MCQ ---");
  await page.goto(`${BASE}/admin/instagram/most-missed?range=yesterday&examId=${exam}&min=5`);
  const mmRows = await page.locator('[data-testid="mm-table"] tbody tr[data-row]').evaluateAll((rows) => rows.map((r) => [r.getAttribute("data-row"), ...[...r.querySelectorAll("td")].slice(3, 6).map((td) => td.textContent.trim())]));
  check(
    "yesterday (IST): ranked by wrong count with real counts",
    JSON.stringify(mmRows) === JSON.stringify([["IGFIX-RUHS19-W01", "10", "7", "70.0%"], ["IGFIX-QB-0001", "10", "6", "60.0%"], ["IGFIX-RUHS21-W01", "6", "5", "83.3%"], ["IGFIX-RUHS19-W02", "10", "4", "40.0%"]]),
    mmRows
  );
  const mmText = await page.getByTestId("mm-table").innerText();
  check("no student identity on the page", !/IG Fixture Student|IGFIX-S0/.test(await page.content()));
  check("posted question marked in Most Missed too", /Instagram ✓ Posted/.test(mmText));
  await page.screenshot({ path: `${SHOTS}/13-most-missed.png`, fullPage: true });
  await page.goto(`${BASE}/admin/instagram/most-missed?range=yesterday&examId=${exam}&min=5&sort=wrongPct&minPct=60`);
  const pctRows = await page.locator('[data-testid="mm-table"] tbody tr[data-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row")));
  check("wrong-% ranking + minimum-% filter", pctRows.join(",") === "IGFIX-RUHS21-W01,IGFIX-RUHS19-W01,IGFIX-QB-0001", pctRows);
  await page.goto(`${BASE}/admin/instagram/most-missed?range=today&examId=${exam}&min=1`);
  const todayRows = await page.locator('[data-testid="mm-table"] tbody tr[data-row]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row")));
  check("today (IST) only has today's answers", todayRows.join(",") === "IGFIX-RUHS19-W02", todayRows);
  await page.goto(`${BASE}/admin/instagram/most-missed?range=yesterday&examId=${exam}&min=5`);
  await openQuestion(page, "IGFIX-QB-0001");
  await page.getByTestId("create-draft").click();
  await waitPreview(page, "1 / 5");
  check("Most Missed draft carries the captured numbers", /6 wrong of 10 answers \(60\.0%\) · Yesterday/.test(await page.getByTestId("series-stats").innerText()));
  await page.getByTestId("field-hook").fill("Most Aspirants Missed This One");
  await page.getByTestId("save-draft").click();
  await editorMessage(page);
  await waitPreview(page, "1 / 5");
  await page.screenshot({ path: `${SHOTS}/14-most-missed-hook.png` });
  await closeEditor(page);

  // ---------------------------------------------------------------- Drafts / Templates
  console.log("\n--- Drafts, Templates ---");
  await page.goto(`${BASE}/admin/instagram/drafts`);
  const drafts = await page.getByTestId("drafts-table").innerText();
  check("Drafts lists current drafts (incl. Most Missed + new version)", /IGFIX-QB-0001/.test(drafts) && /IGFIX-RUHS21-W01 · v2/.test(drafts) && /Most Missed/.test(drafts), drafts.slice(0, 300));
  await page.screenshot({ path: `${SHOTS}/15-drafts.png`, fullPage: true });
  await page.goto(`${BASE}/admin/instagram/templates`);
  await page.waitForFunction(() => [...document.querySelectorAll("img[alt*='sample slide']")].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60000 });
  check("4 templates × 5 sample slides rendered", (await page.locator("img[alt*='sample slide']").count()) === 20);
  check("branding uses the configured handle", /@mocktestseries\.in/.test(await page.getByTestId("branding").innerText()));
  await page.screenshot({ path: `${SHOTS}/16-templates.png`, fullPage: true });

  // ---------------------------------------------------------------- Mobile
  console.log("\n--- Mobile (390 × 844) ---");
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  mp.on("dialog", (d) => d.accept());
  mp.on("console", (msg) => msg.type() === "error" && consoleErrors.push(`[mobile] ${mp.url()} :: ${msg.text().slice(0, 200)}`));
  sql(`DELETE FROM "LoginAttempt"`);
  await login(mp, "igmaster");
  await mp.goto(`${BASE}/admin/instagram/pyq?examId=${exam}&paperId=${p2021}`);
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("PYQ page: no horizontal page scroll on a phone", overflow <= 1, overflow);
  await mp.screenshot({ path: `${SHOTS}/17-mobile-pyq.png`, fullPage: true });
  await openQuestion(mp, "IGFIX-RUHS21-W05");
  await mp.getByTestId("create-draft").click();
  await waitPreview(mp, "1 / 5");
  await mp.getByRole("button", { name: "Next slide" }).click();
  await waitPreview(mp, "2 / 5");
  const box = await mp.getByTestId("slide-preview").boundingBox();
  check("editor preview fits the phone width", box && box.width <= 390 && box.width >= 300, box);
  const edOverflow = await mp.getByTestId("carousel-editor").evaluate((el) => el.scrollWidth - el.clientWidth);
  check("editor: no horizontal scroll", edOverflow <= 1, edOverflow);
  await mp.screenshot({ path: `${SHOTS}/18-mobile-editor.png` });
  await m.close();

  // ---------------------------------------------------------------- Global
  console.log("\n--- Global ---");
  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 5));
  check("no 5xx responses", serverErrors.length === 0, serverErrors.slice(0, 5));
  check("no external network requests (no Meta / Instagram / font CDNs)", external.length === 0, external.slice(0, 5));
  check("no request ever reached Meta/Instagram", !external.some((u) => /facebook|instagram|fbcdn/.test(u)));
  check("Question Bank, options, answers, papers and AI explanations unchanged", fingerprint() === before);
  const writes = sql(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM "AuditLog" WHERE action LIKE 'INSTAGRAM_%'`);
  check("audit log records studio actions", /INSTAGRAM_DRAFT_CREATED/.test(writes) && /INSTAGRAM_MARKED_READY/.test(writes) && /INSTAGRAM_SETTINGS_UPDATED/.test(writes), writes);
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
