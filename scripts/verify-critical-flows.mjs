/**
 * CRITICAL STUDENT JOURNEYS — permanent regression guard (real browser).
 *
 * "A real student can log in → reach what they paid for → open a test →
 * start it → answer → submit → see the result → review it", end to end,
 * for an anonymous visitor, a free student, a paid student and an expired
 * one, on desktop and a touch phone:
 *
 *   T1  public CTA → /login?callbackUrl → login → the ORIGINAL destination
 *   T1b a dead session (logged out in another tab) → login → destination, no crash
 *   T2  signed-in student: public CTAs go straight to the student area
 *   T3  paid student: Test Series → Mock details → Start → Test Player
 *   T4  free / expired student: locked mock → checkout page (Unlock / Renew)
 *   T5  answer → saved → refresh → answer persists
 *   T6  submit → result → review (double submit is harmless)
 *   T7  PYQ: public "Attempt paper" → attempt → player; Start again resumes
 *   T8  Subject Test: setup → Start → player
 *   T9  Custom Module: builder → Create & Start → player
 *   T10 dashboard navigation renders every primary student page
 *   T11 concurrent Start requests create exactly ONE attempt
 *   T12 a refused start (unreleased mock) explains itself, never a 500
 *   T13 mobile: Start Mock → player → answer → refresh persists
 *
 * Runs only against a LOCAL production build backed by a DISPOSABLE copy of
 * production — never against the live site:
 *   createdb <scratch> && pg_dump "$PROD_URL" | psql <scratch>     (then scrub api.* Settings)
 *   npx next build
 *   DATABASE_URL=<scratch> AUTH_URL=http://localhost:3100/api/student-auth NEXTAUTH_URL=http://localhost:3100 npx next start -p 3100 &
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/critical-flows-fixture.ts setup > /tmp/flows.json
 *   BASE=http://localhost:3100 FIXTURE=/tmp/flows.json DATABASE_URL=<scratch> NODE_PATH=<dir containing playwright> node scripts/verify-critical-flows.mjs
 *   DATABASE_URL=<scratch> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/critical-flows-fixture.ts cleanup
 */
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");

const BASE = process.env.BASE || "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}
const F = JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8"));
const path = (url) => url.replace(BASE, "");

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!passed) failures++;
}

const browser = await chromium.launch();

/**
 * A request made by the page itself (fetch, redirects followed): it carries
 * the browser's own cookies. Playwright's page.request drops the Secure
 * device cookie over plain http, so the server saw a new, signed-out device.
 */
async function inPage(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "same-origin" });
    const at = new URL(r.url);
    return { status: r.status, at: at.pathname + at.search, type: r.headers.get("content-type") ?? "" };
  }, url);
}

async function newPage({ mobile = false } = {}) {
  const ctx = await browser.newContext(mobile ? { ...devices["Pixel 7"] } : { viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  page.on("response", (r) => r.status() >= 500 && page.errors.push(`HTTP ${r.status()} ${path(r.url()).slice(0, 100)}`));
  page.mobile = mobile;
  return page;
}
const clean = (page) => page.errors.length === 0;
const crashed = async (page) => /This page couldn.t load|Application error|Something went wrong/i.test(await page.locator("body").innerText().catch(() => ""));

// One device cookie per student, like a real phone: a fresh browser context
// would otherwise count as a new device and trip the app's device limit.
const deviceCookies = new Map();
async function fillLogin(page, email) {
  const known = deviceCookies.get(email);
  if (known) await page.context().addCookies([known]);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  // "Start Free Practice" opens the Create Account tab; an existing student switches to Sign in.
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.waitForSelector("#identifier");
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  // Past /login and past the resume hop (it redirects again to the attempt).
  await page.waitForURL((u) => !u.pathname.startsWith("/login") && u.pathname !== "/student/attempt/resume", { timeout: 30000 });
  await page.waitForLoadState("load");
  const device = (await page.context().cookies()).find((c) => c.name === "mts-device");
  if (device) deviceCookies.set(email, device);
}
async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await fillLogin(page, email);
}
async function tap(page, locator) {
  if (page.mobile) await locator.tap();
  else await locator.click();
}

// --- Test Player helpers (same contract as scripts/verify-test-engine-ui.mjs)
const option = (page, label) => page.locator(`[data-testid=option][data-label="${label}"]`);
async function settled(page) {
  await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
}
async function startFromOverview(page) {
  await page.waitForURL(/\/student\/attempt\/(?!resume)[^/?]+$/, { timeout: 30000 });
  const attemptId = page.url().split("/").pop();
  await tap(page, page.getByRole("link", { name: "Start Test" }));
  await page.waitForSelector("[data-testid=test-player]", { timeout: 30000 });
  return attemptId;
}
/** Pre-Test Setup (Mock details page / PYQ start page) → Start Test with the formal defaults → player. */
async function startFromSetup(page) {
  await page.waitForSelector("[data-testid=pre-test-setup]", { timeout: 30000 });
  await tap(page, page.locator("[data-testid=pre-test-setup]").getByRole("button", { name: /Start Test|Practice Again/ }));
  await page.waitForSelector("[data-testid=test-player]", { timeout: 30000 });
  return page.url().split("/attempt/")[1].split("/")[0];
}
async function answerAndCheckPersist(page, label = "A") {
  await tap(page, option(page, label));
  await settled(page);
  await page.reload();
  await page.waitForSelector("[data-testid=test-player]");
  return option(page, label).locator("input").isChecked();
}

async function db(sql) {
  if (!process.env.DATABASE_URL) return null;
  const { Client } = require("pg");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql)).rows;
  } finally {
    await client.end();
  }
}

