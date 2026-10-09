/**
 * WHATSAPP OTP FALLBACK — end-to-end in real browsers (Sign-in OTP, Create
 * Account, Forgot Password, mobile verification) against a LOCAL production
 * build on a DISPOSABLE database, with MSG91 answered by
 * scripts/msg91-widget-mock.mjs (no SMS / WhatsApp is ever sent). Server as
 * in scripts/verify-mobile-otp.mjs, then:
 *
 *   BASE=http://localhost:3171 MSG91_MOCK_FILE=<tmp>/msg91.json SERVER_LOG=<tmp>/server.log DATABASE_URL=<scratch> \
 *     ADMIN_USER=qa-master ADMIN_PASS=… NODE_PATH=<dir containing playwright> node scripts/verify-whatsapp-otp-ui.mjs
 *
 * Each flow waits out the real 60 s resend countdown; the four run in parallel.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE || "http://localhost:3171";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}
const MOCK_FILE = process.env.MSG91_MOCK_FILE;
const ADMIN_USER = process.env.ADMIN_USER ?? "";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "";
const WA_BUTTON = "Get OTP on WhatsApp";

let failures = 0;
const results = [];
function check(label, passed, detail) {
  results.push(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!passed) failures++;
}
const flush = () => {
  console.log(results.join("\n"));
  results.length = 0;
};

function fixture(...args) {
  const out = execFileSync("npx", ["tsx", "scripts/mobile-otp-fixture.ts", ...args], {
    env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
    encoding: "utf8",
  });
  return out.trim() ? JSON.parse(out.trim().split("\n").pop()) : null;
}
function psql(sql) {
  return execFileSync("psql", [process.env.DATABASE_URL.replace(/\?schema=public$/, ""), "-Atc", sql], { encoding: "utf8" }).trim();
}
const mockDb = () => {
  try {
    return JSON.parse(fs.readFileSync(MOCK_FILE, "utf8"));
  } catch {
    return { requests: {}, latest: {} };
  }
};
const latest = (digits) => mockDb().latest[`91${digits}`];
async function nextDelivery(digits, afterReqId, channel) {
  for (let i = 0; i < 60; i++) {
    const l = latest(digits);
    if (l && l.reqId !== afterReqId && (!channel || l.channel === channel)) return l;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no ${channel ?? "SMS"} delivery to ${digits}`);
}
const waCount = (digits) => (mockDb().whatsapp ?? []).filter((w) => w.identifier === `91${digits}`).length;

async function setWhatsAppSwitch(browser, on) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", ADMIN_USER);
  await page.fill("input[name=password]", ADMIN_PASS);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  await page.goto(`${BASE}/admin/settings/authentication`);
  const sw = page.getByRole("switch", { name: "WhatsApp OTP fallback" });
  await sw.waitFor();
  const before = await sw.getAttribute("aria-checked");
  if ((before === "true") !== on) await sw.click();
  const form = page.locator("form", { has: sw });
  await form.getByRole("button", { name: "Save Configuration" }).click();
  await page.waitForTimeout(1500);
  await ctx.close();
  return before;
}
const storedSwitch = () => psql(`select coalesce(value::jsonb->'msg91'->>'whatsappRetryEnabled','<unset>') from "Setting" where key='auth.providers'`);

/** Waits out the 60 s countdown, clicks WhatsApp, returns the code MSG91 "delivered" on WhatsApp. */
async function viaWhatsApp(page, digits) {
  const smsReq = latest(digits)?.reqId;
  const btn = page.getByRole("button", { name: WA_BUTTON });
  // The mock records the SMS before the page swaps to the code step.
  await page.getByText(/Resend code in \d+s/).waitFor({ timeout: 15000 }).catch(() => {});
  const hiddenDuringCountdown = (await btn.count()) === 0 && (await page.getByText(/Resend code in \d+s/).count()) === 1;
  await btn.waitFor({ timeout: 80_000 });
  const resendAlsoShown = (await page.getByRole("button", { name: "Resend code" }).count()) === 1;
  await btn.click();
  await page.getByText(/Code sent on WhatsApp|code was sent on WhatsApp/).waitFor({ timeout: 15000 });
  const wa = await nextDelivery(digits, smsReq, "whatsapp");
  const restarted = (await page.getByText(/Resend code in \d+s/).count()) === 1;
  return { wa, hiddenDuringCountdown, resendAlsoShown, restarted };
}

