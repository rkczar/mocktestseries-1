/**
 * Admin Login — password login unchanged + optional "Login with OTP" (browser; scratch server on mts_aotp with the
 * Resend mock; never real email). BASE=… RESEND_MOCK_FILE=… SHOTS=<dir> NODE_PATH=<playwright> node scripts/verify-admin-otp-login-ui.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
const { chromium } = createRequire(import.meta.url)("playwright");
const { BASE, RESEND_MOCK_FILE: FILE, SHOTS } = process.env;
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${!ok && d !== undefined ? ` — ${JSON.stringify(d).slice(0, 200)}` : ""}`); };
const code = (to) => /\b(\d{6})\b/.exec([...(JSON.parse(fs.readFileSync(FILE, "utf8")).messages)].reverse().find((m) => m.to === to)?.text ?? "")?.[1];
const browser = await chromium.launch();
const fresh = async (w = 1366) => (await browser.newContext({ viewport: { width: w, height: 900 } })).newPage();
try {
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
} catch (e) { fail++; console.error(e); } finally { await browser.close(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
