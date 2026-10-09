/**
 * ACCOUNT RECOVERY (duplicate mobile number) + EMAIL OTP — end-to-end (real browser).
 *
 * Runs only against a LOCAL production build on a DISPOSABLE database, with
 * MSG91 AND Resend answered in-process (no real SMS or email is ever sent):
 *
 *   NODE_OPTIONS="--import ./scripts/msg91-widget-mock.mjs --import ./scripts/resend-mock.mjs" \
 *     MSG91_MOCK_FILE=<tmp>/msg91.json MSG91_AUTH_KEY=mock MSG91_WIDGET_ID=mock \
 *     RESEND_MOCK_FILE=<tmp>/resend.json RESEND_API_KEY=re_mock_test_key \
 *     DATABASE_URL=<scratch> NEXTAUTH_URL=http://localhost:3151 AUTH_URL=http://localhost:3151 \
 *     npx next start -p 3151 -H 127.0.0.1 > <tmp>/server.log 2>&1 &
 *   BASE=http://localhost:3151 MSG91_MOCK_FILE=… RESEND_MOCK_FILE=… SERVER_LOG=<tmp>/server.log \
 *     DATABASE_URL=<scratch> ADMIN_USER=<master admin> ADMIN_PASS=… NODE_PATH=<playwright dir> \
 *     node scripts/verify-account-recovery.mjs
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE || "http://localhost:3151";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  console.error("This suite only runs against a local server backed by a disposable database.");
  process.exit(2);
}
if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing to run against the production database.");
const SMS_FILE = process.env.MSG91_MOCK_FILE;
const MAIL_FILE = process.env.RESEND_MOCK_FILE;
const ADMIN_USER = process.env.ADMIN_USER ?? "";
const ADMIN_PASS = process.env.ADMIN_PASS ?? "";
const SHOTS = process.env.SHOT_DIR ?? "/tmp";

let failures = 0;
function check(label, passed, detail) {
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${label}${!passed && detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 400)}` : ""}`);
  if (!passed) failures++;
}

function fixture(...args) {
  const out = execFileSync("npx", ["tsx", "scripts/account-recovery-fixture.ts", ...args], {
    env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" },
    encoding: "utf8",
  });
  return out.trim() ? JSON.parse(out.trim().split("\n").pop()) : null;
}
const state = () => fixture("state");
const row = (key) => state().students.find((s) => s.id === F.students[key].id);
const requestsOf = (key) => state().requests.filter((r) => r.requesterId === F.students[key].id);
/** Everything on the account except the two columns approval may change. */
const frozen = (s) => {
  const { mobile, mobileVerifiedAt, updatedAt, _count, ...rest } = s;
  // Sessions change with every sign-in; every other related-row count must not.
  const { sessions, ...counts } = _count;
  return JSON.stringify({ ...rest, counts });
};

// ---------------------------------------------------------------- inboxes
const readJson = (file, empty) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return empty;
  }
};
const smsLast = (digits) => readJson(SMS_FILE, { latest: {} }).latest[`91${digits}`]?.reqId;
async function smsCode(digits, after) {
  for (let i = 0; i < 60; i++) {
    const latest = readJson(SMS_FILE, { latest: {} }).latest[`91${digits}`];
    if (latest && latest.reqId !== after) return latest.code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no SMS OTP delivered to ${digits}`);
}
const mailCount = () => readJson(MAIL_FILE, { messages: [] }).messages.length;
async function mailCode(to, afterCount) {
  for (let i = 0; i < 60; i++) {
    const msgs = readJson(MAIL_FILE, { messages: [] }).messages.slice(afterCount).filter((m) => m.to === to);
    if (msgs.length) return /\b(\d{6})\b/.exec(msgs.at(-1).text)?.[1];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no email delivered to ${to}`);
}
const allCodes = () => [
  ...Object.values(readJson(SMS_FILE, { requests: {} }).requests).map((r) => r.code),
  ...readJson(MAIL_FILE, { messages: [] }).messages.map((m) => /\b(\d{6})\b/.exec(m.text)?.[1]).filter(Boolean),
];