async function loginFlow(browser) {
  const digits = "9000000002"; // B: verified password account
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login?tab=otp`);
  await page.fill("#otp-mobile", digits);
  const prev = latest(digits)?.reqId;
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByText(/If this number is registered/).waitFor({ timeout: 15000 });
  await nextDelivery(digits, prev);
  const r = await viaWhatsApp(page, digits);
  check("Sign-in OTP: WhatsApp option hidden during the 60 s countdown", r.hiddenDuringCountdown);
  check("Sign-in OTP: after the countdown, 'Resend code' AND 'Get OTP on WhatsApp'", r.resendAlsoShown);
  check("Sign-in OTP: WhatsApp click restarts the countdown", r.restarted);
  await page.locator("#otp-box-0").fill(r.wa.code);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
  check("Sign-in OTP: WhatsApp code signs in → /student/*", /\/student\//.test(page.url()), page.url());
  await ctx.close();
}

async function registerFlow(browser) {
  const digits = "9000000099";
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login?tab=register`);
  await page.fill("#reg-name", "QA WhatsApp Student");
  await page.fill("#reg-mobile", digits);
  const prev = latest(digits)?.reqId;
  await page.getByRole("button", { name: "Send OTP" }).click();
  await page.getByText("Verify Your Mobile Number").waitFor({ timeout: 15000 });
  await nextDelivery(digits, prev);
  const r = await viaWhatsApp(page, digits);
  check("Create Account: WhatsApp option after the countdown", r.resendAlsoShown && r.hiddenDuringCountdown);
  await page.locator("#otp-box-0").fill(r.wa.code);
  await page.waitForURL(/\/student\/dashboard/, { timeout: 30000 }).catch(() => {});
  check("Create Account: WhatsApp code creates the account → dashboard", /\/student\/dashboard/.test(page.url()), page.url());
  const row = psql(`select "authProvider"||'|'||("mobileVerifiedAt" is not null)||'|'||name from "Student" where mobile='+91${digits}'`);
  check("Create Account: account is OTP + verified + named", row === "OTP|true|QA WhatsApp Student", row);
  await ctx.close();
}