try {
  console.log("T1  Public CTA → login → original destination");
  {
    const page = await newPage();
    await page.goto(`${BASE}/`);
    await page.getByRole("link", { name: /Start Free Practice/ }).first().click();
    await page.waitForURL(/\/login/);
    const callback = new URL(page.url()).searchParams.get("callbackUrl");
    check("homepage Start Free Practice → /login with a callbackUrl", callback === "/student/dashboard", path(page.url()));
    await fillLogin(page, F.students.free.email);
    check("after login → /student/dashboard", path(page.url()).startsWith("/student/dashboard"), path(page.url()));

    const anon = await newPage();
    await anon.goto(`${BASE}/exams/${F.examSlug}/mock-test-series`);
    await anon.locator(`a[href="/student/attempt/resume?mockTest=${F.freeMockId}"]`).first().click();
    await anon.waitForURL(/\/login/);
    check("Start Mock (logged out) → /login?callbackUrl=<resume url>", new URL(anon.url()).searchParams.get("callbackUrl") === `/student/attempt/resume?mockTest=${F.freeMockId}`, path(anon.url()));
    await fillLogin(anon, F.students.free.email);
    check(
      "after login → that mock's Pre-Test Setup (not the dashboard)",
      path(anon.url()) === `/student/test-series/${F.freeMockId}` && (await anon.locator("[data-testid=pre-test-setup]").count()) === 1,
      path(anon.url())
    );
    check("T1 no errors", clean(page) && clean(anon), [...page.errors, ...anon.errors]);
    await page.context().close();
    await anon.context().close();
  }

  console.log("T1b Dead session (logged out elsewhere) → login → destination");
  {
    const a = await newPage();
    await login(a, F.students.paid.email);
    const cookies = await a.context().cookies();
    const b = await newPage();
    await b.context().addCookies(cookies);
    // Tab A logs out: the session row is revoked server-side; tab B still holds the old cookie.
    await a.goto(`${BASE}/student/dashboard`);
    await a.getByRole("button", { name: /account|profile|menu/i }).first().click();
    await Promise.all([a.waitForURL(/\/login/, { timeout: 30000 }), a.getByRole("menuitem", { name: /logout/i }).click()]);
    await b.goto(`${BASE}/student/attempt/resume?mockTest=${F.paidMockId}`);
    check("stale cookie → /login with the destination, not a crash", path(b.url()).startsWith("/login") && new URL(b.url()).searchParams.get("callbackUrl") === `/student/attempt/resume?mockTest=${F.paidMockId}` && !(await crashed(b)), path(b.url()));
    check("stale cookie dropped", !(await b.context().cookies()).some((c) => c.name === "student-session-token"));
    await fillLogin(b, F.students.paid.email);
    check("re-login → the paid mock's Pre-Test Setup", path(b.url()) === `/student/test-series/${F.paidMockId}` && (await b.locator("[data-testid=pre-test-setup]").count()) === 1, path(b.url()));
    await b.goto(`${BASE}/student/dashboard`);
    check("dashboard renders after re-login", !(await crashed(b)) && path(b.url()) === "/student/dashboard", path(b.url()));
    check("T1b no errors", clean(a) && clean(b), [...a.errors, ...b.errors]);
    await a.context().close();
    await b.context().close();
  }

  console.log("T2  Signed-in student: public CTAs go straight in");
  {
    const page = await newPage();
    await login(page, F.students.free.email);
    await page.goto(`${BASE}/`);
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => [a.innerText.trim(), a.getAttribute("href")]));
    const toLogin = hrefs.filter(([, h]) => h.startsWith("/login"));
    check("homepage has no /login or register links for a signed-in student", toLogin.filter(([t]) => !/^Student Login$/i.test(t)).length === 0, toLogin);
    await page.getByRole("link", { name: /Start Free Practice/ }).first().click();
    await page.waitForURL(/\/student\//);
    check("Start Free Practice → dashboard directly", path(page.url()) === "/student/dashboard", path(page.url()));
    await page.goto(`${BASE}/login?callbackUrl=%2Fstudent%2Ftest-series`);
    check("/login while signed in → callbackUrl, no login form", path(page.url()) === "/student/test-series", path(page.url()));
    check("T2 no errors", clean(page), page.errors);
    await page.context().close();
  }

  let paidAttemptId = null;
  console.log("T3  Paid student: Test Series → Mock details → Start → Player");
  {
    const page = await newPage();
    await login(page, F.students.paid.email);
    await page.goto(`${BASE}/student/test-series`);
    const card = page.locator(`a[href="/student/test-series/${F.paidMockId}"]`).first();
    check("paid mock listed in Test Series", (await card.count()) === 1);
    await card.click();
    await page.waitForURL(new RegExp(`/student/test-series/${F.paidMockId}$`));
    check("mock details page renders", !(await crashed(page)));
    await page.getByRole("button", { name: /Start Test|Resume Test|Practice Again/ }).click();
    await page.waitForURL(/\/student\/attempt\/[^/]+\/run$/, { timeout: 30000 });
    await page.waitForSelector("[data-testid=test-player]");
    paidAttemptId = page.url().split("/").slice(-2)[0];
    check("paid mock opens in the Test Player", /Question 1 of/.test(await page.locator("[data-testid=question-position]").innerText()));

    console.log("T5  Answer → save → refresh → persists");
    check("answer A persists across refresh", await answerAndCheckPersist(page, "A"));
    await tap(page, page.getByRole("button", { name: /Save & Next/ }));
    await tap(page, option(page, "B"));
    await settled(page);
    await page.goto(`${BASE}/student/test-series/${F.paidMockId}`);
    await page.getByRole("button", { name: /Resume Test/ }).click();
    await page.waitForURL(/\/run$/);
    await page.waitForSelector("[data-testid=test-player]");
    check("Resume Test returns to the SAME attempt", page.url().includes(paidAttemptId), path(page.url()));
    await page.getByRole("button", { name: "Go to question 2", exact: true }).click();
    check("Q2 answer B still selected after resume", await option(page, "B").locator("input").isChecked());

    console.log("T6  Submit → Result → Review");
    await settled(page);
    await page.getByRole("button", { name: "Submit Test" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
    await page.waitForURL(/\/result$/, { timeout: 30000 });
    check("result page renders", !(await crashed(page)) && /Test submitted successfully/.test(await page.locator("body").innerText()));
    await page.goto(`${BASE}/student/attempt/${paidAttemptId}/run`);
    check("player after submit does not reopen the test", !page.url().endsWith("/run") || !(await page.locator("[data-testid=test-player]").count()), path(page.url()));
    await page.goto(`${BASE}/student/attempt/${paidAttemptId}/review`);
    check("review page renders", !(await crashed(page)) && (await page.locator("body").innerText()).length > 200);
    const rows = await db(`select status, score from "TestAttempt" where id='${paidAttemptId}'`);
    if (rows) check("attempt SUBMITTED exactly once", rows.length === 1 && rows[0].status === "SUBMITTED", rows);
    check("T3/T5/T6 no errors", clean(page), page.errors);
    await page.context().close();
  }

  console.log("T4  Locked mock → checkout (free: Unlock, expired: Renew)");
  {
    const page = await newPage();
    await page.goto(`${BASE}/exams/${F.examSlug}/mock-test-series`);
    await page.getByRole("link", { name: /Unlock Complete Series/ }).first().click();
    await page.waitForURL(/\/login/);
    check("anonymous Unlock Complete Series → /login?callbackUrl=<checkout>", new URL(page.url()).searchParams.get("callbackUrl") === `/student/checkout/${F.productCode}`, path(page.url()));
    await fillLogin(page, F.students.free.email);
    check("after login → the checkout page for that product", path(page.url()) === `/student/checkout/${F.productCode}` && !(await crashed(page)), path(page.url()));
    check("T4 anonymous unlock no errors", clean(page), page.errors);
    await page.context().close();
  }
  for (const who of ["free", "expired"]) {
    const page = await newPage();
    await login(page, F.students[who].email);
    await page.goto(`${BASE}/student/test-series/${F.paidMockId}`);
    const buy = page.locator("[data-testid=purchase-options] a").first();
    const label = (await buy.count()) ? await buy.innerText() : "";
    check(`${who}: details page offers ${who === "expired" ? "Renew" : "Unlock/Buy"}`, who === "expired" ? /Renew/.test(label) : /Unlock|Buy/.test(label), label);
    await page.goto(`${BASE}/student/attempt/resume?mockTest=${F.paidMockId}`);
    check(`${who}: direct Start URL → checkout, no attempt`, path(page.url()).startsWith("/student/checkout/"), path(page.url()));
    check(`${who}: checkout page renders`, !(await crashed(page)) && /Pay|Checkout|₹/.test(await page.locator("body").innerText()));
    const rows = await db(`select count(*)::int n from "TestAttempt" where "studentId"='${F.students[who].id}' and "mockTestId"='${F.paidMockId}'`);
    if (rows) check(`${who}: no attempt created for the locked mock`, rows[0].n === 0, rows);
    check(`T4 ${who} no errors`, clean(page), page.errors);
    await page.context().close();
  }

  console.log("T7  PYQ: public Attempt paper → player; Start again resumes");
  {
    const page = await newPage();
    await login(page, F.students.free.email);
    await page.goto(`${BASE}/exams/${F.examSlug}/previous-year-papers`);
    await page.locator(`a[href="/student/attempt/resume?paper=${F.paperId}"]`).first().click();
    const attemptId = await startFromSetup(page);
    check("PYQ opens in the Test Player", /Question 1 of/.test(await page.locator("[data-testid=question-position]").innerText()));
    await page.goto(`${BASE}/student/attempt/resume?paper=${F.paperId}`);
    check("second Start resumes the same PYQ attempt", path(page.url()) === `/student/attempt/${attemptId}`, path(page.url()));
    check("T7 no errors", clean(page), page.errors);
    await page.context().close();
  }

  console.log("T8  Subject Test → Start → Player");
  {
    const page = await newPage();
    await login(page, F.students.free.email);
    await page.goto(`${BASE}/student/subject-test/${F.examId}`);
    await page.waitForFunction(() => /questions are available/.test(document.body.innerText), null, { timeout: 20000 });
    const count = page.locator('input[name="count"]');
    if (await count.count()) {
      await count.fill("5");
      await count.blur();
    }
    await page.getByRole("button", { name: /Start Subject Test/ }).click();
    await startFromOverview(page);
    check("Subject Test opens in the Test Player", /Question 1 of 5/.test(await page.locator("[data-testid=question-position]").innerText()));
    check("T8 no errors", clean(page), page.errors);
    await page.context().close();
  }

  console.log("T9  Custom Module → Create & Start → Player");
  {
    const page = await newPage();
    await login(page, F.students.free.email);
    await page.goto(`${BASE}/student/custom-module?examId=${F.examId}`);
    await page.waitForFunction(() => /questions are available/.test(document.body.innerText), null, { timeout: 20000 });
    const count = page.locator('input[name="count"]');
    await count.fill("3");
    await count.blur();
    await page.getByRole("button", { name: /Create & Start/ }).click();
    await startFromOverview(page);
    check("Custom Module opens in the Test Player", /Question 1 of 3/.test(await page.locator("[data-testid=question-position]").innerText()));
    check("custom module answer persists across refresh", await answerAndCheckPersist(page, "C"));
    check("T9 no errors", clean(page), page.errors);
    await page.context().close();
  }

  console.log("T10 Dashboard navigation");
  {
    const page = await newPage();
    await login(page, F.students.paid.email);
    for (const p of ["/student/dashboard", "/student/exams", `/student/exams/${F.examId}`, "/student/test-series", "/student/subject-test", "/student/custom-module", "/student/history", "/student/analytics", "/student/saved", "/student/profile", "/student/plans", "/student/subscriptions", "/student/payments"]) {
      const res = await page.goto(BASE + p);
      // /student/plans forwards to the public Plans & Pricing page.
      const at = p === "/student/plans" ? "/plans-and-pricing" : p.split("?")[0];
      check(`${p} renders`, res.status() < 400 && path(page.url()).startsWith(at) && !(await crashed(page)), { status: res.status(), at: path(page.url()) });
    }
    await page.goto(`${BASE}/student/live-tests`);
    check("/student/live-tests (retired) → Test Series", path(page.url()) === "/student/test-series" && !(await crashed(page)), path(page.url()));
    // Retired page: forwards to the Practice OMR sheet download.
    const omr = await inPage(page, `${BASE}/student/omr`);
    check("/student/omr downloads the OMR sheet", omr.status === 200 && /pdf|octet-stream/.test(omr.type), omr);
    check("T10 no errors", clean(page), page.errors);
    await page.context().close();
  }

  console.log("T11 Concurrent Start → no attempt before setup, then exactly one attempt");
  {
    const page = await newPage();
    await login(page, F.students.expired.email);
    // The start link never creates an attempt: it resumes, or opens the Pre-Test Setup.
    const rs = await Promise.all(Array.from({ length: 6 }, () => inPage(page, `${BASE}/student/attempt/resume?mockTest=${F.freeMockId}`)));
    const targets = new Set(rs.map((r) => r.at));
    check("6 concurrent start links → the one setup page", targets.size === 1 && [...targets][0] === `/student/test-series/${F.freeMockId}`, [...targets]);
    const none = await db(`select count(*)::int n from "TestAttempt" where "studentId"='${F.students.expired.id}' and "mockTestId"='${F.freeMockId}'`);
    if (none) check("no attempt written before Start is pressed", none[0].n === 0, none);
    // Concurrent configured starts (server action) are covered by scripts/verify-pre-test-setup.ts.
    await page.goto(`${BASE}/student/test-series/${F.freeMockId}`);
    const oldId = await startFromSetup(page);
    const again = await Promise.all(Array.from({ length: 6 }, () => inPage(page, `${BASE}/student/attempt/resume?mockTest=${F.freeMockId}`)));
    const resumed = new Set(again.map((r) => r.at));
    check("6 concurrent start links while running → the SAME attempt", resumed.size === 1 && [...resumed][0] === `/student/attempt/${oldId}`, [...resumed]);
    const rows = await db(`select count(*)::int n from "TestAttempt" where "studentId"='${F.students.expired.id}' and "mockTestId"='${F.freeMockId}' and status='IN_PROGRESS'`);
    if (rows) check("one IN_PROGRESS row in the database", rows[0].n === 1, rows);

    console.log("T11b Start after the time ran out → a fresh setup, not the dead attempt");
    if (rows && oldId) {
      await db(`update "TestAttempt" set "startedAt" = now() - interval '2 days' where id='${oldId}'`);
      const res = await inPage(page, `${BASE}/student/attempt/resume?mockTest=${F.freeMockId}`);
      check("Start offers a NEW setup (dead attempt not resumed)", res.at === `/student/test-series/${F.freeMockId}`, res.at);
      const [old] = await db(`select status from "TestAttempt" where id='${oldId}'`);
      check("the timed-out attempt was finalized (SUBMITTED), not left dangling", old.status === "SUBMITTED", old);
    }
    await page.context().close();
  }

  console.log("T12 Refused start explains itself");
  if (F.upcomingMockId) {
    const page = await newPage();
    await login(page, F.students.paid.email);
    const res = await page.goto(`${BASE}/student/attempt/resume?mockTest=${F.upcomingMockId}`);
    check("unreleased mock → /student/unavailable, HTTP 200", path(page.url()).startsWith("/student/unavailable?test=") && res.status() === 200, { at: path(page.url()), status: res.status() });
    check("explains the release schedule", /not available yet/i.test(await page.locator("body").innerText()));
    await page.goto(`${BASE}/student/attempt/resume?mockTest=does-not-exist`);
    check("unknown mock id → explanation, not a crash", path(page.url()).startsWith("/student/unavailable") && !(await crashed(page)), path(page.url()));
    check("T12 no errors", clean(page), page.errors);
    await page.context().close();
  }

  console.log("T13 Mobile: Start Mock → Player → answer → refresh");
  {
    const page = await newPage({ mobile: true });
    // The paid student: the free one has used up the app's 8-logins-per-15-minutes allowance by now.
    await login(page, F.students.paid.email);
    await page.goto(`${BASE}/exams/${F.examSlug}/mock-test-series`);
    await tap(page, page.locator(`a[href="/student/attempt/resume?mockTest=${F.freeMockId}"]`).first());
    await startFromSetup(page);
    check("mobile: answer persists across refresh", await answerAndCheckPersist(page, "D"));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("mobile: player has no horizontal overflow", overflow <= 1, overflow);
    check("T13 no errors", clean(page), page.errors);
    await page.context().close();
  }
} catch (error) {
  failures++;
  console.log(`  FAIL  suite aborted: ${error.message.split("\n")[0]}`);
} finally {
  await browser.close();
}

console.log(`\n=== ${failures === 0 ? "ALL CRITICAL FLOWS PASSED" : `${failures} CHECK(S) FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
