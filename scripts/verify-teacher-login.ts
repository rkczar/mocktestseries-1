/**
 * Teacher Login (username/password OR registered-mobile OTP) — server regression.
 *
 *   DATABASE_URL=<scratch mts_*> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/verify-teacher-login.ts
 *
 * Synthetic data only (prefix TLG-). No MSG91 credentials on the scratch DB, so
 * lib/otp.ts uses the dev console provider and hands back the code (devCode);
 * the browser suite (verify-teacher-login-http.mjs) covers the MSG91 Widget path
 * through scripts/msg91-widget-mock.mjs. Each section uses its own fake IP so
 * the per-IP limits of one section don't leak into the next.
 */
import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { verifyOtp, OtpError } from "@/lib/otp";
import { TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/auth-rate-limit";
import {
  OTP_SENT_GENERIC,
  TEACHER_INACTIVE,
  TeacherAuthError,
  authorizeTeacherOtp,
  authorizeTeacherPassword,
  confirmTeacherMobile,
  otpAttemptKey,
  requestTeacherLoginOtp,
  sendTeacherMobileVerifyCode,
} from "@/lib/teacher/auth";
import { createTeacher, setTeacherMobile, setTeacherStatus } from "@/lib/teacher/manage";
import { teacherScope } from "@/lib/teacher/scope";

let passes = 0;
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (ok) passes++;
  else failures++;
}
const section = (t: string) => console.log(`\n== ${t}`);
let ipN = 0;
const freshIp = () => `10.77.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
const rnd = (lead: string) => `${lead}${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const e164 = (d: string) => `+91${d}`;
const NO_PENDING = "No pending verification code for this number. Please request a new one.";

async function errorOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof TeacherAuthError || e instanceof OtpError ? e.message : `UNEXPECTED ${String(e)}`;
  }
}
const openCodes = (mobile: string) => prisma.otpRequest.count({ where: { mobile, purpose: "TEACHER_LOGIN", consumedAt: null } });

