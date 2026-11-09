/**
 * TEACHER LOGIN — real-browser regression (username/password OR registered-mobile OTP).
 *
 * LOCAL production build + DISPOSABLE mts_* database, MSG91 replaced by
 * scripts/msg91-widget-mock.mjs (no real SMS; codes land in MSG91_MOCK_FILE):
 *
 *   DATABASE_URL=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/teacher-login-http-fixture.ts setup > <tmp>/tlh.json
 *   MSG91_MOCK_FILE=<tmp>/msg91.json MSG91_AUTH_KEY=mock MSG91_WIDGET_ID=mock NODE_OPTIONS="--import ./scripts/msg91-widget-mock.mjs" \
 *     DATABASE_URL=<scratch> NEXTAUTH_URL=http://localhost:<p> AUTH_URL=http://localhost:<p> npx next start -p <p> > <tmp>/server.log 2>&1 &
 *   BASE=http://localhost:<p> FIXTURE=<tmp>/tlh.json MSG91_MOCK_FILE=<tmp>/msg91.json SERVER_LOG=<tmp>/server.log DATABASE_URL=<scratch> \
 *     NODE_PATH=<dir containing playwright> node scripts/verify-teacher-login-http.mjs
 */
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "";
if (!/^http:\/\/localhost:\d+$/.test(BASE)) throw new Error("BASE must be http://localhost:<port> (local scratch server)");
const F = JSON.parse(readFileSync(process.env.FIXTURE, "utf8"));
const MOCK = process.env.MSG91_MOCK_FILE;
if (!MOCK) throw new Error("MSG91_MOCK_FILE is required");
const DBURL = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "");
if (!/\/mts_[a-z0-9_]+$/.test(DBURL)) throw new Error("DATABASE_URL must be the scratch mts_* database the server uses");
const sql = (q) => execFileSync("psql", [DBURL, "-Atc", q], { encoding: "utf8" }).trim();

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ""}`);
  if (ok) pass++;
  else fail++;
};
const section = (t) => console.log(`\n== ${t}`);
/** Our form messages (Next.js's route announcer is also role="alert"). */
const ALERT = 'p[role="alert"]';
const path = (page) => new URL(page.url()).pathname;
const mock = () => { try { return JSON.parse(readFileSync(MOCK, "utf8")); } catch { return { requests: {}, latest: {} }; } };
const sentTo = (digits) => Object.values(mock().requests).filter((r) => r.identifier === `91${digits}`).length;
const latestCode = (digits) => mock().latest[`91${digits}`]?.code;
const rnd = (lead) => `${lead}${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
/** Same as waiting 60 s: moves earlier teacher sends past the resend cooldown / 15-min cap. */
const coolDown = (digits) => sql(`update "OtpRequest" set "lastSentAt" = now() - interval '61 seconds', "createdAt" = now() - interval '16 minutes' where mobile = '+91${digits}' and purpose = 'TEACHER_LOGIN'`);
const forgive = (digits) => sql(`delete from "LoginAttempt" where username = 'otp:+91${digits}'`);

writeFileSync(MOCK, JSON.stringify({ requests: {}, latest: {} }));
const browser = await chromium.launch();
const ctx = async (mobile = false) => {
  const c = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
  const page = await c.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { c, page, errors };
};

/** Waits until the submit in flight (its pending label) has finished. */
async function settle(page, pendingLabel) {
  await page.getByRole("button", { name: pendingLabel }).waitFor({ timeout: 3000 }).catch(() => {});
  await page.getByRole("button", { name: pendingLabel }).waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
}
async function passwordLogin(page, username, password) {
  await page.goto(`${BASE}/teacher`);
  await page.getByRole("tab", { name: "Username & Password" }).click();
  await page.fill("#teacher-username", username);
  await page.fill("#teacher-password", password);
  await page.getByRole("button", { name: "Login" }).click();
  await settle(page, "Signing in…");
  await page.getByText("Welcome,").or(page.locator(ALERT)).first().waitFor({ timeout: 30000 }).catch(() => {});
}
async function sendOtp(page, digits) {
  await page.goto(`${BASE}/teacher`);
  await page.getByRole("tab", { name: "Login with OTP" }).click();
  await page.fill("#teacher-mobile", digits);
  await page.getByRole("button", { name: "Send OTP" }).click();
  await settle(page, "Sending…");
  await page.locator("#teacher-otp").or(page.locator(ALERT)).first().waitFor({ timeout: 20000 });
}
async function enterOtp(page, code) {
  await page.fill("#teacher-otp", code);
  await page.getByRole("button", { name: "Verify & Login" }).click();
  await settle(page, "Verifying…");
  await page.getByText("Welcome,").or(page.locator(ALERT)).first().waitFor({ timeout: 30000 }).catch(() => {});
}
const welcome = (page) => page.getByText("Welcome,").isVisible().catch(() => false);
const alertText = async (page) => (await page.locator(ALERT).allInnerTexts().catch(() => [])).join(" | ");

// ------------------------------------------------------------------ Master Admin creates teachers
section("A. Master Admin → Users & Access → Teachers → Add teacher");
const MA = await ctx();
MA.page.on("dialog", (d) => d.accept());
await MA.page.goto(`${BASE}/admin/login`);
await MA.page.fill('input[name="username"]', F.master.username);
await MA.page.fill('input[name="password"]', F.master.password);
await Promise.all([MA.page.waitForURL((u) => !u.pathname.startsWith("/admin/login"), { timeout: 30000 }), MA.page.click('button[type="submit"]')]);
check("Admin login still works at /admin/login", path(MA.page).startsWith("/admin"), MA.page.url());

const T = { username: `tlh-t-${F.sfx}`, password: "tlh-teacher-pass-1", digits: rnd("9") };
const S = { username: `tlh-s-${F.sfx}`, password: "tlh-teacher-pass-2", digits: rnd("8") };
async function addTeacher(t, name, examName, status = "ACTIVE") {
  await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
  await MA.page.fill("#t-name", name);
  await MA.page.fill("#t-username", t.username);
  await MA.page.fill("#t-password", t.password);
  await MA.page.fill("#t-mobile", t.digits);
  await MA.page.selectOption("#t-status", status);
  await MA.page.getByLabel(examName, { exact: true }).check();
  await MA.page.getByRole("button", { name: "Create teacher" }).click();
  await MA.page.getByText(`Teacher ${t.username} created.`).waitFor({ timeout: 20000 }).catch(() => {});
}
await addTeacher(T, "TLH Teacher T", F.examX.name);
check("form creates teacher with mobile + exam", sql(`select p.mobile || '|' || p.status || '|' || (select count(*) from "TeacherExamAssignment" a where a."teacherId" = u.id and a."examId" = '${F.examX.id}' and a."revokedAt" is null) from "AdminUser" u join "TeacherProfile" p on p."adminUserId" = u.id where u.username = '${T.username}'`) === `+91${T.digits}|ACTIVE|1`);
await addTeacher(S, "TLH Teacher S", F.examY.name, "SUSPENDED");
check("form can create a Suspended teacher", sql(`select p.status from "AdminUser" u join "TeacherProfile" p on p."adminUserId" = u.id where u.username = '${S.username}'`) === "SUSPENDED");
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
check("teacher list shows the masked mobile, 'not verified — OTP login off'", (await MA.page.getByText(`+91 ******${T.digits.slice(-4)}`).count()) > 0 && (await MA.page.getByText("not verified — OTP login off").count()) >= 2);

// ------------------------------------------------------------------ Teacher Login page
section("B. /teacher — dedicated Teacher Login");
const V = await ctx(true);
const res = await V.page.goto(`${BASE}/teacher`);
check("signed-out /teacher → 200, URL stays /teacher", res?.status() === 200 && path(V.page) === "/teacher", `${res?.status()} ${V.page.url()}`);
// Same headers as production nginx (the 2026-11-09 rewrite bug only showed behind them).
const behindNginx = await new Promise((resolve, reject) => {
  http.get(`${BASE}/teacher`, { headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "mocktestseries.in", Host: "mocktestseries.in" } }, (r) => {
    let body = "";
    r.on("data", (c) => (body += c));
    r.on("end", () => resolve({ status: r.statusCode, body }));
  }).on("error", reject);
});
check("behind nginx (X-Forwarded-Proto https): /teacher → 200 Teacher Login", behindNginx.status === 200 && behindNginx.body.includes("Teacher Login"), behindNginx.status);
check("heading 'Teacher Login'", await V.page.getByRole("heading", { name: "Teacher Login" }).isVisible());
check("two tabs: Username & Password, Login with OTP", (await V.page.getByRole("tab", { name: "Username & Password" }).isVisible()) && (await V.page.getByRole("tab", { name: "Login with OTP" }).isVisible()));
check("no registration / sign-up link", (await V.page.getByRole("link", { name: /register|sign ?up|create account/i }).count()) === 0);
check("not the Admin login interface", (await V.page.getByText("Admin Control Center").count()) === 0 && (await V.page.getByText("Admin ID / Username").count()) === 0);
check("mobile width: no horizontal scroll", await V.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await V.page.goto(`${BASE}/teacher/students`);
check("signed-out deep link → back to /teacher (login)", path(V.page) === "/teacher" && (await V.page.getByRole("heading", { name: "Teacher Login" }).isVisible()));
for (const p of ["/teacher/register", "/teacher/signup"]) {
  await V.page.goto(`${BASE}${p}`);
  check(`no public registration at ${p}`, path(V.page) === "/teacher" && (await V.page.getByRole("heading", { name: "Teacher Login" }).isVisible()));
}

// ------------------------------------------------------------------ Username & Password
section("C. Username & Password");
const A = await ctx();
await passwordLogin(A.page, T.username, "wrong-password-x");
check("invalid password → error, stays on login", (await alertText(A.page)).includes("Invalid username or password.") && !(await welcome(A.page)));
await passwordLogin(A.page, `nobody-${F.sfx}`, "whatever-pass");
check("unknown username → same error", (await alertText(A.page)).includes("Invalid username or password."));
await passwordLogin(A.page, F.master.username, F.master.password);
check("Master Admin can't sign in on the Teacher Login", (await alertText(A.page)).includes("Invalid username or password."));
await passwordLogin(A.page, S.username, S.password);
check("suspended teacher (right password) → inactive message", (await alertText(A.page)).includes("not active"));
await passwordLogin(A.page, T.username, T.password);
check("valid login → /teacher dashboard", path(A.page) === "/teacher" && (await welcome(A.page)), A.page.url());
const cookiesBefore = await A.c.cookies();
await A.page.goto(`${BASE}/admin`);
check("teacher session: /admin → back to /teacher", path(A.page) === "/teacher");
const api = await A.page.evaluate(async (u) => (await fetch(u)).status, `${BASE}/api/admin/backup/status`);
check("teacher session: Admin API refused (403)", api === 403, api);
await A.page.goto(`${BASE}/teacher/tests?exam=${F.examY.id}`);
check("unassigned exam via URL shows nothing of exam Y", (await A.page.getByText(F.examY.name).count()) === 0);
await A.page.goto(`${BASE}/teacher-login`);
check("signed-in teacher opening the login page → dashboard", path(A.page) === "/teacher" && (await welcome(A.page)));

// ------------------------------------------------------------------ Verify registered mobile (portal)
section("D. Registered-mobile verification");
await A.page.goto(`${BASE}/teacher`);
check("dashboard asks to verify the masked registered mobile", (await A.page.getByText(`Verify your registered mobile +91 ******${T.digits.slice(-4)}`).count()) === 1);
await A.page.getByRole("button", { name: "Send code" }).click();
await A.page.getByLabel("6-digit code").waitFor({ timeout: 20000 });
check("verification code went to the registered number only", sentTo(T.digits) === 1);
check("resend countdown shown", await A.page.getByRole("button", { name: /Resend code in \d+s/ }).isDisabled());
await A.page.getByLabel("6-digit code").fill(latestCode(T.digits));
await A.page.getByRole("button", { name: "Verify", exact: true }).click();
await A.page.getByText("Mobile verified").waitFor({ timeout: 20000 }).catch(() => {});
check("mobile verified → OTP login on", sql(`select "mobileVerifiedAt" is not null from "TeacherProfile" p join "AdminUser" u on u.id = p."adminUserId" where u.username = '${T.username}'`) === "t");

// ------------------------------------------------------------------ Logout & session
section("E. Logout");
await A.page.getByRole("button", { name: "Sign out" }).click();
await A.page.waitForURL((u) => u.pathname === "/teacher", { timeout: 20000 }).catch(() => {});
await A.page.getByRole("heading", { name: "Teacher Login" }).waitFor({ timeout: 20000 }).catch(() => {});
check("logout → Teacher Login", path(A.page) === "/teacher" && (await A.page.getByRole("heading", { name: "Teacher Login" }).isVisible()));
const R = await ctx();
await R.c.addCookies(cookiesBefore);
await R.page.goto(`${BASE}/teacher`);
check("replayed pre-logout cookie is dead", !(await welcome(R.page)) && (await R.page.getByRole("heading", { name: "Teacher Login" }).isVisible()), R.page.url());

// ------------------------------------------------------------------ Login with OTP
section("F. Login with OTP");
const O = await ctx(true);
await coolDown(T.digits);
const before = sentTo(T.digits);
await sendOtp(O.page, T.digits);
const info = await O.page.getByRole("status").first().innerText().catch(() => "");
check("registered verified mobile → code sent to that number", sentTo(T.digits) === before + 1);
check("generic 'if registered' wording", info.includes("If this number is registered"), info);
check("resend countdown on the login page", await O.page.getByRole("button", { name: /Resend OTP in \d+s/ }).isDisabled());
await enterOtp(O.page, latestCode(T.digits) === "000000" ? "111111" : "000000");
check("incorrect OTP → message, no login", (await alertText(O.page)).includes("Incorrect code.") && !(await welcome(O.page)));
const good = latestCode(T.digits);
await enterOtp(O.page, good);
check("correct OTP → /teacher dashboard (same teacher)", path(O.page) === "/teacher" && (await welcome(O.page)) && (await O.page.getByText("Welcome, TLH Teacher T").count()) === 1);
check("OTP login keeps exam scope (exam X listed, Y not)", (await O.page.getByText(F.examX.name).count()) > 0 && (await O.page.getByText(F.examY.name).count()) === 0);
const O2 = await ctx();
await O2.page.goto(`${BASE}/teacher`);
await O2.page.getByRole("tab", { name: "Login with OTP" }).click();
await O2.page.fill("#teacher-mobile", T.digits);
await O2.page.getByRole("button", { name: "Send OTP" }).click();
await O2.page.locator("#teacher-otp").waitFor({ timeout: 20000 });
await enterOtp(O2.page, good);
check("reused OTP refused", !(await welcome(O2.page)) && (await alertText(O2.page)).length > 0, await alertText(O2.page));
check("…and the resend inside 60 s sent nothing new", sentTo(T.digits) === before + 1);

// expired
await coolDown(T.digits);
const E = await ctx();
await sendOtp(E.page, T.digits);
sql(`update "OtpRequest" set "expiresAt" = now() - interval '1 second' where mobile = '+91${T.digits}' and purpose = 'TEACHER_LOGIN' and "consumedAt" is null`);
await enterOtp(E.page, latestCode(T.digits));
check("expired OTP → 'expired' message", (await alertText(E.page)).includes("expired"), await alertText(E.page));

// unregistered
section("G. Enumeration & rate limits");
const U = await ctx();
const stranger = rnd("7");
const t0 = Date.now();
await sendOtp(U.page, stranger);
const strangerInfo = await U.page.getByRole("status").first().innerText().catch(() => "");
check("unregistered number: same screen & wording as a registered one", strangerInfo === info, `${strangerInfo} vs ${info}`);
check("unregistered number: no SMS sent", sentTo(stranger) === 0);
check("answer padded (≥ 1.5 s)", Date.now() - t0 >= 1400);
await enterOtp(U.page, "123456");
check("unregistered verify → 'No pending … code' (same as registered without code)", (await alertText(U.page)).includes("No pending verification code"));
await sendOtp(U.page, "12345");
check("invalid number → validation message", (await alertText(U.page)).includes("valid 10-digit"));
await sendOtp(U.page, S.digits);
check("suspended teacher's number: no SMS", sentTo(S.digits) === 0);
// per-number lockout after repeated wrong codes
await coolDown(T.digits);
await forgive(T.digits);
const L = await ctx();
await sendOtp(L.page, T.digits);
const lockCode = latestCode(T.digits);
const wrongCode = lockCode === "000000" ? "111111" : "000000";
for (let i = 0; i < 5; i++) await enterOtp(L.page, wrongCode);
await enterOtp(L.page, lockCode);
check("5 wrong codes lock the challenge (right code refused after)", !(await welcome(L.page)) && /Too many/.test(await alertText(L.page)), await alertText(L.page));
await forgive(T.digits);

// ------------------------------------------------------------------ Suspend / change mobile
section("H. Master Admin: suspend, re-activate, change mobile");
const card = () => MA.page.locator("div").filter({ has: MA.page.locator(`text=@${T.username}`) }).filter({ has: MA.page.locator("button:has-text('Deactivate')") }).last();
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await card().locator("button:has-text('Suspend')").click();
await MA.page.waitForTimeout(1500);
await O.page.goto(`${BASE}/teacher`);
check("suspend: OTP-created session dies at once", !(await welcome(O.page)) && (await O.page.getByRole("heading", { name: "Teacher Login" }).isVisible()), O.page.url());
await coolDown(T.digits);
const sBefore = sentTo(T.digits);
const X = await ctx();
await sendOtp(X.page, T.digits);
check("suspend: no OTP sent to the suspended teacher", sentTo(T.digits) === sBefore);
await passwordLogin(X.page, T.username, T.password);
check("suspend: password login → inactive message", (await alertText(X.page)).includes("not active"));
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await card().getByRole("button", { name: "Activate", exact: true }).click();
await MA.page.waitForTimeout(1500);
const newDigits = rnd("6");
await MA.page.goto(`${BASE}/admin/users?tab=teachers`);
await card().getByLabel("New registered mobile").fill(newDigits);
await card().getByRole("button", { name: "Change mobile" }).click();
await MA.page.getByText("Registered mobile updated").waitFor({ timeout: 20000 }).catch(() => {});
check("mobile change saved + verification reset", sql(`select p.mobile || '|' || coalesce(p."mobileVerifiedAt"::text, 'null') from "TeacherProfile" p join "AdminUser" u on u.id = p."adminUserId" where u.username = '${T.username}'`) === `+91${newDigits}|null`);
check("mobile change audited (masked)", sql(`select count(*) from "AuditLog" where action = 'TEACHER_MOBILE_CHANGED' and metadata::text like '%******${newDigits.slice(-4)}%' and metadata::text not like '%${newDigits}%'`) === "1");
await coolDown(T.digits);
const oldBefore = sentTo(T.digits);
await sendOtp(X.page, T.digits);
check("old number: no OTP any more", sentTo(T.digits) === oldBefore);
await sendOtp(X.page, newDigits);
check("new unverified number: no OTP until verified", sentTo(newDigits) === 0);
await passwordLogin(X.page, T.username, T.password);
check("password login still works after re-activation", await welcome(X.page));
await X.page.getByRole("button", { name: "Send code" }).click();
await X.page.getByLabel("6-digit code").waitFor({ timeout: 20000 });
check("verification code goes to the NEW registered number", sentTo(newDigits) === 1);
await X.page.getByLabel("6-digit code").fill(latestCode(newDigits));
await X.page.getByRole("button", { name: "Verify", exact: true }).click();
await X.page.getByText("Mobile verified").waitFor({ timeout: 20000 }).catch(() => {});
await coolDown(newDigits);
const N = await ctx();
await sendOtp(N.page, newDigits);
await enterOtp(N.page, latestCode(newDigits));
check("new number after verification: OTP login works", await welcome(N.page));

// ------------------------------------------------------------------ Student login untouched
section("I. Student login unaffected");
const St = await ctx();
const sr = await St.page.goto(`${BASE}/login`);
check("/login → 200 student login", sr?.status() === 200 && (await St.page.getByText(/Teacher Login/).count()) === 0);
check("no OTP sent with purpose LOGIN by any teacher flow", sql(`select count(*) from "OtpRequest" where purpose <> 'TEACHER_LOGIN'`) === "0");
check("no OTP code in the server log", (() => { const log = process.env.SERVER_LOG ? readFileSync(process.env.SERVER_LOG, "utf8") : ""; return Object.values(mock().requests).every((r) => !new RegExp(`\\b${r.code}\\b`).test(log)); })());

const pageErrors = [MA, V, A, R, O, O2, E, U, L, X, N, St].flatMap((s) => s.errors);
check("no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
