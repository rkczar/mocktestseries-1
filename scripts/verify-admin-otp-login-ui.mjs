/**
 * Admin Login — password login unchanged + optional "Login with OTP" + its Master-Admin switch (browser; switch must start missing/OFF; scratch server on mts_aotp with the
 * Resend mock; never real email). BASE=… RESEND_MOCK_FILE=… SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-admin-otp-login-ui.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const { BASE, RESEND_MOCK_FILE: FILE, SHOTS } = process.env;
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) pass++; else fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${!ok && d !== undefined ? ` — ${JSON.stringify(d).slice(0, 200)}` : ""}`); };
const code = (to) => /\b(\d{6})\b/.exec([...(JSON.parse(fs.readFileSync(FILE, "utf8")).messages)].reverse().find((m) => m.to === to)?.text ?? "")?.[1];
const browser = await chromium.launch();
const fresh = async (w = 1366) => (await browser.newContext({ viewport: { width: w, height: 900 } })).newPage();
const pwLogin = async (p, user) => {
  await p.goto(`${BASE}/admin/login`);
  await p.fill("input[name=username]", user); await p.fill("input[name=password]", "Ui-Pass-12345!");
  await Promise.all([p.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), p.locator("form button[type=submit]").click()]);
};
const setSwitch = async (p, on) => {
  await p.goto(`${BASE}/admin/settings/security`);
  const sw = p.getByTestId("admin-otp-switch");
  if (((await sw.getAttribute("aria-checked")) === "true") !== on) await sw.click();
  const form = p.locator("form", { has: sw });
  await form.locator("button[type=submit]").click();
  await form.getByText("Saved").waitFor();
};
try {
  console.log("\n=== switch missing → OFF: password form only");
  let m = await fresh();
  await m.goto(`${BASE}/admin/login`);
  check("OFF: no OTP tabs, only the password form", (await m.getByTestId("admin-login-tab-otp").count()) === 0 && (await m.getByTestId("admin-login-tab-password").count()) === 0 && (await m.locator("input[name=username]").count()) === 1 && (await m.locator("input[name=password]").count()) === 1);
  await m.screenshot({ path: `${SHOTS}/00-switch-off-login.png` });
  await pwLogin(m, "otp-master");
  check("OFF: password login → /admin", /\/admin(?!\/login)/.test(m.url()));
  await m.goto(`${BASE}/admin/settings/security`);
  check("Master Admin sees the switch, OFF, editable", (await m.getByTestId("admin-otp-switch").getAttribute("aria-checked")) === "false" && !(await m.getByTestId("admin-otp-switch").isDisabled()));
  let f = await fresh();
  await pwLogin(f, "otp-full");
  await f.goto(`${BASE}/admin/settings/security`);
  check("FULL_ADMIN cannot see or change the switch", (await f.getByTestId("admin-otp-switch").count()) === 0);
  // Master Admin's own email is still unverified: turning OTP on is refused.
  {
    const sw = m.getByTestId("admin-otp-switch"); const form = m.locator("form", { has: sw });
    await sw.click(); await form.locator("button[type=submit]").click();
    await form.getByText("Add and verify your own email first").waitFor();
    check("enable refused while the Master Admin's email is unverified", true);
  }
  console.log("\n=== Edit Admin: email status + verification");
  await m.goto(`${BASE}/admin/users/admins`);
  await m.getByTestId("edit-admin-otp-master").click();
  check("status shows Verification Pending", (await m.getByTestId("ae-email-status-otp-master").textContent()).includes("Verification Pending"));
  await m.getByTestId("ae-email-send-otp-master").click();
  await m.getByText("Verification code sent").waitFor();
  const vc = code("master@aotp.example.test");
  check("verification code captured by the test mail system", /^\d{6}$/.test(vc ?? ""));
  await m.getByTestId("ae-email-code-otp-master").fill(vc === "000000" ? "111111" : "000000");
  await m.getByTestId("ae-email-verify-otp-master").click();
  await m.getByText(/Incorrect|invalid|expired|wrong/i).first().waitFor();
  check("wrong verification code rejected", (await m.getByTestId("ae-email-status-otp-master").textContent()).includes("Verification Pending"));
  await m.getByTestId("ae-email-code-otp-master").fill(vc);
  await m.getByTestId("ae-email-verify-otp-master").click();
  await m.getByText("Email verified.").waitFor();
  await m.reload(); await m.getByTestId("edit-admin-otp-master").click();
  check("status shows Verified after reload", (await m.getByTestId("ae-email-status-otp-master").textContent()).includes("Verified"));
  await m.screenshot({ path: `${SHOTS}/00a-email-verified.png` });
  await setSwitch(m, true);
  await m.screenshot({ path: `${SHOTS}/00b-switch-on-settings.png` });
  {
    const q = await fresh();
    await q.goto(`${BASE}/admin/login`);
    check("ON: login page now offers the OTP tab", (await q.getByTestId("admin-login-tab-otp").count()) === 1);
  }

  console.log("\n=== password login unchanged");
  let p = await fresh();
  await p.goto(`${BASE}/admin/login`);
  check("Password is the default tab; same fields", (await p.getByTestId("admin-login-tab-password").getAttribute("aria-selected")) === "true" && (await p.locator("input[name=username]").count()) === 1 && (await p.locator("input[name=password]").count()) === 1);
  await p.fill("input[name=username]", "otp-master"); await p.fill("input[name=password]", "wrong-pass-1");
  await p.locator("form button[type=submit]").click();
  await p.locator("form [role=alert]").waitFor();
  check("wrong password → same error as before", (await p.locator("form [role=alert]").textContent()).includes("Invalid Admin ID or password"));
  // The form clears after a failed submit (React form action reset — unchanged behaviour): enter both again.
  await p.fill("input[name=username]", "otp-master"); await p.fill("input[name=password]", "Ui-Pass-12345!");
  await Promise.all([p.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), p.locator("form button[type=submit]").click()]);
  check("correct password → /admin", /\/admin(?!\/login)/.test(p.url()));
  await p.screenshot({ path: `${SHOTS}/01-password-login-admin.png` });
  p = await fresh();
  await p.goto(`${BASE}/admin/login`);
  await p.fill("input[name=username]", "otp-teacher"); await p.fill("input[name=password]", "Ui-Pass-12345!");
  await Promise.all([p.waitForURL(/\/teacher/, { timeout: 30000 }), p.locator("form button[type=submit]").click()]);
  check("teacher password login still lands in the Teacher Portal", /\/teacher/.test(p.url()));

  console.log("\n=== Login with OTP");
  p = await fresh();
  await p.goto(`${BASE}/admin/login`);
  await p.getByTestId("admin-login-tab-otp").click();
  await p.screenshot({ path: `${SHOTS}/02-otp-tab.png` });
  await p.fill("#otp-identifier", "nobody-here");
  await p.getByTestId("admin-otp-send").click();
  await p.getByTestId("admin-otp-sent").waitFor();
  const generic = await p.getByTestId("admin-otp-sent").textContent();
  check("unknown identifier → generic message, resend countdown shown", /If this is an active admin account/.test(generic) && /Resend code in/.test(await p.getByTestId("admin-otp-send").textContent()));
  p = await fresh();
  await p.goto(`${BASE}/admin/login`);
  await p.getByTestId("admin-login-tab-otp").click();
  await p.fill("#otp-identifier", "otp-master");
  await p.getByTestId("admin-otp-send").click();
  await p.getByTestId("admin-otp-sent").waitFor();
  check("known admin → the identical message", (await p.getByTestId("admin-otp-sent").textContent()) === generic);
  const c = code("master@aotp.example.test");
  check("code delivered to the registered email (mock)", /^\d{6}$/.test(c ?? ""));
  await p.fill("#otp-code", c === "000000" ? "111111" : "000000");
  await p.getByTestId("admin-otp-verify").click();
  await p.locator("form [role=alert]").waitFor();
  check("wrong code → error, still on login", /Invalid or expired code/.test(await p.locator("form [role=alert]").textContent()) && /\/admin\/login/.test(p.url()));
  await p.fill("#otp-code", c);
  await Promise.all([p.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), p.getByTestId("admin-otp-verify").click()]);
  check("correct code → normal admin session on /admin", /\/admin(?!\/login)/.test(p.url()) && (await p.content()).includes("MASTER ADMIN"));
  await p.goto(`${BASE}/admin/ai-importer/settings`);
  check("session works on other admin pages", !/\/admin\/login/.test(p.url()));
  await p.screenshot({ path: `${SHOTS}/03-otp-logged-in.png` });

  console.log("\n=== FULL_ADMIN via OTP keeps read-only role; phone layout");
  p = await fresh(390);
  await p.goto(`${BASE}/admin/login`);
  await p.getByTestId("admin-login-tab-otp").click();
  check("phone: no sideways scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.fill("#otp-identifier", "full@aotp.example.test");
  await p.getByTestId("admin-otp-send").click();
  await p.getByTestId("admin-otp-sent").waitFor();
  await p.fill("#otp-code", code("full@aotp.example.test"));
  await Promise.all([p.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), p.getByTestId("admin-otp-verify").click()]);
  check("FULL_ADMIN signed in by OTP shows FULL ADMIN role", (await p.content()).includes("FULL ADMIN"));
  await p.screenshot({ path: `${SHOTS}/04-phone-full-admin.png` });

  console.log("\n=== switch back OFF");
  await setSwitch(m, false);
  p = await fresh();
  await p.goto(`${BASE}/admin/login`);
  check("OFF again: OTP tab gone", (await p.getByTestId("admin-login-tab-otp").count()) === 0 && (await p.locator("input[name=password]").count()) === 1);
} catch (e) { fail++; console.error(e); } finally { await browser.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
