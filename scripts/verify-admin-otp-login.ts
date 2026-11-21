/**
 * Admin "Login with OTP" (library level; scratch DB mts_aotp only; Resend answered in-process — no real email).
 *   NODE_OPTIONS="--conditions=react-server --import ./scripts/resend-mock.mjs" RESEND_MOCK_FILE=<tmp>/resend.json \
 *   RESEND_API_KEY=re_mock_test_key AUTH_SECRET=… DATABASE_URL=<scratch mts_aotp> npx tsx scripts/verify-admin-otp-login.ts
 */
import fs from "node:fs";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { ADMIN_OTP_SENT, authorizeAdminOtp, requestAdminLoginOtp } from "@/lib/admin-otp-login";
import { setEmailOtpEnabled } from "@/lib/email-otp";

if (!/\/mts_aotp(\?|$)/.test(process.env.DATABASE_URL ?? "")) throw new Error("Refusing: not the scratch mts_aotp database.");
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

  console.log("\n=== request: same answer for everyone, code only to eligible accounts");
  for (const id of ["nobody", "nobody@example.test", "otp-off", "otp-teacher", "otp-noemail"]) check(`no code + generic answer for ${id}`, (await requestAdminLoginOtp(id, IP)) === ADMIN_OTP_SENT);
  check("no email sent for ineligible identifiers", mails().length === 0, mails().map((m) => m.to));
  check("eligible username → generic answer", (await requestAdminLoginOtp("OTP-Master", IP)) === ADMIN_OTP_SENT);
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
  console.log(`\n${pass} passed, ${fail} failed`);
}
main().then(() => prisma.$disconnect()).then(() => process.exit(fail ? 1 : 0)).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
