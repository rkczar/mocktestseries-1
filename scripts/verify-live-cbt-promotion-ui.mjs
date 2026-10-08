/**
 * Live CBT promotion + sharing + start fix, end-to-end in real browsers
 * against a local production build on a DISPOSABLE database (fixture:
 * scripts/live-cbt-ui-fixture.ts, run `setup` fresh before this script).
 *
 *   admin turns on Promote + Sharing (+ promo text) → anonymous visitor opens
 *   the public invitation (360 px) → Share menu (WhatsApp / Telegram / Copy)
 *   → Student A enrolls from the dashboard card (countdown, no duplicate Next
 *   Test card) → Student B registers through the invitation and lands back on
 *   the same test → the card flips to LIVE without a reload → A enters from
 *   the dashboard, refreshes, resumes the SAME attempt → B (mobile) starts
 *   with a double click → two tabs start at once (one attempt) → monitor
 *   holds scores → submit / auto-submit / sweep → results released → card
 *   COMPLETED + View Result → promotion OFF / sharing OFF / unpublish hide it
 *   → the 7 Oct incident configuration still reaches the player and the admin
 *   page warns about it. Console errors, page errors and 5xx are collected.
 *
 *   BASE=http://localhost:3121 FIXTURE=<lcb.json> DATABASE_URL=<scratch> SHOTS=<dir> \
 *     NODE_PATH=<dir containing playwright> node scripts/verify-live-cbt-promotion-ui.mjs
 */
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://localhost:3121";
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const SHOTS = process.env.SHOTS ?? "/tmp/lcb-promo-shots";
mkdirSync(SHOTS, { recursive: true });
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
const DB = process.env.DATABASE_URL.replace(/\?schema=public$/, "");
const sql = (q) => execFileSync("psql", [DB, "-Atc", q], { encoding: "utf8" }).trim();
const testPath = `/student/test-series/${F.l1}`;
const invitePath = `/live-cbt/${F.l1}`;
const attemptsOf = (studentId) => sql(`select count(*) from "TestAttempt" where "mockTestId"='${F.l1}' and "studentId"='${studentId}'`);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const problems = [];
function watch(page, who) {
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) problems.push(`${who} console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => problems.push(`${who} pageerror: ${e.message.slice(0, 200)}`));
  page.on("response", (r) => r.status() >= 500 && problems.push(`${who} ${r.status()} ${r.url()}`));
  return page;
}
async function login(page, email) {
  await page.goto(`${BASE}/login`);
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
/** After a Start/Enter click: wait for the player (an intermediate instructions page has its own Start Test link). */
async function reachPlayer(page) {
  await page.waitForURL(/\/student\/attempt\/[^/]+(\/run)?$/, { timeout: 30000 });
  if (!page.url().endsWith("/run")) await page.getByRole("link", { name: "Start Test" }).click();
  await page.waitForSelector("[data-testid=test-player]", { timeout: 30000 });
  return page.url().split("/").at(-2);
}
async function dashboard(page) {
  await page.goto(`${BASE}/student/dashboard`);
  await page.waitForLoadState("networkidle");
  return page.getByTestId("live-cbt-promotion");
}

// Fresh window: opens ~85 s from now, lasts 150 s; results after the window.
const startAt = Date.now() + 85_000;
const endAt = startAt + 150_000;
sql(`update "MockTest" set "availableFrom"=to_timestamp(${startAt / 1000}), "availableUntil"=to_timestamp(${endAt / 1000}), "promoteOnDashboard"=false, "allowSharing"=false, "promoText"=null where id='${F.l1}'`);
console.log(`window: ${new Date(startAt).toISOString()} → ${new Date(endAt).toISOString()}`);

const browser = await chromium.launch();
try {
  const admCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const deskA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mobB = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  const tabsCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await mobB.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  const adm = watch(await admCtx.newPage(), "admin");
  const a = watch(await deskA.newPage(), "A");
  const b = watch(await mobB.newPage(), "B");

  console.log("\nAdmin promotion controls");
  await adm.goto(`${BASE}/admin/login`);
  await adm.fill("input[name=username]", F.adminUsername);
  await adm.fill("input[name=password]", F.password);
  await Promise.all([adm.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), adm.locator("form button[type=submit]").click()]);
  await adm.goto(`${BASE}/admin/tests/mock/${F.l1}#live`);
  check("admin: Promote / Sharing OFF by default", !(await adm.getByTestId("promote-on-dashboard").isChecked()) && !(await adm.getByTestId("allow-sharing").isChecked()));
  await a.goto(`${BASE}${invitePath}`).catch(() => {});
  check("sharing OFF → invitation page is 404", /could not be found|404/i.test(await a.locator("body").innerText()));
  await adm.getByTestId("promote-on-dashboard").check();
  await adm.getByTestId("allow-sharing").check();
  await adm.fill("#promoText", "Full-length QA Live CBT — compete in real time");
  await adm.locator("#live").getByRole("button", { name: "Save Enrollment" }).click();
  await adm.locator("#live").getByText("Saved.").waitFor();
  check("admin: saved Promote + Sharing + promo text", sql(`select "promoteOnDashboard"||','||"allowSharing"||','||"promoText" from "MockTest" where id='${F.l1}'`) === "true,true,Full-length QA Live CBT — compete in real time");
  await adm.reload();
  check("admin: share field is now the public invitation link", (await adm.locator("#shareUrl").inputValue()).endsWith(invitePath));
  await adm.locator("#live").screenshot({ path: `${SHOTS}/admin-promotion-controls.png` });

  console.log("\nPublic invitation — anonymous, 360 px");
  const res = await b.goto(`${BASE}${invitePath}`);
  check("anonymous visitor: 200, not redirected to login", res?.status() === 200 && new URL(b.url()).pathname === invitePath, [res?.status(), b.url()]);
  const inv = await b.getByTestId("live-cbt-invitation").innerText();
  check("invitation: title, exam, IST date + time, explanation, promo text", inv.includes("QALCB Live CBT") && inv.includes(F.examName) && /IST/.test(await b.getByTestId("invite-time").innerText()) && /What is a Live CBT/.test(inv) && inv.includes("compete in real time"));
  check("invitation: no student / question data", !inv.includes("@example.test") && (await b.locator("[data-testid=option]").count()) === 0);
  check("invitation: og:title + noindex", (await b.locator('meta[property="og:title"]').getAttribute("content"))?.includes("Live CBT") && /noindex/.test((await b.locator('meta[name="robots"]').getAttribute("content")) ?? ""));
  check("invitation: no horizontal scroll at 360 px", (await overflow(b)) <= 0);
  await b.screenshot({ path: `${SHOTS}/mobile-invitation-anon.png`, fullPage: true });
  await b.getByTestId("live-cbt-share-button").click();
  await b.getByTestId("live-cbt-share-menu").waitFor();
  const wa = decodeURIComponent((await b.getByTestId("share-whatsapp").getAttribute("href")).split("text=")[1]);
  check("WhatsApp message: test, IST date/time, invitation URL, brand; nothing private", wa.includes("LIVE CBT") && wa.includes("Test: QALCB Live CBT") && /Time: .* IST/.test(wa) && wa.includes(invitePath) && wa.includes("MockTestSeries.in") && !/@|attempt/i.test(wa), wa);
  const tg = await b.getByTestId("share-telegram").getAttribute("href");
  check("Telegram link carries the invitation URL", decodeURIComponent(tg).includes(invitePath));
  await b.screenshot({ path: `${SHOTS}/mobile-share-menu.png` });
  await b.getByTestId("share-copy").click();
  await b.getByText("Link copied").waitFor();
  check("Copy Link copies the invitation URL", (await b.evaluate(() => navigator.clipboard.readText())).endsWith(invitePath));
  check("invitation CTA → login/register with the test as callback", decodeURIComponent((await b.getByTestId("invite-cta").getAttribute("href")) ?? "").includes(`callbackUrl=${testPath}`));

  console.log("\nStudent A — dashboard promotion (upcoming)");
  await login(a, F.students.viewer.email);
  let card = await dashboard(a);
  check("card sits above every other dashboard section", await a.evaluate(() => {
    const top = document.querySelector("[data-testid=live-cbt-promotion]")?.getBoundingClientRect().top;
    const others = [...document.querySelectorAll("[data-dashboard-group]")].filter((s) => !s.querySelector("[data-testid=live-cbt-promotion]"));
    return top !== undefined && others.length > 0 && others.every((s) => s.getBoundingClientRect().top > top);
  }));
  check("UPCOMING + not enrolled → Enroll Now, LIVE CBT badge, countdown, share", (await card.getAttribute("data-state")) === "UPCOMING" && (await card.getByTestId("promo-enroll").count()) === 1 && (await card.getByTestId("promo-badge").count()) === 1 && /^\d\d:\d\d:\d\d$/.test(await card.getByTestId("promo-countdown").innerText()) && (await card.getByTestId("live-cbt-share-button").count()) === 1);
  check("card shows date, IST time, duration, questions, promo text", /IST/.test(await card.getByTestId("promo-time").innerText()) && /min/.test(await card.innerText()) && (await card.innerText()).includes("compete in real time"));
  check("no duplicate Next Test card for the same test", (await a.getByText(/Test Schedule · Next Test/i).count()) === 0 || !(await a.locator("main").innerText()).match(/Next Test[\s\S]*QALCB Live CBT/));
  await card.screenshot({ path: `${SHOTS}/desktop-card-upcoming.png` });
  const before = attemptsOf(F.students.viewer.id);
  await card.getByTestId("promo-enroll").click();
  await card.getByTestId("promo-enrolled").waitFor({ timeout: 15000 });
  check("Enroll Now → Enrolled + View Live Test; one enrollment row; no attempt", (await card.getByTestId("promo-primary").innerText()).includes("View Live Test") && sql(`select count(*) from "MockTestEnrollment" where "mockTestId"='${F.l1}' and "studentId"='${F.students.viewer.id}'`) === "1" && attemptsOf(F.students.viewer.id) === before);
  const c1 = await card.getByTestId("promo-countdown").innerText();
  await a.waitForTimeout(2100);
  check(`countdown ticks (${c1} → ${await card.getByTestId("promo-countdown").innerText()})`, c1 !== (await card.getByTestId("promo-countdown").innerText()));
  await a.reload();
  card = a.getByTestId("live-cbt-promotion");
  check("after refresh still Enrolled (no stale state)", (await card.getAttribute("data-enrolled")) === "true");
  await card.screenshot({ path: `${SHOTS}/desktop-card-enrolled.png` });

  console.log("\nStudent B — register through the invitation (mobile)");
  await b.getByTestId("invite-cta").click();
  await b.waitForURL(/\/login/);
  await b.getByText(/Create Account/).first().click().catch(() => {});
  if (!(await b.locator("#reg-password").count())) await b.goto(`${BASE}/login?tab=register&callbackUrl=${encodeURIComponent(testPath)}`);
  await b.fill("#name", "Invited Student");
  await b.fill("#email", F.lateEmail);
  await b.fill("#mobile", "+919000007998");
  await b.fill("#reg-password", F.password);
  await b.fill("#confirmPassword", F.password);
  await b.locator("input[name=acceptTerms]").check();
  await b.getByRole("button", { name: /Create Account/ }).last().click();
  await b.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 });
  check("after registration B is back on the SAME Live CBT test page", new URL(b.url()).pathname === testPath, b.url());
  const bId = sql(`select id from "Student" where email='${F.lateEmail}'`);
  check("test page has a Share button (before enrollment)", (await b.getByTestId("live-cbt-share-button").count()) === 1);
  await b.getByTestId("enroll-button").click();
  await b.getByTestId("enrolled-badge").waitFor({ timeout: 15000 });
  check("B enrolled; no attempt", attemptsOf(bId) === "0");
  await b.goto(`${BASE}${invitePath}`);
  check("signed-in visitor on the invitation → Enroll Now goes to the test page", (await b.getByTestId("invite-cta").getAttribute("href")) === testPath);

  // Student "early": enrolled out of band, used for the two-tab race.
  sql(`insert into "MockTestEnrollment"(id,"mockTestId","studentId") values ('qa-promo-${Date.now()}','${F.l1}','${F.students.early.id}') on conflict do nothing`);
  const t1 = watch(await tabsCtx.newPage(), "tab1");
  await login(t1, F.students.early.email);
  const t2 = watch(await tabsCtx.newPage(), "tab2");
  await Promise.all([t1.goto(`${BASE}${testPath}`), t2.goto(`${BASE}${testPath}`)]);

  console.log("\nStart time arrives (dashboard stays open)");
  await a.goto(`${BASE}/student/dashboard`);
  await a.evaluate(() => (window.__noReload = 1));
  card = a.getByTestId("live-cbt-promotion");
  await card.getByRole("button", { name: /Enter Live Test/ }).waitFor({ timeout: 150000 });
  check("card flipped to LIVE + Enter Live Test without a reload, not before startAt", (await a.evaluate(() => window.__noReload)) === 1 && Date.now() >= startAt - 1500 && (await card.getAttribute("data-state")) === "LIVE");
  check("live card shows window-closes countdown", /^\d\d:\d\d:\d\d$/.test(await card.getByTestId("promo-ends-in").innerText()));
  await card.screenshot({ path: `${SHOTS}/desktop-card-live.png` });
  await card.getByRole("button", { name: /Enter Live Test/ }).click();
  const aAttempt = await reachPlayer(a);
  check("A: dashboard Enter Live Test → real player, exactly one attempt", attemptsOf(F.students.viewer.id) === "1");
  check("A: attempt is fixed EXAM mode with the admin duration", sql(`select "answerMode"||','||"durationMinutes" from "TestAttempt" where id='${aAttempt}'`) === "EXAM,10", sql(`select "entryMode"||','||"answerMode"||','||"durationMinutes" from "TestAttempt" where id='${aAttempt}'`));
  await answer(a, 2);
  await a.reload();
  await a.waitForSelector("[data-testid=test-player]");
  check("A: refresh during the exam keeps the same attempt", a.url().includes(aAttempt));
  card = await dashboard(a);
  check("A: dashboard now offers Resume Live Test", (await card.getByRole("button", { name: /Resume Live Test/ }).count()) === 1);
  await card.getByRole("button", { name: /Resume Live Test/ }).click();
  check("A: Resume → the SAME attempt (still one)", (await reachPlayer(a)) === aAttempt && attemptsOf(F.students.viewer.id) === "1");
  check("A: saved answers survived (2)", sql(`select count(*) from "Answer" where "attemptId"='${aAttempt}' and "selectedOptionLabel" is not null`) === "2");

  console.log("\nB (mobile) double-clicks Start; two tabs race");
  await b.goto(`${BASE}${testPath}`);
  const bStart = b.getByRole("button", { name: /Start Live Test/ });
  await bStart.waitFor({ timeout: 30000 });
  await bStart.dblclick();
  const bAttempt = await reachPlayer(b);
  check("B: double click → one attempt, real player", attemptsOf(bId) === "1");
  check("B: player fits 360 px", (await overflow(b)) <= 0);
  await b.screenshot({ path: `${SHOTS}/mobile-player.png` });
  await t1.reload();
  await t2.reload();
  await Promise.all([t1.getByRole("button", { name: /Start Live Test/ }).click(), t2.getByRole("button", { name: /Start Live Test/ }).click()]);
  const [x1, x2] = await Promise.all([reachPlayer(t1), reachPlayer(t2)]);
  check("two tabs started at once → one attempt, both in the same player", x1 === x2 && attemptsOf(F.students.early.id) === "1", [x1, x2]);
  await answer(t1, 1);

  console.log("\nB submits early — everything held");
  await answer(b, 1);
  await b.getByRole("button", { name: "Submit Test" }).first().click();
  await b.getByRole("dialog").getByRole("button", { name: "Submit Test" }).click();
  await b.waitForURL(/\/result$/, { timeout: 30000 });
  check("B: Result Pending, no score / rank before release", /Result Pending/i.test(await b.locator("body").innerText()) && (await b.getByTestId("rank-summary").count()) === 0);
  await b.goto(`${BASE}/student/attempt/${bAttempt}/review`);
  check("B: review locked", /Answer review isn.t available yet/i.test(await b.locator("body").innerText()));
  await b.goto(`${BASE}/student/attempt/${bAttempt}/leaderboard`);
  check("B: leaderboard locked", b.url().endsWith(`/student/attempt/${bAttempt}/result`), b.url());
  const bCard = await dashboard(b);
  check("B: dashboard card COMPLETED + Result Pending (no share)", (await bCard.getAttribute("data-state")) === "COMPLETED" && /Result Pending/.test(await bCard.getByTestId("promo-primary").innerText()) && (await bCard.getByTestId("live-cbt-share-button").count()) === 0);
  check("B: dashboard at 360 px has no horizontal scroll", (await overflow(b)) <= 0);
  await bCard.screenshot({ path: `${SHOTS}/mobile-card-result-pending.png` });

  console.log("\nAdmin monitor while held");
  await adm.goto(`${BASE}/admin/tests/mock/${F.l1}/live-monitor`);
  const tiles = (await adm.getByTestId("live-monitor-summary").innerText()).replace(/\s+/g, " ");
  const rows = (await adm.getByTestId("live-monitor-table").innerText()).replace(/\s+/g, " ");
  check("monitor: 3 enrolled, 3 started, 1 submitted; scores Held; read-only", /\b3 Enrolled/.test(tiles) && /\b3 Started/.test(tiles) && /\b1 Submitted by student/.test(tiles) && /Held/.test(rows) && (await adm.locator("main form").count()) === 0, tiles);
  await adm.screenshot({ path: `${SHOTS}/admin-monitor-held.png`, fullPage: true });

  console.log("\nWindow end: A auto-submits in the open browser; the early tabs are swept");
  await a.waitForURL(/\/result$/, { timeout: endAt - Date.now() + 30000 });
  check("A: auto-submitted at the window end", Date.now() >= endAt - 1500 && sql(`select status from "TestAttempt" where id='${aAttempt}'`) === "SUBMITTED");
  await tabsCtx.close();
  execFileSync("npx", ["--no-install", "tsx", "scripts/finalize-live-attempts.ts", "--once"], { env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" }, stdio: "inherit" });
  check("sweep finalized the two-tab attempt", sql(`select status from "TestAttempt" where id='${x1}'`) === "SUBMITTED");
  const late = await a.evaluate(async (id) => (await fetch(`/student/attempt/resume?mockTest=${id}`)).url, F.l1);
  check("after endAt: no new attempt", attemptsOf(F.students.viewer.id) === "1", late);

  console.log("\nAfter release");
  await a.reload();
  check("A: result released with rank (3 ranked)", (await a.getByTestId("rank-summary").count()) === 1 && (await a.getByTestId("rank-value").innerText()).includes("/ 3"));
  await a.goto(`${BASE}/student/attempt/${aAttempt}/leaderboard`);
  check("A: leaderboard shows 3 participants", (await a.getByText("3 ranked participants").count()) === 1);
  card = await dashboard(a);
  check("A: dashboard card COMPLETED + View Result → this attempt", (await card.getAttribute("data-state")) === "COMPLETED" && (await card.getByTestId("promo-primary").getAttribute("href")) === `/student/attempt/${aAttempt}/result`);
  await card.screenshot({ path: `${SHOTS}/desktop-card-completed.png` });
  await b.goto(`${BASE}${invitePath}`);
  check("invitation after the end: Ended, no Share, CTA disabled", (await b.getByTestId("live-cbt-invitation").getAttribute("data-phase")) === "CLOSED" && (await b.getByTestId("live-cbt-share-button").count()) === 0 && (await b.getByTestId("invite-cta").isDisabled()));
  await adm.reload();
  check("monitor after release: scores shown, nothing Held", !/Held/.test((await adm.getByTestId("live-monitor-table").innerText())));

  console.log("\nPromotion OFF / sharing OFF / unpublished");
  const fresh = Date.now() + 3600_000;
  sql(`update "MockTest" set "availableFrom"=to_timestamp(${fresh / 1000}), "availableUntil"=to_timestamp(${fresh / 1000 + 3600}) where id='${F.l2}'`);
  sql(`update "MockTest" set "promoteOnDashboard"=true, "allowSharing"=true, "enrollmentEnabled"=true where id='${F.l2}'`);
  card = await dashboard(a);
  check("a newer upcoming promoted test takes the card over A's completed one", (await card.count()) === 1 && (await card.getAttribute("data-state")) === "UPCOMING" && (await card.getByTestId("promo-title").innerText()).includes("QALCB Ordinary"));
  sql(`update "MockTest" set "promoteOnDashboard"=false where id in ('${F.l1}','${F.l2}')`);
  await dashboard(a);
  check("promotion OFF → no card (no empty card)", (await a.getByTestId("live-cbt-promotion").count()) === 0);
  sql(`update "MockTest" set "promoteOnDashboard"=true, status='DRAFT' where id='${F.l2}'`);
  await dashboard(b);
  check("unpublished test → not promoted", !(await b.locator("main").innerText()).includes("QALCB Ordinary"));
  await b.goto(`${BASE}/live-cbt/${F.l2}`);
  check("unpublished test → invitation 404", /could not be found|404/i.test(await b.locator("body").innerText()));
  sql(`update "MockTest" set status='PUBLISHED', "allowSharing"=false where id='${F.l2}'`);
  await b.goto(`${BASE}/live-cbt/${F.l2}`);
  check("sharing OFF → invitation 404", /could not be found|404/i.test(await b.locator("body").innerText()));
  sql(`update "MockTest" set "availableFrom"=null, "availableUntil"=null, "promoteOnDashboard"=false, "enrollmentEnabled"=false where id='${F.l2}'`);

  console.log("\n7 Oct incident configuration (enrollment ON, Scheduled Release, Immediate result)");
  sql(`delete from "TestAttempt" where "mockTestId"='${F.l3}'`);
  sql(`update "MockTest" set "availableFrom"=now()-interval '1 minute', "availableUntil"=null, "resultReleaseMode"='IMMEDIATE', "attemptPolicy"='SINGLE_ATTEMPT', "enrollmentEnabled"=true where id='${F.l3}'`);
  sql(`insert into "MockTestEnrollment"(id,"mockTestId","studentId") values ('qa-inc-${Date.now()}','${F.l3}','${F.students.viewer.id}') on conflict do nothing`);
  await a.goto(`${BASE}/student/test-series/${F.l3}`);
  await a.getByRole("button", { name: /Start Live Test/ }).click();
  await reachPlayer(a);
  check("incident config: one click → real player, one attempt", sql(`select count(*) from "TestAttempt" where "mockTestId"='${F.l3}'`) === "1");
  await adm.goto(`${BASE}/admin/tests/mock/${F.l3}#live`);
  check("admin warns: enrollment ON without a Fixed Window", (await adm.getByTestId("enrollment-without-window").count()) === 1);
  await adm.getByTestId("enrollment-without-window").screenshot({ path: `${SHOTS}/admin-incident-warning.png` });
} finally {
  await browser.close();
}
console.log("\nBrowser problems (console errors, page errors, 5xx):");
for (const p of problems) console.log(`  ${p}`);
check("no console errors, page errors or 5xx", problems.length === 0, problems.length);
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
