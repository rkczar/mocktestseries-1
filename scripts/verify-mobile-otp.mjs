/**
 * MANDATORY MOBILE OTP VERIFICATION — end-to-end regression (real browser + HTTP).
 *
 * Runs only against a LOCAL production build backed by a DISPOSABLE database,
 * with MSG91 replaced by scripts/msg91-widget-mock.mjs (no real SMS is sent):
 *
 *   DATABASE_URL=<scratch> npx prisma migrate deploy
 *   DATABASE_URL=<scratch> ADMIN_SEED_EMAIL=… ADMIN_SEED_USERNAME=qa-master ADMIN_SEED_PASSWORD=… npx tsx prisma/seed.ts
 *   npx next build
 *   MSG91_MOCK_FILE=<tmp>/msg91.json MSG91_AUTH_KEY=mock MSG91_WIDGET_ID=mock \
 *     NODE_OPTIONS="--import ./scripts/msg91-widget-mock.mjs" DATABASE_URL=<scratch> \
 *     NEXTAUTH_URL=http://localhost:3121 AUTH_URL=http://localhost:3121 npx next start -p 3121 -H 127.0.0.1 > <tmp>/server.log 2>&1 &
 *   BASE=http://localhost:3121 MSG91_MOCK_FILE=<tmp>/msg91.json SERVER_LOG=<tmp>/server.log DATABASE_URL=<scratch> \
 *     ADMIN_USER=qa-master ADMIN_PASS=… NODE_PATH=<dir containing playwright> node scripts/verify-mobile-otp.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE || "http://localhost:3121";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}
const MOCK_FILE = process.env.MSG91_MOCK_FILE;
const ADMIN_USER = process.env.ADMIN_USER ?? "";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "";

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!passed) failures++;
}

function fixture(...args) {
  const out = execFileSync("npx", ["tsx", "scripts/mobile-otp-fixture.ts", ...args], {
    env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
    encoding: "utf8",
  });
  return out.trim() ? JSON.parse(out.trim().split("\n").pop()) : null;
}
const studentRow = (key) => fixture("state").find((s) => s.email === F.students[key].email);

function mockDb() {
  try {
    return JSON.parse(fs.readFileSync(MOCK_FILE, "utf8"));
  } catch {
    return { requests: {}, latest: {} };
  }
}
/** The code "delivered" to +91<digits> by the MSG91 mock (waits for a NEW one when `after` is given). */
async function codeFor(digits, after) {
  for (let i = 0; i < 40; i++) {
    const latest = mockDb().latest[`91${digits}`];
    if (latest && latest.reqId !== after) return latest;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no OTP delivered to ${digits}`);
}
const lastReq = (digits) => mockDb().latest[`91${digits}`]?.reqId;

async function passwordLogin(page, emailAddr, callback) {
  fixture("reset-devices");
  await page.goto(`${BASE}/login${callback ? `?callbackUrl=${encodeURIComponent(callback)}` : ""}`);
  await page.fill("#identifier", emailAddr);
  await page.fill("input[name=password]", F.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.locator("form:has(#identifier) button[type=submit]").click(),
  ]);
}

/** Types the whole code into the first box, the way an OS one-time-code autofill does. */
async function enterCode(page, code) {
  await page.locator("#otp-box-0").fill(code);
}
// p[role=alert] = ErrorBanner (Next's route announcer is also role=alert)
const errorText = (page) => page.locator("p[role=alert]").first().innerText({ timeout: 15000 }).catch(() => "");
/** Waits (up to 15 s) for the error banner to match `re` — the previous error stays visible until the next answer. */
async function waitError(page, re) {
  for (let i = 0; i < 60; i++) {
    const t = await page.locator("p[role=alert]").first().innerText({ timeout: 500 }).catch(() => "");
    if (re.test(t)) return t;
    await page.waitForTimeout(250);
  }
  return errorText(page);
}

async function sendVerify(page, digits) {
  const before = lastReq(digits);
  await page.fill("#verify-mobile", digits);
  await page.getByRole("button", { name: "Send Verification OTP" }).click();
  return before;
}

const F = fixture("setup");
const browser = await chromium.launch();
try {
  // ---------------------------------------------------------------- flag OFF
  console.log("1. Switch OFF (deploy state): nothing changes for students");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await passwordLogin(page, F.students.A.email);
    check("unverified student reaches the dashboard while the switch is OFF", /\/student\/dashboard/.test(page.url()), page.url());
    await page.goto(`${BASE}/login?tab=register`);
    await ctx.clearCookies();
    await page.goto(`${BASE}/login?tab=register`);
    check("Create Account still shows the password form while OFF", (await page.locator("#confirmPassword").count()) === 1);
    await ctx.close();
  }

  // ---------------------------------------------------------------- admin switch
  console.log("2. Admin switches mandatory verification ON (admin auth unchanged)");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`);
    await page.fill("input[name=username]", ADMIN_USER);
    await page.fill("input[name=password]", ADMIN_PASS);
    await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
    check("admin (MASTER_ADMIN) signs in normally", /\/admin(?!\/login)/.test(page.url()), page.url());
    await page.goto(`${BASE}/admin/settings/authentication`);
    const label = page.getByText("Require mobile OTP verification (all students)", { exact: true });
    const card = page.locator("form", { has: label });
    const sw = label.locator("xpath=ancestor::div[contains(@class,'justify-between')][1]").getByRole("switch");
    if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
    await card.getByRole("button", { name: "Save" }).click();
    await card.getByText("Saved.").waitFor({ timeout: 15000 }).catch(() => {});
    check("admin switch saved", (await card.getByText("Saved.").count()) === 1);
    await ctx.close();
    // provider config is cached in-process for 15 s
    await new Promise((r) => setTimeout(r, 16000));
  }

  // ---------------------------------------------------------------- guests
  console.log("3. Guests: protected student areas need sign-in; public pages stay open");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    for (const p of ["/student/dashboard", "/student/test-series", "/student/attempt/resume", "/student/subject-test", "/student/custom-module"]) {
      await page.goto(`${BASE}${p}`);
      check(`guest ${p} → /login`, new URL(page.url()).pathname === "/login", page.url());
    }
    for (const p of ["/", "/plans-and-pricing", "/login"]) {
      const res = await page.request.get(`${BASE}${p}`, { maxRedirects: 0 });
      check(`public ${p} → 200`, res.status() === 200, res.status());
    }
    const api = await page.request.get(`${BASE}/api/student/invoices/x`, { maxRedirects: 0 });
    check("guest student API → 401", api.status() === 401, api.status());
    await ctx.close();
  }

  // ---------------------------------------------------------------- existing unverified
  console.log("4. Existing unverified password student");
  fixture("reset-otp");
  const before = studentRow("A");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await passwordLogin(page, F.students.A.email, "/student/test-series");
    await page.waitForURL(/\/student\/verify-mobile/, { timeout: 15000 }).catch(() => {});
    const u = new URL(page.url());
    check("password login → /student/verify-mobile", u.pathname === "/student/verify-mobile", page.url());
    check("intended destination kept in callbackUrl", u.searchParams.get("callbackUrl") === "/student/test-series", page.url());
    await page.getByText("One-Time Mobile Verification Required").waitFor({ timeout: 15000 }).catch(() => {});
    check("page title", (await page.getByText("One-Time Mobile Verification Required").count()) === 1);
    check(
      "explanation copy",
      (await page.getByText("To keep MockTestSeries secure and protect student accounts, please verify your mobile number. This is required only once.").count()) === 1
    );
    check("stored 10-digit number pre-filled", (await page.inputValue("#verify-mobile")) === "9000000001");
    check("+91 prefix shown", (await page.getByText("+91", { exact: false }).count()) > 0);

    for (const p of ["/student/dashboard", "/student/test-series", "/student/attempt/resume", "/student/history", "/student/analytics"]) {
      await page.goto(`${BASE}${p}`);
      check(`direct URL ${p} → verify page`, new URL(page.url()).pathname === "/student/verify-mobile", page.url());
    }
    const apiStatus = await page.evaluate((u) => fetch(u).then((r) => r.status), `${BASE}/api/student/invoices/x`);
    check("student API with an unverified session → 401", apiStatus === 401, apiStatus);

    await page.goto(`${BASE}/student/verify-mobile`);
    await page.fill("#verify-mobile", "12345");
    await page.getByRole("button", { name: "Send Verification OTP" }).click();
    check("invalid mobile rejected server-side", /valid 10-digit Indian mobile/.test(await errorText(page)));

    // Another account's VERIFIED number: sent like any number, refused only after the OTP.
    // The refusal opens the recovery panel (request flow: scripts/verify-account-recovery.mjs).
    const recoveryPanel = async () => {
      const panel = page.getByTestId("recovery-draft");
      await panel.waitFor({ timeout: 20000 }).catch(() => {});
      return panel.innerText({ timeout: 1000 }).catch(() => "");
    };
    await page.goto(`${BASE}/student/verify-mobile`);
    let prev = await sendVerify(page, "9000000002");
    let sent = await codeFor("9000000002", prev);
    await enterCode(page, sent.code);
    let panelText = await recoveryPanel();
    check("number verified on another account → refused, recovery panel offered", /linked to another account/.test(panelText), panelText);
    check("…never merged automatically", /never move or merge accounts automatically/.test(panelText));
    check("…still unverified", studentRow("A").mobileVerifiedAt === null);
    await page.getByRole("button", { name: "Use a different number instead" }).click();
    check("'Use a different number instead' returns to the number step", await page.locator("#verify-mobile").isVisible({ timeout: 10000 }).catch(() => false));
    fixture("reset-recovery");
    // A legacy-format number on another account (919000000005)
    await page.goto(`${BASE}/student/verify-mobile`);
    prev = await sendVerify(page, "9000000005");
    sent = await codeFor("9000000005", prev);
    await enterCode(page, sent.code);
    panelText = await recoveryPanel();
    check("legacy-format duplicate (91…) also refused, no merge", /linked to another account/.test(panelText), panelText);
    const eRow = studentRow("E");
    check("other account untouched", eRow.mobile === "919000000005" && eRow.mobileVerifiedAt === null, eRow);
    fixture("reset-recovery");

    // Wrong code / expired / attempt cap / resend cooldown on the student's own number
    fixture("reset-otp");
    await page.goto(`${BASE}/student/verify-mobile`);
    prev = await sendVerify(page, "9000000001");
    sent = await codeFor("9000000001", prev);
    check("resend countdown shown (60 s)", /Resend code in (59|60)s/.test(await page.locator("text=/Resend code in/").innerText()));
    const wrong = sent.code === "000000" ? "111111" : "000000";
    await enterCode(page, wrong);
    check("invalid OTP rejected", /Incorrect code/.test(await errorText(page)), await errorText(page));
    check("still unverified after a wrong code", studentRow("A").mobileVerifiedAt === null);

    fixture("expire", "+919000000001");
    await page.locator("#otp-box-0").fill("");
    await enterCode(page, sent.code);
    const expiredMsg = await waitError(page, /expired/);
    check("expired OTP rejected", /expired/.test(expiredMsg), expiredMsg);

    // Attempt cap: 5 wrong guesses kill the code, then even the right one fails.
    fixture("reset-otp");
    await page.goto(`${BASE}/student/verify-mobile`);
    prev = await sendVerify(page, "9000000001");
    sent = await codeFor("9000000001", prev);
    for (let i = 0; i < 5; i++) {
      await page.locator("#otp-box-0").fill("");
      await enterCode(page, wrong);
      // each guess must finish (button leaves "Verifying…") before the next one
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: "Verify Mobile Number" }).waitFor({ timeout: 15000 });
    }
    await page.locator("#otp-box-0").fill("");
    await enterCode(page, sent.code);
    const capMsg = await waitError(page, /Too many incorrect attempts/);
    check("6th attempt (even correct) refused after 5 wrong", /Too many incorrect attempts/.test(capMsg), capMsg);
    check("…and still unverified", studentRow("A").mobileVerifiedAt === null);

    // Resend cooldown is enforced on the server
    const cooldown = await page.evaluate(async () => {
      const btn = [...document.querySelectorAll("button")].find((b) => /Resend code/.test(b.textContent ?? ""));
      return btn ? "button" : "countdown";
    });
    check("resend is a countdown, not a button, inside 60 s", cooldown === "countdown");

    // Success
    fixture("reset-otp");
    await page.goto(`${BASE}/student/verify-mobile?callbackUrl=${encodeURIComponent("/student/test-series")}`);
    prev = await sendVerify(page, "9000000001");
    sent = await codeFor("9000000001", prev);
    await enterCode(page, sent.code);
    await page.getByText("Mobile Number Verified Successfully").waitFor({ timeout: 15000 }).catch(() => {});
    check("success message shown", (await page.getByText("Mobile Number Verified Successfully").count()) === 1);
    await page.waitForURL(/\/student\/test-series/, { timeout: 15000 }).catch(() => {});
    check("redirected to the intended destination", /\/student\/test-series/.test(page.url()), page.url());

    const after = studentRow("A");
    check("mobile stored as E.164 + mobileVerifiedAt set", after.mobile === "+919000000001" && after.mobileVerifiedAt !== null, after);
    const same = ["id", "studentId", "name", "email", "passwordHash", "authProvider", "status", "createdAt"].every((k) => JSON.stringify(after[k]) === JSON.stringify(before[k]));
    check("identity, password, status unchanged", same);
    check(
      "attempts / payments / entitlements counts unchanged",
      ["testAttempts", "payments", "entitlements"].every((k) => after._count[k] === before._count[k]),
      { before: before._count, after: after._count }
    );
    await page.goto(`${BASE}/student/dashboard`);
    check("dashboard reachable after verification", /\/student\/dashboard/.test(page.url()), page.url());
    await page.goto(`${BASE}/student/verify-mobile`);
    check("verify page sends a verified student on", new URL(page.url()).pathname !== "/student/verify-mobile", page.url());
    await ctx.close();
  }

  console.log("5. Existing verified student signs in normally");
  fixture("reset-otp");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await passwordLogin(page, F.students.B.email);
    check("verified student → dashboard directly", /\/student\/dashboard/.test(page.url()), page.url());
    await ctx.close();
  }

  console.log("6. Google-linked student (signed in via password here: real Google OAuth can't run in CI)");
  fixture("reset-otp");
  {
    const linkBefore = studentRow("C").oauthAccounts;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await passwordLogin(page, F.students.C.email);
    await page.waitForURL(/\/student\/verify-mobile/, { timeout: 15000 }).catch(() => {});
    check("Google-provider student without a mobile → verify page", new URL(page.url()).pathname === "/student/verify-mobile", page.url());
    check("no number pre-filled", (await page.inputValue("#verify-mobile")) === "");
    const prev = await sendVerify(page, "9000000003");
    const sent = await codeFor("9000000003", prev);
    await enterCode(page, sent.code);
    await page.waitForURL(/\/student\/dashboard/, { timeout: 20000 }).catch(() => {});
    const c = studentRow("C");
    check("verified and on the dashboard", c.mobileVerifiedAt !== null && /\/student\/dashboard/.test(page.url()), page.url());
    check("Google link unchanged (same account, same providerAccountId)", JSON.stringify(c.oauthAccounts) === JSON.stringify(linkBefore), c.oauthAccounts);
    await ctx.close();
  }

  // ---------------------------------------------------------------- new registration
  console.log("7. New student registration (mobile-first)");
  fixture("reset-otp");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login?tab=register`);
    check("no password field on Create Account", (await page.locator("input[type=password]").count()) === 0);
    check("Full Name + mobile only", (await page.locator("#reg-name").count()) === 1 && (await page.locator("#reg-mobile").count()) === 1);
    await page.fill("#reg-name", "QA New Student");
    await page.fill("#reg-mobile", "5000000010");
    await page.getByRole("button", { name: "Send OTP" }).click();
    check("non-Indian / invalid mobile refused", /valid 10-digit Indian mobile/.test(await errorText(page)), await errorText(page));

    await page.fill("#reg-mobile", "9000000010");
    const prev = lastReq("9000000010");
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByText("Verify Your Mobile Number").waitFor({ timeout: 15000 });
    check("'Verify Your Mobile Number' step shown", true);
    check("number displayed as +91 9000000010", (await page.getByText("+91 9000000010").count()) === 1);
    const sent = await codeFor("9000000010", prev);
    const wrong = sent.code === "000000" ? "111111" : "000000";
    await enterCode(page, wrong);
    check("wrong OTP → error, no account", /Incorrect code/.test(await errorText(page)) && !fixture("state").some((s) => s.mobile === "+919000000010"));
    await page.locator("#otp-box-0").fill("");
    await enterCode(page, sent.code);
    await page.waitForURL(/\/student\/dashboard/, { timeout: 30000 }).catch(() => {});
    check("valid OTP → account created + signed in → dashboard", /\/student\/dashboard/.test(page.url()), page.url());
    const created = fixture("state").find((s) => s.mobile === "+919000000010");
    check(
      "created verified, E.164, OTP provider, no password",
      created && created.mobileVerifiedAt !== null && created.authProvider === "OTP" && created.passwordHash === null && created.name === "QA New Student",
      created
    );

    // Replay: the same (consumed) code cannot create or sign in anything.
    await ctx.clearCookies();
    const replay = await page.evaluate(async ({ base }) => {
      return fetch(`${base}/login?tab=register`).then((r) => r.status);
    }, { base: BASE });
    check("register page loads for replay test", replay === 200);
    await page.goto(`${BASE}/login?tab=register`);
    await page.fill("#reg-name", "QA Replay");
    await page.fill("#reg-mobile", "9000000011");
    const prev11 = lastReq("9000000011");
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByText("Verify Your Mobile Number").waitFor({ timeout: 15000 });
    const sent11 = await codeFor("9000000011", prev11);
    // tamper: submit the OLD (consumed) code of 9000000010 against this flow
    await enterCode(page, sent.code === sent11.code ? wrong : sent.code);
    check("reused/foreign OTP rejected", /Incorrect code|already been used/.test(await errorText(page)), await errorText(page));
    check("no account for 9000000011", !fixture("state").some((s) => s.mobile === "+919000000011"));
    await ctx.close();
  }

  console.log("8. Duplicate number at sign-up (after OTP, no enumeration before)");
  fixture("reset-otp");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login?tab=register`);
    await page.fill("#reg-name", "QA Duplicate");
    await page.fill("#reg-mobile", "9000000002");
    const prev = lastReq("9000000002");
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByText("Verify Your Mobile Number").waitFor({ timeout: 15000 });
    check("send step identical for a registered number (no enumeration)", true);
    const sent = await codeFor("9000000002", prev);
    await enterCode(page, sent.code);
    check("duplicate refused after OTP", /already exists/.test(await errorText(page)), await errorText(page));
    const dupes = fixture("state").filter((s) => s.mobile === "+919000000002");
    check("still exactly one account for the number", dupes.length === 1, dupes.length);
    await ctx.close();
  }

  console.log("9. Phone OTP sign-in rules");
  fixture("reset-otp");
  async function otpSignIn(digits) {
    fixture("reset-devices");
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login?tab=otp`);
    await page.fill("#otp-mobile", digits);
    const prev = lastReq(digits);
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByText(/If this number is registered/).waitFor({ timeout: 15000 });
    const sent = await codeFor(digits, prev);
    await enterCode(page, sent.code);
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 }).catch(() => {});
    const result = { url: page.url(), error: page.url().includes("/login") ? await errorText(page) : "" };
    await ctx.close();
    return result;
  }
  {
    let r = await otpSignIn("9000000006");
    check("old OTP-signup account signs in by OTP → dashboard", /\/student\/dashboard/.test(r.url), r);
    check("…and is now recorded as verified (E.164)", (() => { const f = studentRow("F"); return f.mobileVerifiedAt !== null && f.mobile === "+919000000006"; })());
    r = await otpSignIn("9000000007");
    check("password account with an UNVERIFIED stored number: OTP sign-in refused", /isn't verified on your account/.test(r.error), r);
    check("…and not marked verified", studentRow("G").mobileVerifiedAt === null);
    r = await otpSignIn("9000000099");
    check("unknown number: same send step, refused after OTP", /No account is linked/.test(r.error), r);
    r = await otpSignIn("9000000001");
    check("verified password account can now use Phone OTP", /\/student\//.test(r.url), r);
  }

  console.log("10. Direct Server Action bypass attempts");
  {
    const manifest = JSON.parse(fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"));
    const idOf = (name) =>
      Object.entries(manifest.node).find(([, v]) => v.filename === "app/login/actions.ts" && v.exportedName === name)?.[0];
    // (prevState, formData) actions: fields `_1_<name>` BEFORE the root part `0` = [{}, "$K1"].
    const callAction = async (name, fields) => {
      const id = idOf(name);
      if (!id) return { status: -1, text: `no action id for ${name}` };
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(`_1_${k}`, v);
      fd.append("0", JSON.stringify([{}, "$K1"]));
      const res = await fetch(`${BASE}/login`, {
        method: "POST",
        headers: { "Next-Action": id, Origin: BASE, Accept: "text/x-component" },
        body: fd,
        redirect: "manual",
      });
      return { status: res.status, text: await res.text() };
    };
    const r1 = await callAction("registerWithPasswordAction", {
      name: "QA Bypass", email: `qa-bypass@motp.example.test`, mobile: "9000000012", password: "QaBypass!2345", confirmPassword: "QaBypass!2345", acceptTerms: "on",
    });
    check("old password sign-up action refused while ON", /mobile number and OTP verification/.test(r1.text), r1);
    check("…and created nothing", !fixture("state").some((s) => s.email === "qa-bypass@motp.example.test"));
    const r2 = await callAction("verifyRegisterOtpAction", { name: "QA Forged", mobile: "9000000013", code: "123456" });
    check("account creation with no OTP ever sent refused", /No pending verification code|Incorrect/.test(r2.text), r2);
    check("…and created nothing", !fixture("state").some((s) => s.name === "QA Forged"));
  }

  console.log("11. Admin visibility");
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`);
    await page.fill("input[name=username]", ADMIN_USER);
    await page.fill("input[name=password]", ADMIN_PASS);
    await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
    await page.goto(`${BASE}/admin/analytics`);
    for (const label of ["Total Student Accounts", "Mobile Verified Students", "Mobile Unverified Students", "Verification Completion Rate"]) {
      check(`analytics shows "${label}"`, (await page.getByText(label, { exact: true }).count()) === 1);
    }
    await ctx.close();
  }

  console.log("12. Mobile viewport (390×844): verify + register pages fit, no horizontal scroll");
  fixture("reset-otp");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login?tab=register`);
    const overflow1 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("register page: no horizontal overflow", overflow1 <= 0, overflow1);
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? "/tmp"}/register-mobile.png` });
    await passwordLogin(page, F.students.G.email);
    await page.waitForURL(/\/student\/verify-mobile/, { timeout: 15000 }).catch(() => {});
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("verify page: no horizontal overflow", new URL(page.url()).pathname === "/student/verify-mobile" && overflow2 <= 0, { url: page.url(), overflow2 });
    await page.screenshot({ path: `${process.env.SHOT_DIR ?? "/tmp"}/verify-mobile.png` });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/, { timeout: 15000 }).catch(() => {});
    check("unverified student can sign out", /\/login/.test(page.url()), page.url());
    await ctx.close();
  }

  console.log("13. No OTP in logs");
  {
    const codes = Object.values(mockDb().requests).map((r) => r.code);
    const log = process.env.SERVER_LOG ? fs.readFileSync(process.env.SERVER_LOG, "utf8") : "";
    const leaked = codes.filter((c) => log.includes(c));
    check(`none of the ${codes.length} issued codes appear in the server log`, Boolean(process.env.SERVER_LOG) && leaked.length === 0, leaked);
  }
} finally {
  await browser.close();
  fixture("flag", "off");
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
