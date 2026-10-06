/**
 * Live CBT end-to-end in real browsers against a local production build on a
 * DISPOSABLE database (fixture: scripts/live-cbt-ui-fixture.ts). Sets the
 * live mock's window to open ~70 s from now and last 120 s, then:
 *   share link → login → back to the SAME test → Enroll → countdown →
 *   Start Live Test appears WITHOUT a reload → player → (mobile, 360 px) early
 *   submit: score / review / leaderboard / Solution PDF locked → (desktop)
 *   open browser auto-submits at the window end → abandoned attempt finalized
 *   by the sweep → everything released, leaderboard includes all three.
 * Also: register via the share link during the window (late join, enroll,
 * start), unenrolled direct start refused, ordinary mock unchanged, admin
 * card (enrolled count, share link, save) and Fixed Window defaults.
 *
 *   BASE=http://localhost:3111 FIXTURE=/tmp/lcb.json DATABASE_URL=<scratch> SHOTS=<dir> \
 *     NODE_PATH=<dir containing playwright> node scripts/verify-live-cbt-ui.mjs
 */
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3111";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? "/tmp/lcb-shots";
mkdirSync(SHOTS, { recursive: true });
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const DB = process.env.DATABASE_URL.replace(/\?schema=public$/, "");
const sql = (q) => execFileSync("psql", [DB, "-Atc", q], { encoding: "utf8" }).trim();
const testUrl = `${BASE}/student/test-series/${F.l1}`;

async function login(page, email, { viaShareLink = false } = {}) {
  if (!viaShareLink) await page.goto(`${BASE}/login`);
  await page.locator("#identifier").or(page.getByText("Already have an account? Sign in")).first().waitFor();
  if (!(await page.locator("#identifier").count())) await page.getByText("Already have an account? Sign in").click();
  await page.fill("#identifier", email);
  await page.fill("input[name=password]", F.password);
  await page.locator("form:has(#identifier) button[type=submit]").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
}
async function answer(page, n) {
  for (let i = 0; i < n; i++) {
    await page.locator("[data-testid=option]").first().click();
    await page.waitForFunction(() => (document.querySelector("[data-testid=save-status]")?.textContent ?? "") === "", null, { timeout: 15000 });
    if (i < n - 1) await page.getByRole("button", { name: /Save & Next|Next/ }).first().click();
  }
}
async function startLive(page) {
  await page.getByRole("button", { name: /Start Live Test/ }).click();
  await page.waitForURL(/\/student\/attempt\/[^/]+(\/run)?$/, { timeout: 30000 });
  if (!page.url().endsWith("/run")) await page.getByRole("link", { name: "Start Test" }).click();
  await page.waitForSelector("[data-testid=test-player]", { timeout: 30000 });
  return page.url().split("/").at(-2);
}
const fetchStatus = (page, url) => page.evaluate(async (u) => (await fetch(u)).status, url);
const attemptCount = () => sql(`select count(*) from "TestAttempt" where "mockTestId"='${F.l1}'`);

