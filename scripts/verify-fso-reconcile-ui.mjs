/**
 * Browser suite: WITHDRAWN question in the Test Player + post-test review, FORCE TO PUBLISH card (Master Admin vs
 * Full Admin), paper reconciliation panel. Local server on a scratch mts_* DB only (scripts/fso-reconcile-ui-fixture.ts).
 *   BASE=http://localhost:3581 FIXTURE=fx.json DATABASE_URL=<scratch> NODE_PATH=<playwright> node scripts/verify-fso-reconcile-ui.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";

// Playwright is resolved through NODE_PATH (same as the other UI suites).
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE || "http://localhost:3581";
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) || !/\/mts_[a-z0-9_]+(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Runs only against a local server on a scratch mts_* database.");
  process.exit(2);
}
let failures = 0;
let passes = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
async function studentPage(browser, token, mobile) {
  const ctx = await browser.newContext(mobile ? { ...devices["Pixel 7"] } : { viewport: { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: "student-session-token", value: token, url: BASE }]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  return page;
}
async function adminPage(browser, acct) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", acct.username);
  await page.fill("input[name=password]", acct.password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/admin/login"), { timeout: 30000 }).catch(() => null), page.click("button[type=submit]")]);
  return page;
}

const browser = await chromium.launch();
try {
  // One browser context (one registered device for the student); the phone pass resizes to a Pixel 7 viewport.
  const playerPage = await studentPage(browser, F.runToken, false);
  for (const mobile of [false, true]) {
    console.log(`\n--- Test Player with a withdrawn question (${mobile ? "phone 412x915" : "desktop"}) ---`);
    const page = playerPage;
    if (mobile) await page.setViewportSize({ width: 412, height: 915 });
    await page.goto(`${BASE}/student/attempt/${F.runAttemptId}/run`);
    await page.waitForSelector("[data-testid=test-player]");
    if (await page.locator("[data-testid=language-gate]").count()) await page.locator("[data-testid=choose-lang-en]").click();
    check("Q1 is a normal question (no withdrawn label)", (await page.locator("[data-testid=withdrawn-question]").count()) === 0);
    check("palette keeps all 4 printed positions", (await page.locator("[data-testid=palette] button").count()) === 4);
    check("palette marks position 2 as withdrawn", /withdrawn/.test((await page.locator("[data-testid=palette] button").nth(1).getAttribute("aria-label")) ?? ""));
    check("legend shows 'Withdrawn — not scored (1)'", /Withdrawn — not scored \(1\)/.test(await page.locator("[data-testid=legend-withdrawn]").innerText().catch(() => "")));
    await page.locator("[data-testid=palette] button").nth(1).click();
    await page.waitForSelector("[data-testid=withdrawn-question]");
    check("position 2 shows the WITHDRAWN QUESTION label", /withdrawn question/i.test(await page.locator("[data-testid=withdrawn-question]").innerText()));
    check("its original text and options are shown", /WITHDRAWN-ORIGINAL question text as printed/.test(await page.locator("[data-testid=test-player] p.text-question").innerText()) && (await page.locator("[data-testid=option]").count()) === 4);
    check("its options cannot be selected", await page.locator("[data-testid=option] input").first().isDisabled());
    check("Clear Response / Mark for Review are disabled", (await page.getByRole("button", { name: /Clear Response/ }).isDisabled()) && (await page.getByRole("button", { name: /Mark for Review/ }).first().isDisabled()));
    await page.locator("[data-testid=option]").first().click({ force: true });
    check("clicking an option changes nothing", !(await page.locator("[data-testid=option] input").first().isChecked()));
    await page.locator("[data-testid=palette] button").nth(3).click();
    await page.getByRole("button", { name: /^Submit Test$/ }).first().click();
    const dialog = await page.locator("[role=dialog]").innerText();
    check("submit dialog counts 3 scored questions and names the withdrawn one", /answered 0 of 3 questions/.test(dialog) && /1 withdrawn question\(s\) are not scored/.test(dialog), dialog);
    check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
    await page.keyboard.press("Escape");
  }
  await playerPage.context().close();

  console.log("\n--- Post-test review and result ---");
  {
    const page = await studentPage(browser, F.doneToken, false);
    await page.goto(`${BASE}/student/attempt/${F.doneAttemptId}/result`);
    const result = await page.locator("main").innerText();
    check("result: out of 3 (withdrawn not in maximum marks)", /out of 3\b/.test(result), result.slice(0, 300));
    await page.goto(`${BASE}/student/attempt/${F.doneAttemptId}/review`);
    if (await page.locator("[data-testid=language-gate]").count()) await page.locator("[data-testid=choose-lang-en]").click();
    await page.getByRole("button", { name: /Next/ }).first().click();
    await page.waitForSelector("[data-testid=review-withdrawn]");
    const card = await page.locator("main").innerText();
    check("review position 2: WITHDRAWN label, original text, 'Withdrawn — not scored'", /withdrawn question/i.test(card) && /WITHDRAWN-ORIGINAL/.test(card) && /Withdrawn — not scored/.test(card));
    check("review shows no correct answer for it", !/Correct Answer:/.test(card));
    check("no client errors", page.errors.length === 0, page.errors.slice(0, 3));
    await page.context().close();
  }

  console.log("\n--- Admin: question page (Master Admin vs Full Admin) + reconciliation ---");
  {
    const page = await adminPage(browser, F.master);
    check("master admin logged in", !page.url().includes("/admin/login"), page.url());
    await page.goto(`${BASE}/admin/ai-importer/questions/${F.misId}`);
    await page.waitForSelector("[data-testid=publish-actions]");
    check("two separate actions: NORMAL PUBLISH and FORCE TO PUBLISH", (await page.locator("[data-testid=normal-publish-button]").count()) === 1 && (await page.locator("[data-testid=force-publish-button]").count()) === 1);
    check("normal publish is disabled with the exact reason", (await page.locator("[data-testid=normal-publish-button]").isDisabled()) && /Hindi and English versions differ/.test(await page.locator("[data-testid=normal-publish]").innerText()));
    check("bypassed blockers are listed", /BILINGUAL_MISMATCH/.test(await page.locator("[data-testid=force-bypassed]").innerText()));
    check("force is disabled until reason + confirmation", await page.locator("[data-testid=force-publish-button]").isDisabled());
    await page.fill("[data-testid=force-reason]", "Checked against the printed paper (UI test)");
    await page.check("[data-testid=force-confirm]");
    await page.click("[data-testid=force-publish-button]");
    await page.waitForSelector("[data-testid=publish-message]", { timeout: 60000 });
    const msg = await page.locator("[data-testid=publish-message]").innerText();
    check("FORCE TO PUBLISH succeeds: PUBLISHED, blockers recorded", /PUBLISHED/.test(msg) && /bypassed and recorded/.test(msg), msg);
    await page.waitForSelector("[data-testid=publish-stored]", { timeout: 30000 });
    check("after the page refresh the card stays and shows the stored state (PUBLISHED), buttons gone", /PUBLISHED/.test(await page.locator("[data-testid=publish-stored]").innerText()) && (await page.locator("[data-testid=force-publish-button]").count()) === 0 && (await page.locator("[data-testid=publish-message]").count()) === 1);
    await page.goto(`${BASE}/admin/ai-importer/questions/${F.wdId}`);
    await page.waitForSelector("[data-testid=publish-actions]");
    check("a key-withdrawn question offers ADD TO PAPER AS WITHDRAWN", (await page.locator("[data-testid=add-withdrawn-button]").count()) === 1);
    await page.goto(`${BASE}/admin/ai-importer/jobs/${F.jobId}`);
    await page.waitForSelector("[data-testid=paper-reconciliation]");
    const rec = await page.locator("[data-testid=paper-reconciliation]").innerText();
    check("reconciliation panel: missing numbers named (1–4 not in this import, 7, 8)", /Missing numbers: 1, 2, 3, 4, 7, 8\./.test(rec), rec.slice(0, 300));
    check("reconciliation: Q5 published, Q6 withdrawn-not-in-paper with Master Admin force", (await page.locator("[data-testid=recon-row][data-number='6'][data-bucket=WITHDRAWN_NOT_IN_PAPER]").count()) === 1 && /Published/.test(rec));
    await page.context().close();
  }
  {
    const page = await adminPage(browser, F.full);
    await page.goto(`${BASE}/admin/ai-importer/questions/${F.wdId}`);
    const body = await page.locator("body").innerText();
    const card = await page.locator("[data-testid=publish-actions]").count();
    check("Full Admin: no FORCE TO PUBLISH button (read-only note or no access)", (await page.locator("[data-testid=force-publish-button]").count()) === 0 && (card === 0 || (await page.locator("[data-testid=force-readonly]").count()) === 1), body.slice(0, 200));
    await page.context().close();
  }
} finally {
  await browser.close();
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
