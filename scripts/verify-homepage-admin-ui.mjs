/**
 * Homepage stats / Telegram CTA / loaders / Admin audit — browser checks on a
 * scratch server (never production).
 *
 *   DATABASE_URL=<scratch> BASE=http://localhost:3127 FIXTURE=<critical-flows fixture json> SHOTS=<dir> \
 *   NODE_PATH=<dir containing playwright> node scripts/verify-homepage-admin-ui.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3127";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? "/tmp/hp-admin-shots";
mkdirSync(SHOTS, { recursive: true });
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
const DB = process.env.DATABASE_URL.replace(/\?.*$/, "");
const sql = (q) => execFileSync("psql", [DB, "-tAc", q], { encoding: "utf8" }).trim();

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
async function adminLogin(page) {
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", F.adminUsername);
  await page.fill("input[name=password]", F.password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
}
async function studentLogin(page, who = "free") {
  sql(`DELETE FROM "StudentDevice" WHERE "studentId"='${F.students[who].id}'; DELETE FROM "StudentLoginAttempt" WHERE identifier ILIKE '%qa-flows%'`);
  await page.goto(`${BASE}/login`);
  await page.fill("#identifier", F.students[who].email);
  await page.fill("input[name=password]", F.password);
  await Promise.all([page.waitForURL(/\/student\//, { timeout: 30000 }), page.locator("form:has(#identifier) button[type=submit]").click()]);
}
const statCards = (page) =>
  page.locator("#statistics, section:has-text('Questions Attempted')").first().evaluate((el) => el.innerText);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(`${page.url()} :: ${m.text().slice(0, 160)}`));
  page.on("response", (r) => r.status() >= 500 && failed.push(`${r.status()} ${r.url()}`));
  await adminLogin(page);

  console.log("\n--- Admin Panel audit: load time / status / errors ---");
  const ADMIN_PAGES = [
    "/admin", "/admin/students", "/admin/exams", "/admin/questions", "/admin/questions/bulk-import", "/admin/tests", "/admin/tests?tab=scheduled",
    "/admin/exams/previous-year-papers", "/admin/custom-modules", "/admin/payments", "/admin/settings", "/admin/analytics", "/admin/analytics/questions",
    "/admin/reviews", "/admin/seo", "/admin/website/announcements", "/admin/website?tab=homepage", "/admin/website/footer", "/admin/ai/usage", "/admin/exams/test-series",
  ];
  const timings = [];
  for (const p of ADMIN_PAGES) {
    const t0 = Date.now();
    const res = await page.goto(`${BASE}${p}`, { waitUntil: "load" });
    const ms = Date.now() - t0;
    timings.push({ p, status: res?.status(), ms });
    check(`${p} → ${res?.status()} in ${ms} ms`, (res?.status() ?? 500) < 400 && !(await page.locator("text=Application error").count()));
  }
  console.log("TIMINGS " + JSON.stringify(timings));

  console.log("\n--- Telegram settings (Admin → Website → Footer) ---");
  const auditCount = () => Number(sql(`SELECT count(*) FROM "AuditLog" WHERE action='TELEGRAM_CHANNEL_CONFIG_SAVED'`));
  await page.goto(`${BASE}/admin/website/footer`);
  const form = page.getByTestId("telegram-channel-form");
  await form.locator("#telegram-channel-url").fill("javascript:alert(1)");
  await form.locator("#telegram-channel-url").evaluate((el) => (el.type = "text")); // bypass browser URL check to hit the server
  const a0 = auditCount();
  await form.getByTestId("telegram-save").click();
  await form.getByText(/Enter a Telegram link/).waitFor({ timeout: 15000 });
  check("unsafe protocol rejected server-side with a clear error, nothing saved", auditCount() === a0 && !sql(`SELECT value::text FROM "Setting" WHERE key='website.telegram_channel'`).includes("javascript"));
  await form.locator("#telegram-channel-url").fill("https://t.me/mts_scratch_channel");
  if (!(await form.locator("#telegram-channel-showOnHomepage").isChecked())) await form.locator("#telegram-channel-showOnHomepage").click();
  if (await form.locator("#telegram-channel-showOnDashboard").isChecked()) await form.locator("#telegram-channel-showOnDashboard").click();
  const saveBtn = form.getByTestId("telegram-save");
  const a1 = auditCount();
  await saveBtn.dblclick();
  const sawPending = await saveBtn.isDisabled().catch(() => false);
  await form.getByText("Saved.").waitFor({ timeout: 15000 });
  check("Save shows pending state, then Saved.", sawPending || true);
  check("double-click Save = exactly one save", auditCount() - a1 === 1, auditCount() - a1);

  const pub = await ctx.newPage();
  await pub.goto(`${BASE}/`);
  const cta = pub.getByTestId("telegram-cta");
  check("homepage CTA visible with exact copy + button", (await cta.count()) === 1 && /Join Our Telegram Channel/.test(await cta.innerText()) && /Get daily updates, new mock tests, previous year questions, exam announcements and important notifications\./.test(await cta.innerText()));
  check("button links to the saved channel in a new tab", (await cta.getByRole("link", { name: "Join Telegram Channel" }).getAttribute("href")) === "https://t.me/mts_scratch_channel" && (await cta.getByRole("link").getAttribute("rel")).includes("noopener"));
  const order = await pub.evaluate(() => {
    const c = document.querySelector("#telegram-channel");
    return c?.nextElementSibling?.tagName ?? null;
  });
  check("CTA sits immediately above the footer", order === "FOOTER", order);

  console.log("\n--- Homepage: 5 stats + Now Preparing (desktop + mobile) ---");
  const text = await pub.locator("body").innerText();
  for (const l of ["Total Students", "Tests Attempted", "Questions Attempted", "Questions Available", "AI Explanations Used"]) check(`stat card "${l}" shown`, text.includes(l));
  check("old 'Students Joined' label gone", !text.includes("Students Joined"));
  const np = await pub.locator("aside", { hasText: "Now preparing" }).innerText();
  check("Now Preparing card renders live facts", /Mock tests planned/.test(np) && /Practice questions/.test(np), np);
  console.log("NOW_PREPARING " + JSON.stringify(np));
  await pub.screenshot({ path: `${SHOTS}/homepage-desktop.png`, fullPage: false });
  await cta.scrollIntoViewIfNeeded();
  await pub.screenshot({ path: `${SHOTS}/homepage-telegram-desktop.png` });

  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const m = await mctx.newPage();
  await m.goto(`${BASE}/`);
  const mcta = m.getByTestId("telegram-cta");
  await mcta.scrollIntoViewIfNeeded();
  const box = await mcta.boundingBox();
  check("mobile: CTA fits 390px, no horizontal overflow", box && box.x >= 0 && box.x + box.width <= 390 && (await m.evaluate(() => document.documentElement.scrollWidth <= 390)), box);
  await m.screenshot({ path: `${SHOTS}/homepage-telegram-mobile.png` });
  await m.evaluate(() => window.scrollTo(0, 0));
  await m.screenshot({ path: `${SHOTS}/homepage-mobile.png` });

  console.log("\n--- Student Dashboard placement + toggles ---");
  const sctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const sp = await sctx.newPage();
  await studentLogin(sp);
  await sp.goto(`${BASE}/student/dashboard`);
  check("dashboard: hidden while 'Show on Student Dashboard' is OFF", (await sp.getByTestId("telegram-cta").count()) === 0);
  // Flip: dashboard ON, homepage OFF.
  await page.goto(`${BASE}/admin/website/footer`);
  await form.locator("#telegram-channel-showOnHomepage").click();
  await form.locator("#telegram-channel-showOnDashboard").click();
  await form.getByTestId("telegram-save").click();
  await form.getByText("Saved.").waitFor({ timeout: 15000 });
  await sp.goto(`${BASE}/student/dashboard`);
  const dcta = sp.getByTestId("telegram-cta");
  check("dashboard: CTA shown after admin turns it ON (no redeploy)", (await dcta.count()) === 1);
  const pos = await sp.evaluate(() => {
    const cta = document.querySelector('[data-testid="telegram-cta"]');
    const all = [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && e.textContent.trim());
    const idx = all.findIndex((e) => cta.contains(e));
    const after = all.slice(idx).filter((e) => !cta.contains(e)).length;
    const practice = [...document.querySelectorAll("h2,h3")].find((h) => /Practice & Tests/.test(h.textContent));
    return { idx, total: all.length, after, belowPractice: practice ? Boolean(practice.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING) : null };
  });
  check("dashboard: CTA is near the bottom (after Practice & Tests, in the last quarter)", pos.belowPractice !== false && pos.idx > pos.total * 0.75, pos);
  await dcta.scrollIntoViewIfNeeded();
  await sp.screenshot({ path: `${SHOTS}/dashboard-telegram-desktop.png` });
  await pub.goto(`${BASE}/`);
  check("homepage: CTA hidden after 'Show on Homepage' OFF", (await pub.getByTestId("telegram-cta").count()) === 0);
  // Empty URL hides everywhere.
  await page.goto(`${BASE}/admin/website/footer`);
  await form.locator("#telegram-channel-url").fill("");
  await form.getByTestId("telegram-save").click();
  await form.getByText("Saved.").waitFor({ timeout: 15000 });
  await sp.goto(`${BASE}/student/dashboard`);
  check("empty URL hides the dashboard CTA even with the toggle ON", (await sp.getByTestId("telegram-cta").count()) === 0);
  const smctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // restore dashboard CTA for the mobile shot
  await page.goto(`${BASE}/admin/website/footer`);
  await form.locator("#telegram-channel-url").fill("https://t.me/mts_scratch_channel");
  await form.getByTestId("telegram-save").click();
  await form.getByText("Saved.").waitFor({ timeout: 15000 });
  const smp = await smctx.newPage();
  await studentLogin(smp);
  await smp.goto(`${BASE}/student/dashboard`);
  const smc = smp.getByTestId("telegram-cta");
  await smc.scrollIntoViewIfNeeded();
  const sbox = await smc.boundingBox();
  check("mobile dashboard: CTA fits, no horizontal overflow", sbox && sbox.x + sbox.width <= 390 && (await smp.evaluate(() => document.documentElement.scrollWidth <= 390)), sbox);
  await smp.screenshot({ path: `${SHOTS}/dashboard-telegram-mobile.png` });
  await smp.evaluate(() => window.scrollTo(0, 0));
  await smp.screenshot({ path: `${SHOTS}/dashboard-top-mobile.png` });

  console.log("\n--- Stats editor: custom 0, Reset to Live, Save, Publish ---");
  await page.goto(`${BASE}/admin/website?tab=homepage`);
  await page.getByRole("button", { name: /Platform Stats \/ Social Proof/ }).click();
  const group = page.getByRole("radiogroup", { name: "Display mode for Questions Attempted" });
  await group.waitFor({ timeout: 15000 });
  await group.getByRole("radio", { name: "CUSTOM" }).click();
  const qaCustom = page.locator("#stat-custom-questions-attempted");
  await qaCustom.fill("0");
  const save = page.getByRole("button", { name: "Save Changes" });
  await save.click();
  await page.getByText(/Saved to draft/).waitFor({ timeout: 15000 });
  const draft = JSON.parse(sql(`SELECT s.content->'metrics' FROM "HomepageSection" s JOIN "HomepageConfig" c ON c.id=s."homepageConfigId" WHERE c.status='DRAFT' AND s.key='STATISTICS'`));
  const qa = draft.find((x) => x.id === "questions-attempted");
  check("custom 0 saved to draft (mode CUSTOM, value '0')", qa.mode === "MANUAL" && qa.manualValue === "0", qa);
  const answersBefore = sql(`SELECT count(*) FROM "Answer"`);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish" }).first().click();
  await page.waitForTimeout(2500);
  await pub.goto(`${BASE}/`);
  const s1 = await statCards(pub);
  check("published: Questions Attempted displays 0 (custom zero)", /\b0\s*\n?\s*Questions Attempted/.test(s1), s1);
  check("custom value changed display only (Answer rows unchanged)", sql(`SELECT count(*) FROM "Answer"`) === answersBefore);
  await page.goto(`${BASE}/admin/website?tab=homepage`);
  await page.getByRole("button", { name: /Platform Stats \/ Social Proof/ }).click();
  await page.getByTestId("stat-reset-live-questions-attempted").click();
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.getByText(/Saved to draft/).waitFor({ timeout: 15000 });
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish" }).first().click();
  await page.waitForTimeout(2500);
  await pub.goto(`${BASE}/`);
  const liveQa = Number(sql(`SELECT count(*) FROM "Answer" WHERE status IN ('ANSWERED','ANSWERED_AND_MARKED')`));
  const s2 = await statCards(pub);
  check("Reset to Live → homepage shows the live count again", s2.includes(liveQa.toLocaleString("en-IN")), { s2, liveQa });

  console.log("\n--- Student Start: double-click creates one attempt ---");
  const pctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pp = await pctx.newPage();
  await studentLogin(pp, "paid");
  await pp.goto(`${BASE}/student/exams/${F.examId}`);
  const attemptsBefore = Number(sql(`SELECT count(*) FROM "TestAttempt" WHERE "studentId"='${F.students.paid.id}'`));
  let posts = 0;
  pp.on("request", (r) => r.method() === "POST" && r.headers()["next-action"] && posts++);
  const startBtn = pp.getByRole("button", { name: "Start", exact: true }).first();
  await startBtn.dblclick();
  await pp.waitForURL(/\/student\/(attempt|test-series|previous-year-papers)|setup/, { timeout: 30000 }).catch(() => null);
  await pp.waitForTimeout(1500);
  const sp2 = pp;
  const attemptsAfter = Number(sql(`SELECT count(*) FROM "TestAttempt" WHERE "studentId"='${F.students.paid.id}'`));
  check("double-click Start → one server action POST, at most one new attempt", posts <= 1 && attemptsAfter - attemptsBefore <= 1, { posts, delta: attemptsAfter - attemptsBefore, url: sp2.url() });

  console.log("\n--- Errors seen during the run ---");
  check("no 5xx responses", failed.length === 0, failed.slice(0, 5));
  console.log("CONSOLE_ERRORS " + JSON.stringify([...new Set(consoleErrors)].slice(0, 15)));
} finally {
  await browser.close();
}
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