/** Student Dashboard "Next Test" card, opened in a fresh tab of an already signed-in context. */
async function dashboardCard(ctx, shot) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/student/dashboard`);
  await page.waitForLoadState("networkidle");
  const card = page.getByText(/Test Schedule · Next Test/i).first().locator("xpath=ancestor::*[.//a][1]");
  const text = (await card.innerText()).replace(/\s+/g, " ");
  const link = card.locator("a").last();
  const out = { page, text, label: (await link.innerText()).trim(), href: await link.getAttribute("href"), overflow: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) };
  if (shot) await card.screenshot({ path: `${SHOTS}/${shot}.png` });
  return out;
}

const startAt = Date.now() + 70_000;
const endAt = startAt + 120_000;
sql(`update "MockTest" set "availableFrom" = to_timestamp(${startAt / 1000}), "availableUntil" = to_timestamp(${endAt / 1000}) where id = '${F.l1}'`);
console.log(`window: ${new Date(startAt).toISOString()} → ${new Date(endAt).toISOString()}`);

const browser = await chromium.launch();
try {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mob = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, colorScheme: "dark" });
  const ab = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const viewer = await desk.newPage();
  const early = await mob.newPage();
  const abandon = await ab.newPage();

  console.log("\nShare link → login → same test");
  await viewer.goto(testUrl);
  check("signed-out share link → /login with callbackUrl to the same test", viewer.url().includes("/login") && decodeURIComponent(viewer.url()).includes(`/student/test-series/${F.l1}`), viewer.url());
  await login(viewer, F.students.viewer.email, { viaShareLink: true });
  check("after login the student is back on the SAME test page", viewer.url() === testUrl, viewer.url());

  console.log("\nBefore start");
  check("LIVE CBT badge + info card (start, end, duration, questions, marks)", (await viewer.getByTestId("live-cbt-badge").count()) === 1 && /Starts[\s\S]*Ends[\s\S]*Duration[\s\S]*Questions[\s\S]*Marks/.test(await viewer.getByTestId("live-cbt-info").innerText()));
  check("public enrolled count shows 0 (counts only)", (await viewer.getByTestId("enrolled-count").innerText()).startsWith("0 students"));
  check("Enroll in Live Test button shown, no Start button", (await viewer.getByTestId("enroll-button").count()) === 1 && (await viewer.getByRole("button", { name: /Start Live Test/ }).count()) === 0);
  await viewer.screenshot({ path: `${SHOTS}/desktop-before-enroll.png`, fullPage: true });
  const attemptsBefore = sql(`select count(*) from "TestAttempt" where "mockTestId"='${F.l1}'`);
  await viewer.getByTestId("enroll-button").click();
  await viewer.getByTestId("enrolled-badge").waitFor({ timeout: 15000 });
  check("✓ You're Enrolled shown", (await viewer.getByTestId("enrolled-badge").innerText()).includes("You're Enrolled"));
  check("enrolling created no TestAttempt", sql(`select count(*) from "TestAttempt" where "mockTestId"='${F.l1}'`) === attemptsBefore);
  check("exactly one enrollment row", sql(`select count(*) from "MockTestEnrollment" where "mockTestId"='${F.l1}' and "studentId"='${F.students.viewer.id}'`) === "1");
  const c1 = await viewer.getByTestId("starts-in").innerText();
  await viewer.waitForTimeout(2100);
  const c2 = await viewer.getByTestId("starts-in").innerText();
  check(`countdown ticks HH:MM:SS (${c1} → ${c2})`, /^\d\d:\d\d:\d\d$/.test(c1) && c1 !== c2);
  await viewer.screenshot({ path: `${SHOTS}/desktop-enrolled-countdown.png`, fullPage: true });

  await login(early, F.students.early.email);
  await early.goto(testUrl);
  await early.getByTestId("enroll-button").click();
  await early.getByTestId("enrolled-badge").waitFor({ timeout: 15000 });
  check("mobile: enrolled + countdown at 360 px, no horizontal scroll", (await early.getByTestId("starts-in").count()) === 1 && (await early.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await early.screenshot({ path: `${SHOTS}/mobile-enrolled-countdown.png`, fullPage: true });
  await login(abandon, F.students.abandon.email);
  await abandon.goto(testUrl);
  await abandon.getByTestId("enroll-button").click();
  await abandon.getByTestId("enrolled-badge").waitFor({ timeout: 15000 });
  const early2 = await viewer.evaluate(async (id) => {
    const r = await fetch(`/student/attempt/resume?mockTest=${id}`, { redirect: "follow" });
    return r.url;
  }, F.l1);
  check("enrolled, before start: the start path refuses (no attempt can exist)", sql(`select count(*) from "TestAttempt" where "mockTestId"='${F.l1}'`) === "0", early2);
  const before = attemptCount();
  const up = await dashboardCard(ab, "dashboard-upcoming-enrolled");
  check("dashboard (upcoming, enrolled): Live Test · Enrolled + View Live Test → this test", /Live Test · Enrolled/.test(up.text) && /Starts in/i.test(up.text) && up.label === "View Live Test" && up.href === `/student/test-series/${F.l1}`, up);
  check("viewing the dashboard created no attempt", attemptCount() === before);
  await up.page.close();
  await viewer.reload();
  check("public enrolled count now 3", (await viewer.getByTestId("enrolled-count").innerText()).startsWith("3 students"));

  console.log("\nStart time arrives — no reload");
  await viewer.evaluate(() => {
    window.__noReloadMarker = 42;
  });
  await viewer.getByRole("button", { name: /Start Live Test/ }).waitFor({ timeout: 120000 });
  check("Start Live Test appeared at the start instant without a page reload", (await viewer.evaluate(() => window.__noReloadMarker)) === 42);
  check("…not before the server start time", Date.now() >= startAt - 1500, Date.now() - startAt);
  check("window-closes countdown shown", /^\d\d:\d\d:\d\d$/.test(await viewer.getByTestId("ends-in").innerText()));

  console.log("\nDashboard while LIVE");
  const liveBefore = attemptCount();
  const live = await dashboardCard(ab, "dashboard-live-now-desktop");
  check("dashboard (live, enrolled): Live Now · Ends … + Enter Live Test", /Live Test · Enrolled/.test(live.text) && /Live Now · Ends/.test(live.text) && live.label === "Enter Live Test", live);
  await live.page.getByRole("link", { name: "Enter Live Test" }).click();
  await live.page.waitForURL(testUrl, { timeout: 30000 });
  check("Enter Live Test opens the same Live CBT page with Start Live Test", (await live.page.getByRole("button", { name: /Start Live Test/ }).count()) === 1, live.page.url());
  await live.page.close();
  const liveMob = await dashboardCard(mob, "dashboard-live-now-mobile");
  check("dashboard (live) on 360 px mobile: Live Now + Enter Live Test", /Live Now · Ends/.test(liveMob.text) && liveMob.label === "Enter Live Test" && liveMob.href === `/student/test-series/${F.l1}`, liveMob);
  await liveMob.page.close();
  check("viewing the live dashboard created no attempt", attemptCount() === liveBefore);

  console.log("\nEarly finisher (mobile) — everything held");
  await early.getByRole("button", { name: /Start Live Test/ }).waitFor({ timeout: 30000 });
  const earlyAttempt = await startLive(early);
  await answer(early, 1);
  await early.getByRole("button", { name: "Submit Test" }).first().click();
  await early.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await early.waitForURL(/\/result$/, { timeout: 30000 });
  const heldText = await early.locator("body").innerText();
  check("early result: Result Pending, no score / leaderboard", /Result Pending/i.test(heldText) && !/IST IST/.test(heldText) && (await early.getByTestId("rank-summary").count()) === 0);
  await early.screenshot({ path: `${SHOTS}/mobile-result-pending.png`, fullPage: true });

  console.log("\nAdmin Live CBT Monitor while results are held");
  const adm = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await adm.goto(`${BASE}/admin/login`);
  await adm.fill("input[name=username]", F.adminUsername);
  await adm.fill("input[name=password]", F.password);
  await Promise.all([adm.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), adm.locator("form button[type=submit]").click()]);
  await adm.goto(`${BASE}/admin/tests/mock/${F.l1}#live`);
  await adm.getByTestId("open-live-monitor").click();
  await adm.waitForURL(/\/live-monitor$/);
  const tiles = (await adm.getByTestId("live-monitor-summary").innerText()).replace(/\s+/g, " ");
  check("monitor: 3 enrolled, 1 started, 1 submitted by student (live)", /\b3 Enrolled/.test(tiles) && /\b1 Started/.test(tiles) && /\b1 Submitted by student/.test(tiles), tiles);
  const heldRows = (await adm.getByTestId("live-monitor-table").innerText()).replace(/\s+/g, " ");
  check("monitor: candidate list names all 3 enrolled students", [F.students.viewer, F.students.early, F.students.abandon].every((s) => heldRows.includes(s.email)), heldRows.slice(0, 300));
  check("monitor: score and rank Held before the result release", /Held/.test(heldRows) && !/\d+(\.\d+)? \/ \d+ /.test(heldRows) && /Results: Held until/.test(await adm.locator("main").innerText()), heldRows.slice(0, 300));
  check("monitor is read-only (no forms or buttons)", (await adm.locator("main form").count()) === 0 && (await adm.locator("main button").count()) === 0);
  await adm.screenshot({ path: `${SHOTS}/admin-monitor-held.png`, fullPage: true });
  await early.goto(`${BASE}/student/attempt/${earlyAttempt}/review`);
  check("early review locked", /Answer review isn.t available yet/i.test(await early.locator("body").innerText()));
  await early.goto(`${BASE}/student/attempt/${earlyAttempt}/leaderboard`);
  check("early leaderboard locked (redirects to the pending result)", early.url().endsWith(`/student/attempt/${earlyAttempt}/result`), early.url());
  check("early Solution PDF locked (403)", (await fetchStatus(early, `/api/student/test-resources/${F.solutionId}`)) === 403);
  await early.goto(testUrl);
  check("test page: submitted, result releases at the window end, no second start (single attempt)", (await early.getByTestId("result-releases").count()) === 1 && (await early.getByRole("button", { name: /Start Live Test/ }).count()) === 0);

  console.log("\nAbandoned attempt + unenrolled + late registration");
  await abandon.getByRole("button", { name: /Start Live Test/ }).waitFor({ timeout: 30000 });
  const abandonAttempt = await startLive(abandon);
  await answer(abandon, 1);
  await ab.close();
  const lateCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const late = await lateCtx.newPage();
  await late.goto(testUrl);
  await late.getByText(/Create Account/).first().click().catch(() => {});
  if (!(await late.locator("#reg-password").count())) await late.goto(`${BASE}/login?tab=register&callbackUrl=${encodeURIComponent(`/student/test-series/${F.l1}`)}`);
  await late.fill("#name", "Late Comer");
  await late.fill("#email", F.lateEmail);
  await late.fill("#mobile", "+919000007999");
  await late.fill("#reg-password", F.password);
  await late.fill("#confirmPassword", F.password);
  await late.locator("input[name=acceptTerms]").check();
  await late.getByRole("button", { name: /Create Account/ }).last().click();
  await late.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  check("register via the share link → back on the SAME test", late.url() === testUrl, late.url());
  const res = await late.goto(`${BASE}/student/attempt/resume?mockTest=${F.l1}`);
  check("unenrolled direct start during the window → explained refusal, no attempt", /enroll/i.test(await late.locator("body").innerText()) && sql(`select count(*) from "TestAttempt" a join "Student" s on s.id=a."studentId" where s.email='${F.lateEmail}'`) === "0", res?.url());
  await late.goto(testUrl);
  await late.getByTestId("enroll-button").click();
  await late.getByRole("button", { name: /Start Live Test/ }).waitFor({ timeout: 15000 });
  check("late joiner can still enroll while live and gets Start Live Test", true);

  console.log("\nOpen browser auto-submits at the window end");
  const viewerAttempt = await startLive(viewer);
  await answer(viewer, 2);
  const remaining = endAt - Date.now();
  await viewer.waitForURL(/\/result$/, { timeout: remaining + 30000 });
  check("open browser auto-submitted when the window closed", Date.now() >= endAt - 1500 && sql(`select status from "TestAttempt" where id='${viewerAttempt}'`) === "SUBMITTED");
  check("abandoned attempt still IN_PROGRESS until the sweep", sql(`select status from "TestAttempt" where id='${abandonAttempt}'`) === "IN_PROGRESS");
  execFileSync("npx", ["--no-install", "tsx", "scripts/finalize-live-attempts.ts", "--once"], { env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" }, stdio: "inherit" });
  check("sweep finalized the abandoned attempt (1 answer saved before the deadline)", sql(`select status||','||"correctCount"+"incorrectCount" from "TestAttempt" where id='${abandonAttempt}'`) === "SUBMITTED,1");

  console.log("\nAfter the window — released");
  await viewer.reload();
  check("result released: score + rank summary (3 ranked)", (await viewer.getByTestId("rank-summary").count()) === 1 && (await viewer.getByTestId("rank-value").innerText()).includes("/ 3"), await viewer.getByTestId("rank-value").innerText().catch(() => ""));
  await viewer.screenshot({ path: `${SHOTS}/desktop-result-released.png`, fullPage: true });
  await viewer.goto(`${BASE}/student/attempt/${viewerAttempt}/review`);
  check("review unlocked", !/Answer review isn.t available yet/i.test(await viewer.locator("body").innerText()) && !/Result Pending/i.test(await viewer.locator("body").innerText()));
  check("Solution PDF unlocked (200)", (await fetchStatus(viewer, `/api/student/test-resources/${F.solutionId}`)) === 200);
  await viewer.goto(`${BASE}/student/attempt/${viewerAttempt}/leaderboard`);
  check("leaderboard: 3 participants incl. the abandoned (finalized) attempt; YOU highlighted", (await viewer.getByText("3 ranked participants").count()) === 1 && (await viewer.locator("[data-self=true]").count()) >= 1);
  await viewer.goto(testUrl);
  check("test page: Live Test Completed + View Result", (await viewer.getByTestId("live-cbt-panel").innerText()).includes("Live Test Completed") && (await viewer.getByRole("link", { name: /View Result/ }).count()) === 1);
  await early.goto(`${BASE}/student/attempt/${earlyAttempt}/result`);
  check("mobile early finisher: result now visible", (await early.getByTestId("rank-summary").count()) === 1 && (await early.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
  await early.screenshot({ path: `${SHOTS}/mobile-result-released.png`, fullPage: true });
  const res2 = await late.goto(`${BASE}/student/attempt/resume?mockTest=${F.l1}`);
  check("after the end: no new attempt can start", /closed/i.test(await late.locator("body").innerText()), res2?.url());

  console.log("\nOrdinary mock unchanged");
  await viewer.goto(`${BASE}/student/test-series/${F.l2}`);
  check("enrollment OFF mock: no LIVE CBT panel, normal start", (await viewer.getByTestId("live-cbt-panel").count()) === 0 && (await viewer.getByTestId("live-cbt-badge").count()) === 0 && (await viewer.getByRole("button", { name: /Start Test|Start/ }).count()) >= 1);

  console.log("\nAdmin");
  await adm.goto(`${BASE}/admin/tests/mock/${F.l1}/live-monitor`);
  const relTiles = (await adm.getByTestId("live-monitor-summary").innerText()).replace(/\s+/g, " ");
  const relRows = (await adm.getByTestId("live-monitor-table").innerText()).replace(/\s+/g, " ");
  check("monitor after release: 3 completed, scores + ranks shown, nothing Held", /\b3 Completed/.test(relTiles) && !/Held/.test(relRows) && /\d+(\.\d+)? \/ \d+/.test(relRows) && /Released to students · 3 ranked/.test(await adm.locator("main").innerText()), relTiles);
  await adm.screenshot({ path: `${SHOTS}/admin-monitor-released.png`, fullPage: true });
  await adm.goto(`${BASE}/admin/tests/mock/${F.l1}#live`);
  check("admin: Enrolled Students: 4", (await adm.getByTestId("admin-enrolled-count").innerText()).includes("4"));
  check("admin: shareable link is the student test URL", (await adm.locator("#shareUrl").inputValue()).endsWith(`/student/test-series/${F.l1}`));
  check("admin: Live CBT summary groups start/end/attempts/result release", /Start:[\s\S]*End:[\s\S]*Single attempt[\s\S]*After test window closes/.test(await adm.getByTestId("live-cbt-summary").innerText()));
  await adm.locator("#live input[name=showEnrolledCount]").uncheck();
  await adm.locator("#live").getByRole("button", { name: "Save Enrollment" }).click();
  await adm.locator("#live").getByText("Saved.").waitFor();
  check("admin: enrollment settings saved", sql(`select "showEnrolledCount" from "MockTest" where id='${F.l1}'`) === "f");
  await adm.screenshot({ path: `${SHOTS}/admin-live-card.png`, fullPage: false });
  await adm.goto(`${BASE}/admin/tests/mock/${F.l3}#schedule`);
  await adm.locator("#schedule input[name=availabilityMode][value=FIXED_WINDOW]").check();
  const fmt = (ms) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 16);
  await adm.locator("#schedule input[name=availableFrom]").fill(fmt(Date.now() + 864e5));
  await adm.locator("#schedule input[name=availableUntil]").fill(fmt(Date.now() + 864e5 + 7200_000));
  await adm.locator("#schedule").getByRole("button", { name: /Save/ }).click();
  await adm.locator("#schedule").getByText("Saved.").waitFor();
  check("Fixed Window save → Single Attempt + Result after window (live defaults)", sql(`select "attemptPolicy"||','||"resultReleaseMode" from "MockTest" where id='${F.l3}'`) === "SINGLE_ATTEMPT,AFTER_WINDOW");
  check("ordinary mock defaults untouched", sql(`select "attemptPolicy"||','||"resultReleaseMode" from "MockTest" where id='${F.l2}'`) === "MULTIPLE_PRACTICE,IMMEDIATE");
} finally {
  await browser.close();
}
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