async function forgotFlow(browser, gEmail) {
  const digits = "9000000007"; // G: password account, registered mobile
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login?tab=forgot`);
  await page.fill("#reset-identifier", gEmail);
  const prev = latest(digits)?.reqId;
  await page.locator("form:has(#reset-identifier) button[type=submit]").click();
  await page.getByText("Verify it's you").waitFor({ timeout: 15000 });
  await nextDelivery(digits, prev);
  const r = await viaWhatsApp(page, digits);
  check("Forgot Password: WhatsApp option after the countdown", r.resendAlsoShown && r.hiddenDuringCountdown);
  check(
    "Forgot Password: confirmation does not reveal the account",
    (await page.getByText("If this account exists, the code was sent on WhatsApp to its registered mobile.").count()) === 1
  );
  await page.locator("#otp-box-0").fill(r.wa.code);
  await page.getByText("Set a new password").waitFor({ timeout: 20000 }).catch(() => {});
  check("Forgot Password: WhatsApp code → 'Set a new password'", (await page.getByText("Set a new password").count()) === 1);
  await ctx.close();
}

async function verifyMobileFlow(browser, aEmail, password) {
  const digits = "9000000001"; // A: unverified password account
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill("#identifier", aEmail);
  await page.fill("input[name=password]", password);
  await Promise.all([page.waitForURL(/\/student\/verify-mobile/, { timeout: 30000 }), page.locator("form:has(#identifier) button[type=submit]").click()]);
  const prev = latest(digits)?.reqId;
  await page.fill("#verify-mobile", digits);
  await page.getByRole("button", { name: "Send Verification OTP" }).click();
  await nextDelivery(digits, prev);
  const r = await viaWhatsApp(page, digits);
  check("Mobile verification: WhatsApp option after the countdown", r.resendAlsoShown && r.hiddenDuringCountdown);
  await page.locator("#otp-box-0").fill(r.wa.code);
  await page.waitForURL((u) => !u.pathname.startsWith("/student/verify-mobile"), { timeout: 30000 }).catch(() => {});
  check("Mobile verification: WhatsApp code verifies → leaves the verify page", !page.url().includes("/student/verify-mobile"), page.url());
  check("Mobile verification: mobileVerifiedAt set", psql(`select ("mobileVerifiedAt" is not null)::text from "Student" where email='${aEmail}'`) === "true");
  await ctx.close();
}

const F = fixture("setup");
fixture("flag", "on");
fixture("reset-otp");
const browser = await chromium.launch();
try {
  console.log("1. Admin switch (default OFF)");
  check("stored default: not set (= OFF)", ["<unset>", "false"].includes(storedSwitch()), storedSwitch());
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login?tab=otp`);
    await page.fill("#otp-mobile", "9000000006");
    await page.getByRole("button", { name: "Send OTP" }).click();
    await page.getByText(/If this number is registered/).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Resend code" }).waitFor({ timeout: 80_000 });
    check("switch OFF: after the countdown only 'Resend code' (no WhatsApp option)", (await page.getByRole("button", { name: WA_BUTTON }).count()) === 0);
    await ctx.close();
  }
  const before = await setWhatsAppSwitch(browser, true);
  check("admin: switch shown OFF, turned ON + saved", before === "false" && storedSwitch() === "true", { before, stored: storedSwitch() });
  check("admin: save audited", psql(`select count(*) from "AuditLog" where action='AUTH_PROVIDER_MSG91_SAVED' and metadata->>'whatsappRetryEnabled'='true'`) !== "0");
  fixture("reset-otp");
  flush();

  console.log("2. Four flows in parallel (each waits the real 60 s countdown)");
  const FLOW_DIGITS = ["9000000002", "9000000099", "9000000007", "9000000001"];
  const waBefore = Object.fromEntries(FLOW_DIGITS.map((d) => [d, waCount(d)]));
  const waLogStart = (mockDb().whatsapp ?? []).length;
  const emailOf = (k) => F.students[k].email;
  await Promise.all([loginFlow(browser), registerFlow(browser), forgotFlow(browser, emailOf("G")), verifyMobileFlow(browser, emailOf("A"), F.password)]);
  flush();

  console.log("3. Channel + limits recorded");
  const ch = psql(`select string_agg(purpose||':'||channel, ' ' order by purpose, channel) from (select distinct purpose, channel from "OtpRequest") t`);
  check("WHATSAPP rows for all four purposes", ["LOGIN", "REGISTER", "RESET_PASSWORD", "VERIFY_MOBILE"].every((p) => ch.includes(`${p}:WHATSAPP`)), ch);
  check("exactly one WhatsApp delivery per flow", FLOW_DIGITS.every((d) => waCount(d) - waBefore[d] === 1), FLOW_DIGITS.map((d) => waCount(d) - waBefore[d]));
  const runRetries = (mockDb().whatsapp ?? []).slice(waLogStart);
  check("every retry carried the original SMS reqId", runRetries.length === 4 && runRetries.every((w) => mockDb().requests[w.retryOf] && mockDb().requests[w.retryOf].channel !== "whatsapp"));

  console.log("4. Switch OFF again");
  await setWhatsAppSwitch(browser, false);
  check("admin: switch saved OFF", storedSwitch() === "false");
  flush();

  console.log("5. No codes in the server log");
  if (process.env.SERVER_LOG) {
    const log = fs.readFileSync(process.env.SERVER_LOG, "utf8");
    const codes = new Set(Object.values(mockDb().requests).map((r) => r.code));
    check(`none of the ${codes.size} issued codes appear in the server log`, [...codes].every((c) => !log.includes(c)));
  }
} finally {
  flush();
  await browser.close();
  fixture("flag", "off");
  fixture("cleanup");
}
console.log(failures === 0 ? "\nALL WHATSAPP UI CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