// ---------------------------------------------------------------- browser
const alertText = (page) => page.locator("p[role=alert]").first().innerText({ timeout: 15000 }).catch(() => "");
async function waitAlert(page, re) {
  for (let i = 0; i < 60; i++) {
    const t = await page.locator("p[role=alert]").first().innerText({ timeout: 500 }).catch(() => "");
    if (re.test(t)) return t;
    await page.waitForTimeout(250);
  }
  return alertText(page);
}
async function studentLogin(browser, key, opts = {}) {
  fixture("reset-devices");
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill("#identifier", F.students[key].email);
  await page.fill("input[name=password]", F.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
    page.locator("form:has(#identifier) button[type=submit]").click(),
  ]);
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}
async function adminLogin(browser, username, password) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/login`);
  await page.fill("input[name=username]", username);
  await page.fill("input[name=password]", password);
  await Promise.all([page.waitForURL(/\/admin(?!\/login)/, { timeout: 30000 }), page.locator("form button[type=submit]").click()]);
  return { ctx, page };
}
/** On /student/verify-mobile: send + enter the SMS code for `digits`. */
async function proveNumber(page, digits) {
  await page.waitForURL(/\/student\/verify-mobile/, { timeout: 15000 });
  const prev = smsLast(digits);
  await page.fill("#verify-mobile", digits);
  await page.getByRole("button", { name: "Send Verification OTP" }).click();
  const code = await smsCode(digits, prev);
  await page.locator("#otp-box-0").fill(code);
}

const F = fixture("setup");
const browser = await chromium.launch();
try {
  // ------------------------------------------------------------ Email OTP OFF
  console.log("1. Security code emails OFF (deploy state)");
  {
    const { ctx, page } = await studentLogin(browser, "V");
    await page.goto(`${BASE}/student/profile`);
    check("profile: no email verification card while the switch is OFF", (await page.getByTestId("email-verify-card").count()) === 0);
    await ctx.close();
  }

  // ------------------------------------------------------------ Admin switch
  console.log("\n2. Admin: Security code emails switch");
  {
    const full = await adminLogin(browser, F.fullAdmin, F.password);
    await full.page.goto(`${BASE}/admin/communications?tab=email&etab=settings`);
    await full.page.getByTestId("security-codes-card").waitFor({ timeout: 20000 });
    check("FULL_ADMIN sees the card but no test/send control", (await full.page.locator("#otp-test-to").count()) === 0);
    check("FULL_ADMIN cannot flip the switch (disabled)", await full.page.getByRole("switch", { name: "Security code emails" }).isDisabled());
    await full.ctx.close();

    const adm = await adminLogin(browser, ADMIN_USER, ADMIN_PASS);
    await adm.page.goto(`${BASE}/admin/communications?tab=email&etab=settings`);
    const card = adm.page.getByTestId("security-codes-card");
    await card.waitFor({ timeout: 20000 });
    check("switch disabled until a test code was sent", await adm.page.getByRole("switch", { name: "Security code emails" }).isDisabled());
    await adm.page.fill("#otp-test-to", "fail@recov.example.test");
    await card.getByRole("button", { name: "Send Test Code" }).click();
    await card.getByText(/couldn't send/).waitFor({ timeout: 15000 }).catch(() => {});
    check("provider rejection shown honestly, switch stays locked", /couldn't send/.test(await card.innerText()) && (await adm.page.getByRole("switch", { name: "Security code emails" }).isDisabled()));
    const before = mailCount();
    await adm.page.fill("#otp-test-to", "owner@recov.example.test");
    await card.getByRole("button", { name: "Send Test Code" }).click();
    const testCode = await mailCode("owner@recov.example.test", before);
    check("test code email delivered (6 digits)", /^\d{6}$/.test(testCode ?? ""), testCode);
    await adm.page.waitForTimeout(1000);
    await adm.page.reload();
    await adm.page.waitForLoadState("networkidle");
    const sw = adm.page.getByRole("switch", { name: "Security code emails" });
    await sw.waitFor();
    check("after a successful test the switch can be turned on", !(await sw.isDisabled()));
    await sw.click();
    await adm.page.waitForFunction(() => document.querySelector("[aria-label='Security code emails']")?.getAttribute("aria-checked") === "true", null, { timeout: 15000 }).catch(() => {});
    await adm.page.waitForTimeout(1500);
    check("switch ON saved", /"enabled":\s*true/.test(execFileSync("psql", [process.env.DATABASE_URL.replace(/\?schema=public$/, ""), "-Atc", `select value from "Setting" where key='email.otp'`], { encoding: "utf8" })));
    await adm.ctx.close();
  }

  // ---------------------------------------------- Student email verification
  console.log("\n3. Student verifies own email (profile)");
  {
    fixture("reset-otp");
    const { ctx, page } = await studentLogin(browser, "V", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.goto(`${BASE}/student/profile`);
    const card = page.getByTestId("email-verify-card");
    await card.waitFor({ timeout: 15000 });
    check("card shown for an unverified email (switch ON)", true);
    check("mobile 390 px: no horizontal overflow", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
    let n = mailCount();
    await card.getByRole("button", { name: "Send Code to My Email" }).click();
    const first = await mailCode(F.students.V.email, n);
    await page.locator("#email-verify-code").waitFor();
    check("code sent to the account email only", /^\d{6}$/.test(first ?? ""));
    const st = state();
    check("only an HMAC of the code is stored (no plaintext)", st.emailOtps.every((o) => o.otpHash.length === 64 && o.otpHash !== first));
    const wrong = first === "000000" ? "111111" : "000000";
    await page.fill("#email-verify-code", wrong);
    await card.getByRole("button", { name: "Verify Email" }).click();
    check("wrong code rejected", /Incorrect code/.test(await waitAlert(page, /Incorrect/)));
    check("…still unverified", row("V").emailVerifiedAt === null);
    fixture("expire-email", F.students.V.email);
    await page.fill("#email-verify-code", first);
    await card.getByRole("button", { name: "Verify Email" }).click();
    check("expired code rejected", /expired/.test(await waitAlert(page, /expired/)));
    check("…still unverified", row("V").emailVerifiedAt === null);
    fixture("reset-otp");
    n = mailCount();
    await card.getByRole("button", { name: "Send a new code" }).click();
    const second = await mailCode(F.students.V.email, n);
    for (let i = 0; i < 5; i++) {
      await page.fill("#email-verify-code", second === "000000" ? "11111" + i : "00000" + i);
      await card.getByRole("button", { name: "Verify Email" }).click();
      await page.waitForTimeout(700);
    }
    await page.fill("#email-verify-code", second);
    await card.getByRole("button", { name: "Verify Email" }).click();
    check("6th attempt (even correct) refused after 5 wrong", /Too many incorrect|already been used|No active code/.test(await waitAlert(page, /Too many|already|No active/)));
    check("…still unverified", row("V").emailVerifiedAt === null);
    fixture("reset-otp");
    n = mailCount();
    await card.getByRole("button", { name: "Send a new code" }).click();
    const third = await mailCode(F.students.V.email, n);
    await page.fill("#email-verify-code", third);
    await card.getByRole("button", { name: "Verify Email" }).click();
    await card.getByText("Email Verified Successfully").waitFor({ timeout: 15000 }).catch(() => {});
    check("correct code → 'Email Verified Successfully'", (await card.innerText()).includes("Email Verified Successfully"));
    check("emailVerifiedAt set", row("V").emailVerifiedAt !== null);
    await page.reload();
    check("profile shows Verified, card gone", (await page.getByTestId("email-verified-badge").count()) === 1 && (await page.getByTestId("email-verify-card").count()) === 0);
    const used = state().emailOtps.filter((o) => o.email === F.students.V.email && o.consumedAt === null);
    check("code consumed (single use)", used.length === 0, used);
    await page.screenshot({ path: `${SHOTS}/profile-email-verified-mobile.png`, fullPage: true });
    await ctx.close();
  }

  // ---------------------------------------- Duplicate number → recovery flow
  console.log("\n4. Duplicate number (switch ON): request, email proof, submit");
  fixture("flag", "on");
  await new Promise((r) => setTimeout(r, 16000)); // provider config cache
  fixture("reset-otp");
  const before = Object.fromEntries(["R1", "H1"].map((k) => [k, frozen(row(k))]));
  let r1Request;
  {
    const { ctx, page } = await studentLogin(browser, "R1", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    check("unverified Google student sent to verification", page.url().includes("/student/verify-mobile"), page.url());
    await proveNumber(page, "9000008001");
    await page.getByTestId("recovery-draft").waitFor({ timeout: 20000 });
    check("recovery panel offered", (await page.getByTestId("recovery-draft").count()) === 1);
    const reqs = requestsOf("R1");
    r1Request = reqs[0];
    check("one DRAFT request recorded server-side, holder = H1", reqs.length === 1 && r1Request.status === "DRAFT" && r1Request.holderId === F.students.H1.id && r1Request.mobile === "+919000008001", reqs);
    check("nothing moved yet (R1 unverified, H1 keeps the number)", row("R1").mobileVerifiedAt === null && row("H1").mobile === "+919000008001");
    check("holder email shown masked only", (await page.getByTestId("recovery-draft").innerText()).includes("q****@recov.example.test") && !(await page.locator("body").innerText()).includes(F.students.H1.email));
    check("mobile 390 px: no horizontal overflow", (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0);
    await page.screenshot({ path: `${SHOTS}/recovery-draft-mobile.png`, fullPage: true });

    let n = mailCount();
    await page.getByRole("button", { name: /Send code to/ }).click();
    const holderCode = await mailCode(F.students.H1.email, n);
    check("proof code went to the HOLDER's email", /^\d{6}$/.test(holderCode ?? ""));
    await page.fill("#recovery-email-code", holderCode === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: "Confirm Email" }).click();
    check("wrong proof code rejected", /Incorrect code/.test(await waitAlert(page, /Incorrect/)));
    await page.fill("#recovery-email-code", holderCode);
    await page.getByRole("button", { name: "Confirm Email" }).click();
    await page.getByTestId("recovery-email-proved").waitFor({ timeout: 15000 }).catch(() => {});
    check("correct proof code → email confirmed", (await page.getByTestId("recovery-email-proved").count()) === 1);
    check("holderEmailProvedAt recorded", requestsOf("R1")[0].holderEmailProvedAt !== null);
    await page.fill("#recovery-note", "The phone account is my old account.");
    await page.getByRole("button", { name: "Submit Request for Review" }).click();
    await page.getByTestId("recovery-pending").waitFor({ timeout: 15000 });
    check("submitted → 'Request under review'", true);
    check("request PENDING with the note", requestsOf("R1")[0].status === "PENDING" && requestsOf("R1")[0].studentNote === "The phone account is my old account.");
    await page.goto(`${BASE}/student/dashboard`);
    check("still restricted while pending (dashboard → verify page)", page.url().includes("/student/verify-mobile"), page.url());
    await page.getByTestId("recovery-pending").waitFor({ timeout: 15000 });
    check("verify page shows the pending request on reload", true);
    await ctx.close();
  }

  // -------------------------------------------------- Cancel + tamper (R3/H3)
  console.log("\n5. Cancel, and a request id from another student is refused");
  {
    fixture("reset-otp");
    const { ctx, page } = await studentLogin(browser, "R3");
    await proveNumber(page, "9000008003");
    await page.getByTestId("recovery-draft").waitFor({ timeout: 20000 });
    const mine = requestsOf("R3")[0];
    // Point the submit form at R1's request: must be refused, R1's request untouched.
    await page.evaluate((id) => {
      document.querySelectorAll("input[name=requestId]").forEach((i) => (i.value = id));
    }, r1Request.id);
    await page.getByRole("button", { name: "Submit Request for Review" }).click();
    check("submitting another student's request id → refused", /no longer open/.test(await waitAlert(page, /no longer open/)));
    const r1Now = requestsOf("R1")[0];
    check("…R1's request unchanged (still PENDING, same note)", r1Now.status === "PENDING" && r1Now.studentNote === "The phone account is my old account.");
    check("…R3's own request still DRAFT", requestsOf("R3")[0].status === "DRAFT");
    await page.reload();
    await page.getByTestId("recovery-draft").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Submit Request for Review" }).click();
    await page.getByTestId("recovery-pending").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Cancel request" }).click();
    await page.getByTestId("recovery-cancelled").waitFor({ timeout: 15000 });
    check("cancel → CANCELLED, nothing moved", requestsOf("R3").find((r) => r.id === mine.id).status === "CANCELLED" && row("H3").mobile === "+919000008003" && row("R3").mobileVerifiedAt === null);
    await ctx.close();
  }

  // ------------------------------------------------------------ Admin review
  console.log("\n6. Admin review: FULL_ADMIN read-only, MASTER approves R1 (number only)");
  {
    const full = await adminLogin(browser, F.fullAdmin, F.password);
    await full.page.goto(`${BASE}/admin/students?tab=account-recovery`);
    await full.page.getByTestId("recovery-table").first().waitFor({ timeout: 20000 });
    check("FULL_ADMIN sees the pending request", (await full.page.getByText(F.students.R1.studentId).count()) >= 1);
    await full.page.goto(`${BASE}/admin/students/account-recovery/${r1Request.id}`);
    check("FULL_ADMIN: no Approve / Reject buttons", (await full.page.getByRole("button", { name: /Approve|Reject/ }).count()) === 0);
    await full.ctx.close();

    const adm = await adminLogin(browser, ADMIN_USER, ADMIN_PASS);
    await adm.page.goto(`${BASE}/admin/students/account-recovery/${r1Request.id}`);
    const req = await adm.page.getByTestId("recovery-requester").innerText();
    const hold = await adm.page.getByTestId("recovery-holder").innerText();
    check("detail: both accounts side by side", req.includes(F.students.R1.studentId) && hold.includes(F.students.H1.studentId));
    check("detail: email proof + student note shown", /ALSO entered a code sent to the holding account/.test(await adm.page.locator("main").innerText()) && (await adm.page.locator("main").innerText()).includes("my old account"));
    await adm.page.screenshot({ path: `${SHOTS}/admin-recovery-detail.png`, fullPage: true });
    await adm.page.getByRole("button", { name: "Approve — Move Number" }).click();
    await adm.page.fill("#recovery-admin-notes", "Same person; phone + email proved.");
    await adm.page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
    await adm.page.getByText("APPROVED").first().waitFor({ timeout: 15000 });
    const R1 = row("R1");
    const H1 = row("H1");
    check("R1 now holds +919000008001, verified", R1.mobile === "+919000008001" && R1.mobileVerifiedAt !== null, R1);
    check("H1 released the number (mobile NULL, unverified)", H1.mobile === null && H1.mobileVerifiedAt === null, H1);
    check("everything else on R1 unchanged (Google link, email, password, counts)", frozen(R1) === before.R1, [frozen(R1), before.R1]);
    check("everything else on H1 unchanged (status, attempts, payments, entitlements)", frozen(H1) === before.H1, [frozen(H1), before.H1]);
    const done = requestsOf("R1")[0];
    check("request APPROVED with reviewer, notes and holder's old number kept", done.status === "APPROVED" && done.adminNotes?.includes("Same person") && done.holderPreviousMobile === "+919000008001");
    await adm.page.reload();
    check("approved request: no review buttons any more", (await adm.page.getByRole("button", { name: /Approve — Move Number|Reject/ }).count()) === 0);
    await adm.ctx.close();

    const { ctx, page } = await studentLogin(browser, "R1");
    await page.goto(`${BASE}/student/dashboard`);
    check("R1 can now use the dashboard (verified)", /\/student\/dashboard/.test(page.url()), page.url());
    await ctx.close();
  }

  // ------------------------------------------------------- Reject (R2/H2)
  console.log("\n7. Reject: holder with no email/Google (warning shown), nothing changes");
  {
    fixture("reset-otp");
    const beforeR2 = frozen(row("R2"));
    const beforeH2 = JSON.stringify(row("H2"));
    const { ctx, page } = await studentLogin(browser, "R2");
    await proveNumber(page, "9000008002");
    await page.getByTestId("recovery-draft").waitFor({ timeout: 20000 });
    check("legacy spelling (9000008002) detected as the same number", requestsOf("R2")[0]?.holderId === F.students.H2.id);
    check("no email proof offered (holder has no email)", (await page.getByRole("button", { name: /Send code to/ }).count()) === 0);
    await page.getByRole("button", { name: "Submit Request for Review" }).click();
    await page.getByTestId("recovery-pending").waitFor({ timeout: 15000 });
    const reqId = requestsOf("R2")[0].id;

    const adm = await adminLogin(browser, ADMIN_USER, ADMIN_PASS);
    await adm.page.goto(`${BASE}/admin/students/account-recovery/${reqId}`);
    check("warning: holder would have no way to sign in", (await adm.page.getByTestId("holder-signin-warning").count()) === 1);
    await adm.page.getByRole("button", { name: "Reject" }).click();
    await adm.page.fill("#recovery-admin-notes", "Could not confirm ownership.");
    await adm.page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
    await adm.page.getByText("REJECTED").first().waitFor({ timeout: 15000 });
    check("request REJECTED", requestsOf("R2")[0].status === "REJECTED");
    check("R2 unchanged and still unverified", frozen(row("R2")) === beforeR2 && row("R2").mobileVerifiedAt === null);
    check("H2 completely unchanged", JSON.stringify(row("H2")) === beforeH2);
    await adm.ctx.close();
    await page.reload();
    await page.getByTestId("recovery-rejected").waitFor({ timeout: 15000 }).catch(() => {});
    check("student sees 'not approved' + can use a different number", (await page.getByTestId("recovery-rejected").count()) === 1);
    await ctx.close();
  }

  // ---------------------------------------------- Switch OFF hides email OTP
  console.log("\n8. Security code emails OFF again: email OTP refused server-side");
  {
    fixture("email-otp", "off");
    fixture("reset-otp");
    const { ctx, page } = await studentLogin(browser, "R3");
    // R3's request was cancelled; prove the number again → new DRAFT, but no email proof offered.
    await proveNumber(page, "9000008003");
    await page.getByTestId("recovery-draft").waitFor({ timeout: 20000 });
    check("no email-proof control while the switch is OFF", (await page.getByRole("button", { name: /Send code to/ }).count()) === 0);
    await ctx.close();
  }

  // ------------------------------------------------------------- Logs
  console.log("\n9. No OTP codes (SMS or email) in the server log");
  {
    const log = process.env.SERVER_LOG ? fs.readFileSync(process.env.SERVER_LOG, "utf8") : "";
    const codes = [...new Set(allCodes())];
    const leaked = codes.filter((c) => log.includes(c));
    check(`none of the ${codes.length} issued codes appear in the server log`, log.length > 0 && leaked.length === 0, leaked);
  }
} finally {
  await browser.close();
  try {
    fixture("flag", "off");
  } catch {}
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