async function main() {
  const db = (process.env.DATABASE_URL ?? "").replace(/\?.*$/, "").split("/").pop() ?? "";
  if (!/^mts_/.test(db)) throw new Error("Refusing to run outside a scratch mts_* database.");
  const sfx = Date.now().toString(36);
  const role = (name: "TEACHER" | "MASTER_ADMIN") => prisma.role.upsert({ where: { name }, create: { name }, update: {} });
  const mRole = await role("MASTER_ADMIN");
  await role("TEACHER");
  const users: string[] = [];
  const mobiles: string[] = [];
  const master = await prisma.adminUser.create({ data: { name: "TLG Master", username: `tlg-master-${sfx}`, passwordHash: await argon2.hash("tlg-master-pass-1"), roleId: mRole.id } });
  users.push(master.id);
  const M = master.id;
  const examX = await prisma.exam.create({ data: { name: `TLG X ${sfx}`, code: `TLGX${sfx}`.toUpperCase(), isActive: true } });
  const examY = await prisma.exam.create({ data: { name: `TLG Y ${sfx}`, code: `TLGY${sfx}`.toUpperCase(), isActive: true } });
  const PASS = "tlg-password-123";

  const mk = async (tag: string, extra: Partial<{ examIds: string[]; status: "ACTIVE" | "SUSPENDED" }> = {}) => {
    const mobile = rnd("9");
    mobiles.push(e164(mobile));
    const r = await createTeacher(M, { name: `TLG ${tag}`, username: `tlg-${tag}-${sfx}`, password: PASS, mobile, ...extra });
    if (!r.ok) throw new Error(`createTeacher ${tag}: ${r.error}`);
    const u = await prisma.adminUser.findUniqueOrThrow({ where: { username: `tlg-${tag}-${sfx}` } });
    users.push(u.id);
    return { id: u.id, username: u.username, mobile: e164(mobile), digits: mobile };
  };
  /** Verifies a teacher's registered mobile through the portal flow (send + confirm). */
  const verifyMobile = async (id: string) => {
    const { devCode } = await sendTeacherMobileVerifyCode(id, freshIp());
    await confirmTeacherMobile(id, devCode);
  };
  /** Clears a number's failure rows (stands in for the 15-minute window passing). */
  const forgive = (mobile: string) => prisma.loginAttempt.deleteMany({ where: { username: otpAttemptKey(mobile) } });
  /** Pushes earlier sends past the 60 s cooldown and the 15-minute send cap (real caps are checked in E). */
  const coolDown = (mobile: string) =>
    prisma.otpRequest.updateMany({ where: { mobile, purpose: "TEACHER_LOGIN" }, data: { lastSentAt: new Date(Date.now() - 61_000), createdAt: new Date(Date.now() - 16 * 60_000) } });

  try {
    section("A. Account creation (Master Admin only)");
    const a = await mk("a", { examIds: [examX.id] });
    const prof = await prisma.teacherProfile.findUniqueOrThrow({ where: { adminUserId: a.id } });
    check("created with registered mobile (E.164), unverified", prof.mobile === a.mobile && prof.mobileVerifiedAt === null, prof);
    check("assigned exams saved at creation", (await teacherScope(a.id))?.examIds.join() === examX.id);
    check("TEACHER_CREATED audit masks the mobile", JSON.stringify((await prisma.auditLog.findFirst({ where: { action: "TEACHER_CREATED", entityId: a.id } }))?.metadata).includes(`******${a.digits.slice(-4)}`));
    check("duplicate mobile refused", !(await createTeacher(M, { name: "dup", username: `tlg-dup-${sfx}`, password: PASS, mobile: a.digits })).ok);
    check("invalid mobile refused", !(await createTeacher(M, { name: "bad", username: `tlg-bad-${sfx}`, password: PASS, mobile: "12345" })).ok);
    check("missing mobile refused", !(await createTeacher(M, { name: "none", username: `tlg-none-${sfx}`, password: PASS, mobile: "" })).ok);
    const s0 = await mk("s0", { status: "SUSPENDED" });
    check("created as Suspended when chosen", (await prisma.teacherProfile.findUniqueOrThrow({ where: { adminUserId: s0.id } })).status === "SUSPENDED");

    section("B. Username & Password");
    let ip = freshIp();
    const okUser = await authorizeTeacherPassword(a.username, PASS, ip);
    check("valid teacher login → TEACHER session user", okUser?.id === a.id && okUser.role === "TEACHER", okUser);
    check("success recorded + TEACHER_LOGIN audit (method password)", Boolean(await prisma.auditLog.findFirst({ where: { action: "TEACHER_LOGIN", entityId: a.id, metadata: { path: ["method"], equals: "password" } } })));
    check("username is case-insensitive", (await authorizeTeacherPassword(a.username.toUpperCase(), PASS, ip))?.id === a.id);
    check("wrong password → null", (await authorizeTeacherPassword(a.username, "wrong-password", ip)) === null);
    check("unknown username → null", (await authorizeTeacherPassword(`nobody-${sfx}`, PASS, ip)) === null);
    check("Master Admin account refused on the teacher form", (await authorizeTeacherPassword(master.username, "tlg-master-pass-1", ip)) === null);
    check("suspended (created) + right password → inactive notice", (await errorOf(() => authorizeTeacherPassword(s0.username, PASS, freshIp()))) === TEACHER_INACTIVE);
    check("suspended + wrong password → plain null (no status leak)", (await authorizeTeacherPassword(s0.username, "wrong-password", freshIp())) === null);
    const d = await mk("d");
    await setTeacherStatus(M, d.id, "DEACTIVATED");
    check("deactivated + right password → inactive notice", (await errorOf(() => authorizeTeacherPassword(d.username, PASS, freshIp()))) === TEACHER_INACTIVE);
    const lockUser = await mk("lock");
    ip = freshIp();
    for (let i = 0; i < 8; i++) await authorizeTeacherPassword(lockUser.username, "wrong-password", ip);
    check("8 failures / 15 min → locked even with the right password", (await errorOf(() => authorizeTeacherPassword(lockUser.username, PASS, ip))) === TOO_MANY_ATTEMPTS_MESSAGE);
    check("lock is per username+IP: another IP still signs in", (await authorizeTeacherPassword(lockUser.username, PASS, freshIp()))?.id === lockUser.id);

    section("C. Registered-mobile verification (portal)");
    const b = await mk("b", { examIds: [examY.id] });
    ip = freshIp();
    const t0 = Date.now();
    const unverifiedSend = await requestTeacherLoginOtp(b.digits, ip);
    check("unverified number: generic answer, no code issued", !unverifiedSend.devCode && (await openCodes(b.mobile)) === 0);
    check("…and the answer took ≥ 1.5 s (timing padded)", Date.now() - t0 >= 1450);
    const v = await sendTeacherMobileVerifyCode(b.id, freshIp());
    check("portal sends a code to the REGISTERED number only", Boolean(v.devCode) && (await openCodes(b.mobile)) === 1);
    check("wrong code doesn't verify", (await errorOf(() => confirmTeacherMobile(b.id, "000000"))) !== null || (await prisma.teacherProfile.findUniqueOrThrow({ where: { adminUserId: b.id } })).mobileVerifiedAt === null);
    await coolDown(b.mobile);
    const v2 = await sendTeacherMobileVerifyCode(b.id, freshIp());
    await confirmTeacherMobile(b.id, v2.devCode);
    check("right code verifies the mobile (OTP login on)", (await prisma.teacherProfile.findUniqueOrThrow({ where: { adminUserId: b.id } })).mobileVerifiedAt !== null);
    check("TEACHER_MOBILE_VERIFIED audited", Boolean(await prisma.auditLog.findFirst({ where: { action: "TEACHER_MOBILE_VERIFIED", entityId: b.id } })));
    check("already verified → no further code", (await errorOf(() => sendTeacherMobileVerifyCode(b.id, freshIp()))) === "Your mobile number is already verified.");

    section("D. Login with OTP");
    await coolDown(b.mobile);
    ip = freshIp();
    const s1 = await requestTeacherLoginOtp(b.digits, ip);
    const row = await prisma.otpRequest.findFirst({ where: { purpose: "TEACHER_LOGIN", consumedAt: null }, orderBy: { createdAt: "desc" } });
    check("registered active verified mobile → code issued", Boolean(s1.devCode));
    check("code row is for exactly the registered number, purpose TEACHER_LOGIN", row?.mobile === b.mobile);
    check("code stored hashed (no plaintext)", Boolean(row && !row.otpHash.includes(s1.devCode!) && row.otpHash.startsWith("$argon2")));
    check("code valid for 5 minutes, 5 attempts", Boolean(row && Math.abs(row.expiresAt.getTime() - row.createdAt.getTime() - 300_000) < 5000 && row.maxAttempts === 5));
    const wrong = s1.devCode === "000000" ? "111111" : "000000";
    check("incorrect OTP → 'Incorrect code.'", (await errorOf(() => authorizeTeacherOtp(b.digits, wrong, ip))) === "Incorrect code.");
    check("malformed code refused before any lookup", (await errorOf(() => authorizeTeacherOtp(b.digits, "12ab", ip))) === "Enter the 6-digit code.");
    const user = await authorizeTeacherOtp(`+91 ${b.digits}`, s1.devCode, ip);
    check("correct OTP → same teacher identity (role TEACHER)", user.id === b.id && user.role === "TEACHER");
    check("TEACHER_LOGIN audit (method otp)", Boolean(await prisma.auditLog.findFirst({ where: { action: "TEACHER_LOGIN", entityId: b.id, metadata: { path: ["method"], equals: "otp" } } })));
    check("exam assignments preserved after OTP login", (await teacherScope(b.id))?.examIds.join() === examY.id);
    check("reused OTP refused", (await errorOf(() => authorizeTeacherOtp(b.digits, s1.devCode, freshIp()))) === NO_PENDING);

    // Resend cooldown
    await coolDown(b.mobile);
    const r1 = await requestTeacherLoginOtp(b.digits, freshIp());
    const before = await prisma.otpRequest.count({ where: { mobile: b.mobile, purpose: "TEACHER_LOGIN" } });
    const r2 = await requestTeacherLoginOtp(b.digits, freshIp());
    check("resend within 60 s: no new code (generic answer)", !r2.devCode && (await prisma.otpRequest.count({ where: { mobile: b.mobile, purpose: "TEACHER_LOGIN" } })) === before);
    // A newer code invalidates the older one.
    await coolDown(b.mobile);
    const r3 = await requestTeacherLoginOtp(b.digits, freshIp());
    check("new code closes the older open code", (await openCodes(b.mobile)) === 1);
    if (r1.devCode !== r3.devCode) check("older code no longer works", (await errorOf(() => authorizeTeacherOtp(b.digits, r1.devCode, freshIp()))) === "Incorrect code.");
    // Expiry
    await prisma.otpRequest.updateMany({ where: { mobile: b.mobile, purpose: "TEACHER_LOGIN", consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    check("expired OTP refused", (await errorOf(() => authorizeTeacherOtp(b.digits, r3.devCode, freshIp()))) === "This code has expired. Please request a new one.");
    // 5 incorrect attempts per challenge (fresh number-lock window so only the per-code cap is under test)
    await forgive(b.mobile);
    await coolDown(b.mobile);
    const r4 = await requestTeacherLoginOtp(b.digits, freshIp());
    const bad = r4.devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await errorOf(() => authorizeTeacherOtp(b.digits, bad, freshIp()));
    check("6th try after 5 wrong → challenge locked, even with the right code", (await errorOf(() => authorizeTeacherOtp(b.digits, r4.devCode, freshIp()))) === "Too many incorrect attempts. Please request a new code.");

    section("E. Enumeration protection & rate limits");
    const stranger = rnd("7");
    ip = freshIp();
    const ts = Date.now();
    const strangerSend = await requestTeacherLoginOtp(stranger, ip);
    check("unregistered number: same generic answer, no code, nothing sent", !strangerSend.devCode && (await prisma.otpRequest.count({ where: { mobile: e164(stranger) } })) === 0);
    check("…timing padded like a real send", Date.now() - ts >= 1450);
    check("unregistered verify → same text as a registered number with no code", (await errorOf(() => authorizeTeacherOtp(stranger, "123456", freshIp()))) === NO_PENDING);
    check("OTP_SENT_GENERIC never names an account", !/teacher account exists|not registered|no account/i.test(OTP_SENT_GENERIC));
    check("invalid number format → validation message", (await errorOf(() => requestTeacherLoginOtp("12345", freshIp()))) === "Enter a valid 10-digit Indian mobile number.");
    ip = freshIp();
    for (let i = 0; i < 20; i++) await requestTeacherLoginOtp(rnd("6"), ip).catch(() => undefined);
    check("one IP probing 20 numbers → blocked", (await errorOf(() => requestTeacherLoginOtp(rnd("6"), ip))) === TOO_MANY_ATTEMPTS_MESSAGE);
    const probed = rnd("8");
    for (let i = 0; i < 10; i++) await errorOf(() => authorizeTeacherOtp(probed, "123456", freshIp()));
    check("one number guessed from 10 IPs → number locked", (await errorOf(() => authorizeTeacherOtp(probed, "123456", freshIp()))) === TOO_MANY_ATTEMPTS_MESSAGE);
    const vIp = freshIp();
    for (let i = 0; i < 8; i++) await errorOf(() => authorizeTeacherOtp(stranger, "123456", vIp));
    check("8 failed verifies from one IP on one number → locked", (await errorOf(() => authorizeTeacherOtp(stranger, "123456", vIp))) === TOO_MANY_ATTEMPTS_MESSAGE);
    check("failure rows store the number key, never a code", (await prisma.loginAttempt.count({ where: { username: { contains: "123456" } } })) === 0 && (await prisma.loginAttempt.count({ where: { username: otpAttemptKey(e164(stranger)) } })) > 0);

    section("F. Student OTP isolation");
    await forgive(b.mobile);
    await coolDown(b.mobile);
    const r5 = await requestTeacherLoginOtp(b.digits, freshIp());
    check("teacher code can't be used as a student LOGIN code", (await errorOf(() => verifyOtp(b.mobile, "LOGIN", r5.devCode!))) !== null);
    check("teacher code still open after the student attempt", (await openCodes(b.mobile)) === 1);

    section("G. Suspend / deactivate");
    const c = await mk("c", { examIds: [examX.id] });
    await verifyMobile(c.id);
    await coolDown(c.mobile);
    const pending = await requestTeacherLoginOtp(c.digits, freshIp());
    check("active teacher C gets a code", Boolean(pending.devCode));
    const tSusp = Date.now();
    await setTeacherStatus(M, c.id, "SUSPENDED");
    check("suspend ends existing sessions (sessionsValidAfter stamped)", ((await prisma.adminUser.findUniqueOrThrow({ where: { id: c.id } })).sessionsValidAfter?.getTime() ?? 0) >= tSusp - 1000);
    check("suspended: pending code no longer signs in", (await errorOf(() => authorizeTeacherOtp(c.digits, pending.devCode, freshIp()))) === NO_PENDING);
    await coolDown(c.mobile);
    check("suspended: no new code sent", !(await requestTeacherLoginOtp(c.digits, freshIp())).devCode);
    check("suspended: password login blocked", (await errorOf(() => authorizeTeacherPassword(c.username, PASS, freshIp()))) === TEACHER_INACTIVE);
    await setTeacherStatus(M, c.id, "DEACTIVATED");
    await coolDown(c.mobile);
    check("deactivated: no code sent", !(await requestTeacherLoginOtp(c.digits, freshIp())).devCode);
    check("deactivated: scope gone", (await teacherScope(c.id)) === null);
    await setTeacherStatus(M, c.id, "ACTIVE");
    await coolDown(c.mobile);
    check("re-activated: OTP works again on the still-verified number", Boolean((await requestTeacherLoginOtp(c.digits, freshIp())).devCode));

    section("H. Mobile changed by Master Admin");
    await coolDown(c.mobile);
    const oldCode = await requestTeacherLoginOtp(c.digits, freshIp());
    const newDigits = rnd("6");
    mobiles.push(e164(newDigits));
    const ch = await setTeacherMobile(M, c.id, newDigits);
    const p2 = await prisma.teacherProfile.findUniqueOrThrow({ where: { adminUserId: c.id } });
    check("change saved, verification reset", ch.ok && p2.mobile === e164(newDigits) && p2.mobileVerifiedAt === null, ch);
    const audit = await prisma.auditLog.findFirst({ where: { action: "TEACHER_MOBILE_CHANGED", entityId: c.id }, orderBy: { createdAt: "desc" } });
    check("TEACHER_MOBILE_CHANGED audited with masked old/new numbers", (audit?.metadata as { from?: string; to?: string } | null)?.from === `+91 ******${c.digits.slice(-4)}` && (audit?.metadata as { to?: string } | null)?.to === `+91 ******${newDigits.slice(-4)}`, audit?.metadata);
    check("old number: pending code closed + can't sign in", (await openCodes(c.mobile)) === 0 && (await errorOf(() => authorizeTeacherOtp(c.digits, oldCode.devCode, freshIp()))) === NO_PENDING);
    check("old number: no new code", !(await requestTeacherLoginOtp(c.digits, freshIp())).devCode);
    check("new number: no code until verified", !(await requestTeacherLoginOtp(newDigits, freshIp())).devCode);
    await verifyMobile(c.id);
    await coolDown(e164(newDigits));
    const nc = await requestTeacherLoginOtp(newDigits, freshIp());
    check("new number after verification: OTP login works", (await authorizeTeacherOtp(newDigits, nc.devCode, freshIp())).id === c.id);
    check("changing to another teacher's number refused", !(await setTeacherMobile(M, c.id, a.digits)).ok);
    check("same number again refused (no-op)", !(await setTeacherMobile(M, c.id, newDigits)).ok);
    check("non-teacher account refused", !(await setTeacherMobile(M, master.id, rnd("9"))).ok);

    section("I. Cross-account isolation");
    await forgive(b.mobile);
    await coolDown(b.mobile);
    const bc = await requestTeacherLoginOtp(b.digits, freshIp());
    check("B's code can't sign in on C's number", (await errorOf(() => authorizeTeacherOtp(newDigits, bc.devCode, freshIp()))) !== null);
    const bUser = await authorizeTeacherOtp(b.digits, bc.devCode, freshIp());
    check("B's code signs in B only, B's scope = exam Y only", bUser.id === b.id && (await teacherScope(b.id))?.examIds.join() === examY.id);
  } finally {
    await prisma.otpRequest.deleteMany({ where: { mobile: { in: mobiles } } });
    await prisma.loginAttempt.deleteMany({ where: { OR: [{ adminUserId: { in: users } }, { username: { startsWith: "otp:" } }, { ipAddress: { startsWith: "10.77." } }] } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: users } }, { entityId: { in: users } }] } });
    await prisma.teacherExamAssignment.deleteMany({ where: { teacherId: { in: users } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: users } } });
    await prisma.exam.deleteMany({ where: { id: { in: [examX.id, examY.id] } } });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
