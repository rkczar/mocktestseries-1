import "server-only";
import argon2 from "argon2";
import { prisma } from "@/lib/prisma";
import { requestOtp, verifyOtp, OtpError } from "@/lib/otp";
import { isAdminLoginBlocked, TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/auth-rate-limit";
import { parseIndianMobile, INDIAN_MOBILE_ERROR } from "@/lib/indian-mobile";

/**
 * Teacher sign-in at /teacher: username + password OR an OTP sent to the
 * mobile the Master Admin registered (TeacherProfile.mobile, usable only once
 * verified). Both resolve to the same AdminUser (role TEACHER) and the same
 * admin JWT session, so every Phase A/B check (lib/rbac.ts, lib/teacher/scope.ts)
 * applies unchanged. Reuses lib/otp.ts (MSG91 Widget, hashed codes, 5 min,
 * 5 attempts, 60 s cooldown, per-mobile/IP/global send caps) with its own
 * purpose TEACHER_LOGIN, and LoginAttempt for failure limits. Codes and
 * numbers are never logged.
 */

export const TEACHER_INACTIVE = "This teacher account is not active. Please contact the Master Admin.";
export const OTP_SENT = "A 6-digit code has been sent to your registered mobile number.";
/** Identical answer for unregistered, unverified, suspended and deactivated numbers. */
export const OTP_NOT_AVAILABLE =
  "No code was sent. OTP login works only for a verified registered mobile. Please log in with your username and password, then verify your mobile in the Teacher Portal.";
/** Same wording lib/otp.ts uses, so an unregistered number answers exactly like a registered one with no code. */
const NO_PENDING = "No pending verification code for this number. Please request a new one.";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_IN_WINDOW = 8;
/** Every OTP request answers no sooner than this, so timing doesn't reveal whether an SMS was sent. */
const MIN_SEND_RESPONSE_MS = 1500;
// Verified against when the username is unknown, so both paths cost one argon2 verify.
const DUMMY_HASH = argon2.hash("teacher-login-timing-equaliser");

export class TeacherAuthError extends Error {}

export interface TeacherSessionUser {
  id: string;
  name: string;
  email?: string;
  role: "TEACHER";
}

/** LoginAttempt identifier for everything OTP-related on one number. */
export const otpAttemptKey = (e164: string) => `otp:${e164}`;

export function maskMobile(e164: string | null | undefined): string | null {
  return e164 ? `+91 ******${e164.slice(-4)}` : null;
}

async function assertNotBlocked(key: string, ip: string) {
  const recent = await prisma.loginAttempt.count({
    where: { username: key, ipAddress: ip, createdAt: { gte: new Date(Date.now() - LOGIN_WINDOW_MS) } },
  });
  if (recent >= MAX_ATTEMPTS_IN_WINDOW || (await isAdminLoginBlocked(key, ip))) throw new TeacherAuthError(TOO_MANY_ATTEMPTS_MESSAGE);
}

async function signedIn(user: { id: string; name: string; email: string | null }, key: string, ip: string, method: "password" | "otp"): Promise<TeacherSessionUser> {
  await prisma.loginAttempt.create({ data: { username: key, ipAddress: ip, success: true, adminUserId: user.id } });
  await prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditLog.create({ data: { actorId: user.id, action: "TEACHER_LOGIN", entityType: "AdminUser", entityId: user.id, metadata: { method } } });
  return { id: user.id, name: user.name, email: user.email ?? undefined, role: "TEACHER" };
}

/** Option A. Only TEACHER accounts can sign in here; admins keep /admin/login. */
export async function authorizeTeacherPassword(usernameInput: unknown, passwordInput: unknown, ip: string): Promise<TeacherSessionUser | null> {
  const username = String(usernameInput ?? "").trim().toLowerCase();
  const password = String(passwordInput ?? "");
  if (!username || !password) return null;
  await assertNotBlocked(username, ip);

  const user = await prisma.adminUser.findUnique({
    where: { username },
    select: { id: true, name: true, email: true, passwordHash: true, isActive: true, role: { select: { name: true } }, teacherProfile: { select: { status: true } } },
  });
  const teacher = user?.role.name === "TEACHER" ? user : null;
  const passwordOk = await argon2.verify(teacher?.passwordHash ?? (await DUMMY_HASH), password).catch(() => false);
  const ok = Boolean(teacher && passwordOk);
  const active = Boolean(teacher?.isActive && teacher.teacherProfile?.status === "ACTIVE");

  if (!ok || !active) {
    await prisma.loginAttempt.create({ data: { username, ipAddress: ip, success: false, adminUserId: user?.id } });
    // The inactive notice is shown only to someone who knows the password.
    if (ok) throw new TeacherAuthError(TEACHER_INACTIVE);
    return null;
  }
  return signedIn(teacher!, username, ip, "password");
}

/** The active teacher whose VERIFIED registered mobile this is, or null. */
async function findOtpTeacher(e164: string) {
  const profile = await prisma.teacherProfile.findUnique({
    where: { mobile: e164 },
    select: { status: true, mobileVerifiedAt: true, adminUser: { select: { id: true, name: true, email: true, isActive: true, role: { select: { name: true } } } } },
  });
  if (!profile?.mobileVerifiedAt || profile.status !== "ACTIVE") return null;
  const u = profile.adminUser;
  return u.isActive && u.role.name === "TEACHER" ? u : null;
}

/** A new code supersedes every older open code for the number. */
async function closeOlderCodes(e164: string) {
  const latest = await prisma.otpRequest.findFirst({ where: { mobile: e164, purpose: "TEACHER_LOGIN", consumedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } });
  if (!latest) return;
  await prisma.otpRequest.updateMany({
    where: { mobile: e164, purpose: "TEACHER_LOGIN", consumedAt: null, id: { not: latest.id }, createdAt: { lte: latest.createdAt } },
    data: { consumedAt: new Date() },
  });
}

/**
 * Option B, step 1. Sends a code only to a verified registered mobile of an
 * active teacher and resolves only when MSG91 accepted it. Every number that
 * can't get a code (unregistered, unverified, inactive) gets the same
 * OTP_NOT_AVAILABLE error and the same failed-attempt record; cooldown, caps and
 * provider failures surface lib/otp.ts's own wording. Answers are padded to a
 * fixed minimum time.
 */
export async function requestTeacherLoginOtp(mobileInput: unknown, ip: string): Promise<{ devCode?: string }> {
  const started = Date.now();
  const mobile = parseIndianMobile(String(mobileInput ?? ""));
  if (!mobile) throw new TeacherAuthError(INDIAN_MOBILE_ERROR);
  const key = otpAttemptKey(mobile.e164);
  try {
    if (await isAdminLoginBlocked(key, ip)) throw new TeacherAuthError(TOO_MANY_ATTEMPTS_MESSAGE);
    const teacher = await findOtpTeacher(mobile.e164);
    if (!teacher) {
      // Counts toward the per-IP / per-number failure caps, so probing numbers gets locked out.
      await prisma.loginAttempt.create({ data: { username: key, ipAddress: ip, success: false } });
      throw new TeacherAuthError(OTP_NOT_AVAILABLE);
    }
    try {
      const { devCode } = await requestOtp(mobile.e164, "TEACHER_LOGIN", ip);
      await closeOlderCodes(mobile.e164);
      return { devCode };
    } catch (error) {
      // Cooldown / caps / MSG91 failure: say so, so the screen never shows a countdown for an SMS that wasn't sent.
      if (error instanceof OtpError) {
        console.warn("[teacher-auth] login OTP not sent:", error.message);
        throw new TeacherAuthError(error.message);
      }
      throw error;
    }
  } finally {
    const wait = MIN_SEND_RESPONSE_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

/** Option B, step 2 (the "teacher-otp" sign-in provider). */
export async function authorizeTeacherOtp(mobileInput: unknown, codeInput: unknown, ip: string): Promise<TeacherSessionUser> {
  const mobile = parseIndianMobile(String(mobileInput ?? ""));
  if (!mobile) throw new TeacherAuthError(INDIAN_MOBILE_ERROR);
  const code = String(codeInput ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new TeacherAuthError("Enter the 6-digit code.");
  const key = otpAttemptKey(mobile.e164);
  await assertNotBlocked(key, ip);

  const teacher = await findOtpTeacher(mobile.e164);
  try {
    if (!teacher) throw new OtpError(NO_PENDING);
    await verifyOtp(mobile.e164, "TEACHER_LOGIN", code);
  } catch (error) {
    await prisma.loginAttempt.create({ data: { username: key, ipAddress: ip, success: false, adminUserId: teacher?.id } });
    if (error instanceof OtpError) throw new TeacherAuthError(error.message);
    throw error;
  }
  return signedIn(teacher!, key, ip, "otp");
}

/** Teacher Portal: the signed-in teacher's registered mobile (masked) and whether OTP sign-in is enabled on it. */
export async function teacherMobileStatus(teacherId: string) {
  const p = await prisma.teacherProfile.findUnique({ where: { adminUserId: teacherId }, select: { mobile: true, mobileVerifiedAt: true } });
  return { masked: maskMobile(p?.mobile), verified: Boolean(p?.mobile && p.mobileVerifiedAt) };
}

/** Sends a code to the signed-in teacher's own registered (unverified) mobile. They can't choose the number. */
export async function sendTeacherMobileVerifyCode(teacherId: string, ip: string): Promise<{ devCode?: string }> {
  const p = await prisma.teacherProfile.findUnique({ where: { adminUserId: teacherId }, select: { mobile: true, mobileVerifiedAt: true } });
  if (!p?.mobile) throw new TeacherAuthError("No mobile number is registered for your account. Ask the Master Admin to add it.");
  if (p.mobileVerifiedAt) throw new TeacherAuthError("Your mobile number is already verified.");
  try {
    const r = await requestOtp(p.mobile, "TEACHER_LOGIN", ip);
    await closeOlderCodes(p.mobile);
    return r;
  } catch (error) {
    if (error instanceof OtpError) throw new TeacherAuthError(error.message);
    throw error;
  }
}

/** Confirms the code and enables OTP sign-in — only if the number is still the one the code was sent to. */
export async function confirmTeacherMobile(teacherId: string, codeInput: unknown): Promise<void> {
  const code = String(codeInput ?? "").trim();
  if (!/^\d{6}$/.test(code)) throw new TeacherAuthError("Enter the 6-digit code.");
  const p = await prisma.teacherProfile.findUnique({ where: { adminUserId: teacherId }, select: { mobile: true, mobileVerifiedAt: true } });
  if (!p?.mobile) throw new TeacherAuthError("No mobile number is registered for your account. Ask the Master Admin to add it.");
  if (p.mobileVerifiedAt) return;
  try {
    await verifyOtp(p.mobile, "TEACHER_LOGIN", code);
  } catch (error) {
    if (error instanceof OtpError) throw new TeacherAuthError(error.message);
    throw error;
  }
  await prisma.$transaction(async (tx) => {
    const r = await tx.teacherProfile.updateMany({ where: { adminUserId: teacherId, mobile: p.mobile, mobileVerifiedAt: null }, data: { mobileVerifiedAt: new Date() } });
    if (r.count !== 1) throw new TeacherAuthError("Your registered number changed meanwhile. Please try again.");
    await tx.auditLog.create({ data: { actorId: teacherId, action: "TEACHER_MOBILE_VERIFIED", entityType: "AdminUser", entityId: teacherId, metadata: { mobile: maskMobile(p.mobile) } } });
  });
}
