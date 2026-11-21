/**
 * Admin "Login with OTP" + its emergency switch (library level; scratch DB mts_aotp / mts_aotp_sw only; Resend answered in-process — no real email).
 *   NODE_OPTIONS="--conditions=react-server --import ./scripts/resend-mock.mjs" RESEND_MOCK_FILE=<tmp>/resend.json \
 *   RESEND_API_KEY=re_mock_test_key AUTH_SECRET=… DATABASE_URL=<scratch mts_aotp> npx tsx scripts/verify-admin-otp-login.ts
 */
import fs from "node:fs";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { ADMIN_OTP_SENT, ADMIN_OTP_UNAVAILABLE, authorizeAdminOtp, requestAdminLoginOtp, sendAdminEmailVerification, verifyAdminEmail } from "@/lib/admin-otp-login";
import { EmailOtpError, setEmailOtpEnabled } from "@/lib/email-otp";
import { ADMIN_OTP_SETTING_KEY, clearAdminOtpLoginCache, isAdminOtpLoginEnabled, saveAdminOtpLoginEnabled } from "@/lib/admin-otp-settings";

if (!/\/mts_aotp\w*(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing: not the scratch mts_aotp database.");
const FILE = process.env.RESEND_MOCK_FILE!;
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ""}`);
};
const mails = () => (fs.existsSync(FILE) ? (JSON.parse(fs.readFileSync(FILE, "utf8")).messages as { to: string; text: string; subject: string }[]) : []);
const lastCode = (to: string) => /\b(\d{6})\b/.exec([...mails()].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? null;
const logged: string[] = [];
for (const k of ["log", "warn", "error"] as const) {
  const orig = console[k];
  console[k] = (...a: unknown[]) => {
    logged.push(a.map(String).join(" "));
    orig(...a);
  };
}
const resetCooldown = (email: string) => prisma.emailOtpRequest.updateMany({ where: { email }, data: { lastSentAt: new Date(Date.now() - 120_000), createdAt: new Date(Date.now() - 86_400_000 * 2) } });
const IP = "198.51.100.7";

async function main() {
  fs.writeFileSync(FILE, JSON.stringify({ messages: [] }));
  await prisma.emailOtpRequest.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await setEmailOtpEnabled(true, "test");
  const role = async (name: "MASTER_ADMIN" | "FULL_ADMIN" | "TEACHER") => prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  const hash = await argon2.hash("Unused-Pass-123!");
  const mk = async (username: string, email: string | null, r: "MASTER_ADMIN" | "FULL_ADMIN" | "TEACHER", isActive = true) =>
    prisma.adminUser.upsert({ where: { username }, update: { email, isActive, roleId: (await role(r)).id }, create: { name: username, username, email, isActive, passwordHash: hash, roleId: (await role(r)).id } });
  const master = await mk("otp-master", "master@aotp.example.test", "MASTER_ADMIN");
  await mk("otp-full", "full@aotp.example.test", "FULL_ADMIN");
  await mk("otp-off", "off@aotp.example.test", "MASTER_ADMIN", false);
  await mk("otp-teacher", "teacher@aotp.example.test", "TEACHER");
  await mk("otp-noemail", null, "MASTER_ADMIN");
  await mk("otp-unverified", "unverified@aotp.example.test", "MASTER_ADMIN");
  await prisma.adminUser.updateMany({ where: { username: { in: ["otp-master", "otp-full", "otp-off", "otp-teacher"] } }, data: { emailVerifiedAt: new Date() } });
  await prisma.adminUser.update({ where: { username: "otp-unverified" }, data: { emailVerifiedAt: null } });

  console.log("\n=== emergency switch (security.admin_otp_login)");
  await prisma.setting.deleteMany({ where: { key: ADMIN_OTP_SETTING_KEY } });
  clearAdminOtpLoginCache();
  check("missing setting → OFF", (await isAdminOtpLoginEnabled()) === false);
  for (const bad of [{}, { enabled: "true" }, { enabled: 1 }, "on", true]) {
    await prisma.setting.upsert({ where: { key: ADMIN_OTP_SETTING_KEY }, create: { key: ADMIN_OTP_SETTING_KEY, value: bad }, update: { value: bad } });
    clearAdminOtpLoginCache();
    check(`malformed value ${JSON.stringify(bad)} → OFF`, (await isAdminOtpLoginEnabled()) === false);
  }
  await prisma.setting.update({ where: { key: ADMIN_OTP_SETTING_KEY }, data: { value: { enabled: true } } });
  const realFind = prisma.setting.findUnique;
  (prisma.setting as { findUnique: unknown }).findUnique = async () => { throw new Error("simulated read failure"); };
  clearAdminOtpLoginCache();
  check("setting read failure → OFF", (await isAdminOtpLoginEnabled()) === false);
  (prisma.setting as { findUnique: unknown }).findUnique = realFind;
  check("read failure is not cached (next read sees the stored ON)", (await isAdminOtpLoginEnabled()) === true);
  await saveAdminOtpLoginEnabled(true);
  clearAdminOtpLoginCache();
  check("ON saved → ON", (await isAdminOtpLoginEnabled()) === true && (await prisma.setting.findUnique({ where: { key: ADMIN_OTP_SETTING_KEY } }))?.value !== null);
  // Get a valid code while ON, then switch OFF: request suppressed, the valid code is rejected.
  await requestAdminLoginOtp("otp-master", IP);
  const offCode = lastCode("master@aotp.example.test");
  const sentWhileOn = mails().length;
  await saveAdminOtpLoginEnabled(false);
  check("OFF: request → generic answer", (await requestAdminLoginOtp("otp-master", IP)).message === ADMIN_OTP_SENT);
  check("OFF: no email sent", mails().length === sentWhileOn && sentWhileOn === 1);
  const offAttempts = await prisma.loginAttempt.count();
  check("OFF: valid code rejected", (await authorizeAdminOtp("otp-master", offCode, IP)) === null);
  check("OFF: rejection writes no login attempt / never checks the code", (await prisma.loginAttempt.count()) === offAttempts);
  clearAdminOtpLoginCache();
  check("OFF persists after cache drop", (await isAdminOtpLoginEnabled()) === false);
  await saveAdminOtpLoginEnabled(true);
  check("back ON: the same still-valid code now signs in", (await authorizeAdminOtp("otp-master", offCode, IP))?.id === master.id);
  await prisma.emailOtpRequest.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  fs.writeFileSync(FILE, JSON.stringify({ messages: [] }));
  // The remaining suite exercises the feature with the switch ON.

  console.log("\n=== request: same answer for everyone, code only to eligible accounts");
  for (const id of ["nobody", "nobody@example.test", "otp-off", "otp-teacher", "otp-noemail", "otp-unverified", "unverified@aotp.example.test"]) check(`no code + generic answer for ${id}`, (await requestAdminLoginOtp(id, IP)).message === ADMIN_OTP_SENT);
  check("no email sent for ineligible identifiers", mails().length === 0, mails().map((m) => m.to));
  check("eligible username → generic answer", (await requestAdminLoginOtp("OTP-Master", IP)).message === ADMIN_OTP_SENT);
  check("code emailed to the registered address only", mails().length === 1 && mails()[0].to === "master@aotp.example.test" && /admin login code/i.test(mails()[0].subject));
  const code1 = lastCode("master@aotp.example.test")!;
  await requestAdminLoginOtp("otp-master", IP);
  check("resend within 60 s: no second email (cooldown), same answer", mails().length === 1);

  console.log("\n=== verify");
  check("wrong code → refused", (await authorizeAdminOtp("otp-master", code1 === "000000" ? "111111" : "000000", IP)) === null);
  check("non-numeric code → refused", (await authorizeAdminOtp("otp-master", "12ab56", IP)) === null);
  const u = await authorizeAdminOtp("otp-master", code1, IP);
  check("correct code → normal session user (id, name, email, role)", !!u && u.id === master.id && u.role === "MASTER_ADMIN" && u.email === "master@aotp.example.test", u);
  check("replay of the same code → refused", (await authorizeAdminOtp("otp-master", code1, IP)) === null);
  const audit = await prisma.auditLog.findFirst({ where: { action: "ADMIN_LOGIN", actorId: master.id }, orderBy: { createdAt: "desc" } });
  check("audit log ADMIN_LOGIN with method email_otp; lastLoginAt set", (audit?.metadata as { method?: string } | null)?.method === "email_otp" && !!(await prisma.adminUser.findUnique({ where: { id: master.id } }))?.lastLoginAt);

  console.log("\n=== email identifier, FULL_ADMIN keeps its role");
  await requestAdminLoginOtp("full@aotp.example.test", IP);
  const fu = await authorizeAdminOtp("FULL@aotp.example.test", lastCode("full@aotp.example.test"), IP);
  check("login by registered email works; role stays FULL_ADMIN (RBAC unchanged)", fu?.role === "FULL_ADMIN", fu);

  console.log("\n=== attempt cap, expiry, deactivated after send");
  await resetCooldown("master@aotp.example.test");
  await requestAdminLoginOtp("otp-master", IP);
  const code2 = lastCode("master@aotp.example.test")!;
  for (let i = 0; i < 5; i++) await authorizeAdminOtp("otp-master", code2 === "999999" ? "888888" : "999999", "198.51.100.8");
  check("after 5 wrong codes the right code no longer works", (await authorizeAdminOtp("otp-master", code2, "198.51.100.8")) === null);
  await resetCooldown("master@aotp.example.test");
  await requestAdminLoginOtp("otp-master", IP);
  await prisma.emailOtpRequest.updateMany({ where: { email: "master@aotp.example.test", consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  check("expired code → refused", (await authorizeAdminOtp("otp-master", lastCode("master@aotp.example.test"), "198.51.100.9")) === null);
  await resetCooldown("full@aotp.example.test");
  await requestAdminLoginOtp("otp-full", IP);
  await prisma.adminUser.update({ where: { username: "otp-full" }, data: { isActive: false } });
  check("account deactivated after the code was sent → refused", (await authorizeAdminOtp("otp-full", lastCode("full@aotp.example.test"), "198.51.100.10")) === null);

  console.log("\n=== lockout shared with password login");
  const ip2 = "198.51.100.11";
  let locked = false;
  for (let i = 0; i < 10; i++) {
    try {
      await authorizeAdminOtp("otp-master", "123456", ip2);
    } catch (e) {
      locked = e instanceof Error && e.message === "TooManyAttempts";
      break;
    }
  }
  check("repeated failures → TooManyAttempts (same LoginAttempt window as password login)", locked);

  const codes = mails().map((m) => /\b(\d{6})\b/.exec(m.text)?.[1]).filter(Boolean) as string[];
  check("no OTP value ever written to the logs", !logged.some((l) => codes.some((c) => l.includes(c))));
  check("codes stored only as hashes", (await prisma.emailOtpRequest.findMany({ select: { otpHash: true } })).every((r) => r.otpHash.length === 64 && !codes.includes(r.otpHash)));
  console.log("\n=== email verification (Edit Admin) → OTP eligibility");
  await resetCooldown("unverified@aotp.example.test");
  const unv = await prisma.adminUser.findUniqueOrThrow({ where: { username: "otp-unverified" } });
  check("unverified email: OTP login rejected", (await authorizeAdminOtp("otp-unverified", "123456", "198.51.100.20")) === null);
  await sendAdminEmailVerification(unv.id, "198.51.100.20");
  const vmail = [...mails()].reverse().find((m) => m.to === "unverified@aotp.example.test");
  check("verification code emailed (captured) with the verify subject", !!vmail && /verification code/i.test(vmail.subject));
  let wrongRejected = false;
  try { await verifyAdminEmail(unv.id, lastCode("unverified@aotp.example.test") === "000000" ? "111111" : "000000", master.id); } catch (e) { wrongRejected = e instanceof EmailOtpError; }
  check("wrong verification code rejected, still unverified", wrongRejected && !(await prisma.adminUser.findUniqueOrThrow({ where: { id: unv.id } })).emailVerifiedAt);
  await verifyAdminEmail(unv.id, lastCode("unverified@aotp.example.test")!, master.id);
  check("correct code → Verified + audit ADMIN_EMAIL_VERIFIED", !!(await prisma.adminUser.findUniqueOrThrow({ where: { id: unv.id } })).emailVerifiedAt && (await prisma.auditLog.count({ where: { action: "ADMIN_EMAIL_VERIFIED", entityId: unv.id } })) === 1);
  const r = await requestAdminLoginOtp("otp-unverified", "198.51.100.21");
  const lc = lastCode("unverified@aotp.example.test");
  check("now verified: login code emailed", r.ok && /admin login code/i.test([...mails()].reverse().find((m) => m.to === "unverified@aotp.example.test")?.subject ?? ""));
  check("verified admin signs in with the code", (await authorizeAdminOtp("otp-unverified", lc, "198.51.100.21"))?.id === unv.id);

  console.log("\n=== honest errors");
  const realAvail = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const un = await requestAdminLoginOtp("nobody", "198.51.100.22");
  process.env.RESEND_API_KEY = realAvail;
  check("provider not configured → error for everyone, never 'sent'", !un.ok && un.message === ADMIN_OTP_UNAVAILABLE, un);
  console.log(`\n${pass} passed, ${fail} failed`);
}
main().then(() => prisma.$disconnect()).then(() => process.exit(fail ? 1 : 0)).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
