import "server-only";
import { prisma } from "@/lib/prisma";
import { EmailOtpError, SEND_FAILED, isEmailOtpAvailable, normalizeEmail, sendEmailOtp, verifyEmailOtp } from "@/lib/email-otp";
import { isAdminLoginBlocked } from "@/lib/auth-rate-limit";
import { getAdminOtpMethods, isAdminOtpLoginEnabled } from "@/lib/admin-otp-settings";
import { OtpError, SEND_FAILED as SMS_SEND_FAILED, WHATSAPP_FAILED, WHATSAPP_UNAVAILABLE, requestOtp, requestOtpOnWhatsApp, verifyOtp } from "@/lib/otp";
import { INDIAN_MOBILE_ERROR, parseIndianMobile } from "@/lib/indian-mobile";

/**
 * Optional "Login with OTP" for the Admin Login page (owner request 2026-11-21). Password login is unchanged.
 * The code goes to the account's registered email through the existing email-OTP engine (lib/email-otp.ts:
 * 5-minute expiry, 60 s resend cooldown, 5 attempts, per-address / IP / global send limits, HMAC-hashed, single use).
 * Only ACTIVE MASTER_ADMIN / FULL_ADMIN accounts with a VERIFIED email qualify (teachers keep the Teacher Portal login).
 * The request answer never says whether an identifier belongs to an admin; codes are never logged.
 */

export const ADMIN_OTP_SENT =
  "If this is an active admin account with a verified email, a 6-digit code has been sent to it. It expires in 5 minutes. No email? Sign in with your password and add and verify your email in Admin Users & Access → Edit Admin.";
export const ADMIN_OTP_UNAVAILABLE = "Email login codes are not available right now. Please sign in with your password.";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_IN_WINDOW = 8;

async function findOtpAdmin(identifierRaw: string) {
  const identifier = identifierRaw.trim().toLowerCase();
  if (!identifier) return null;
  const rows = await prisma.adminUser.findMany({
    where: { isActive: true, role: { name: { in: ["MASTER_ADMIN", "FULL_ADMIN"] } }, OR: [{ username: identifier }, { email: { equals: identifier, mode: "insensitive" } }] },
    include: { role: true },
    take: 2,
  });
  // Ambiguous (two accounts share the address), no email, or email not verified: no code.
  const admin = rows.length === 1 ? rows[0] : null;
  return admin?.email && admin.emailVerifiedAt ? admin : null;
}

/**
 * Sends a code when the identifier is an eligible admin. The same answer for every identifier, except: email codes
 * unavailable site-wide (same for everyone), or the provider failed to deliver (never claims a code was sent).
 */
export async function requestAdminLoginOtp(identifier: string, ipAddress: string): Promise<{ ok: boolean; message: string }> {
  if (!(await isAdminOtpLoginEnabled())) return { ok: true, message: ADMIN_OTP_SENT };
  if (!(await isEmailOtpAvailable())) return { ok: false, message: ADMIN_OTP_UNAVAILABLE };
  const admin = await findOtpAdmin(identifier);
  if (!admin) {
    console.warn("[admin-otp] no code: identifier is not an active admin with a verified email");
    return { ok: true, message: ADMIN_OTP_SENT };
  }
  try {
    await sendEmailOtp({ email: admin.email!, purpose: "ADMIN_LOGIN", studentId: null, ipAddress });
  } catch (error) {
    if (!(error instanceof EmailOtpError)) throw error;
    console.warn("[admin-otp] code not sent", { reason: error.message.slice(0, 80) });
    if (error.message === SEND_FAILED) return { ok: false, message: `${SEND_FAILED} You can sign in with your password.` };
    // Cooldown / per-address limits stay generic (a different answer would reveal the account exists).
  }
  return { ok: true, message: ADMIN_OTP_SENT };
}

/** Admin Users & Access → Edit Admin: email the target admin a code proving their registered email. */
export async function sendAdminEmailVerification(adminId: string, ipAddress: string): Promise<void> {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { email: true, emailVerifiedAt: true } });
  if (!admin?.email) throw new EmailOtpError("Add and save an email address first.");
  if (admin.emailVerifiedAt) throw new EmailOtpError("This email is already verified.");
  await sendEmailOtp({ email: admin.email, purpose: "VERIFY_EMAIL", studentId: null, ipAddress });
}

/** Checks the code and marks the email verified (only if the email was not changed meanwhile). */
export async function verifyAdminEmail(adminId: string, code: string, actorId: string): Promise<void> {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { email: true } });
  if (!admin?.email) throw new EmailOtpError("Add and save an email address first.");
  await verifyEmailOtp({ email: admin.email, purpose: "VERIFY_EMAIL", studentId: null, code: String(code ?? "").trim() });
  const done = await prisma.adminUser.updateMany({ where: { id: adminId, email: admin.email }, data: { emailVerifiedAt: new Date() } });
  if (done.count !== 1) throw new EmailOtpError("The email changed while verifying. Send a new code.");
  await prisma.auditLog.create({ data: { actorId, action: "ADMIN_EMAIL_VERIFIED", entityType: "AdminUser", entityId: adminId } });
}

/** NextAuth authorize() for provider "admin-otp": the same session user as password login. */
export async function authorizeAdminOtp(identifierRaw: unknown, codeRaw: unknown, ipAddress: string, channel?: unknown) {
  if (channel === "mobile") return authorizeAdminMobileOtp(identifierRaw, codeRaw, ipAddress);
  const identifier = String(identifierRaw ?? "").trim().toLowerCase();
  const code = String(codeRaw ?? "").trim();
  if (!identifier || !/^\d{6}$/.test(code)) return null;
  if (!(await isAdminOtpLoginEnabled())) return null;
  const admin = await findOtpAdmin(identifier);
  // Rate limit on the same LoginAttempt table / lockout as password login, keyed by the account's username.
  const key = admin?.username ?? identifier;
  const recent = await prisma.loginAttempt.count({ where: { username: key, ipAddress, createdAt: { gte: new Date(Date.now() - LOGIN_WINDOW_MS) } } });
  if (recent >= MAX_ATTEMPTS_IN_WINDOW || (await isAdminLoginBlocked(key, ipAddress))) throw new Error("TooManyAttempts");
  let success = false;
  if (admin) {
    try {
      await verifyEmailOtp({ email: normalizeEmail(admin.email), purpose: "ADMIN_LOGIN", studentId: null, code });
      success = true;
    } catch (error) {
      if (!(error instanceof EmailOtpError)) throw error;
    }
  }
  await prisma.loginAttempt.create({ data: { username: key, ipAddress, success, adminUserId: admin?.id } });
  if (!admin || !success) return null;
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditLog.create({ data: { actorId: admin.id, action: "ADMIN_LOGIN", entityType: "AdminUser", entityId: admin.id, metadata: { method: "email_otp" } } });
  return { id: admin.id, name: admin.name, email: admin.email ?? undefined, role: admin.role.name };
}

// ------------------------------------------------------------------------------------------------------------------
// Mobile OTP (owner request 2026-11-21): the existing MSG91 OTP engine (lib/otp.ts — 6 digits, 5-minute expiry,
// 60 s cooldown, 5 attempts, per-number / IP / global caps, single use; optional WhatsApp re-delivery) with its own
// purpose ADMIN_LOGIN, to the admin's VERIFIED registered mobile (AdminUser.mobile, E.164).

export const ADMIN_MOBILE_OTP_SENT =
  "If this is an active admin account's verified mobile, a 6-digit code has been sent by SMS. It expires in 5 minutes. No SMS? Sign in with your password and add and verify your mobile in Admin Users & Access → Edit Admin.";
export const ADMIN_WHATSAPP_SENT = "If a code is pending for this verified admin mobile, it has been re-sent on WhatsApp.";

async function findMobileAdmin(e164: string) {
  const admin = await prisma.adminUser.findUnique({ where: { mobile: e164 }, include: { role: true } });
  const eligible = admin?.isActive && admin.mobileVerifiedAt && (admin.role.name === "MASTER_ADMIN" || admin.role.name === "FULL_ADMIN");
  return eligible ? admin : null;
}

/** A new code supersedes every older open ADMIN_LOGIN code for the number (same as the Teacher Portal). */
async function closeOlderMobileCodes(e164: string) {
  const latest = await prisma.otpRequest.findFirst({ where: { mobile: e164, purpose: "ADMIN_LOGIN", consumedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } });
  if (!latest) return;
  await prisma.otpRequest.updateMany({
    where: { mobile: e164, purpose: "ADMIN_LOGIN", consumedAt: null, id: { not: latest.id }, createdAt: { lte: latest.createdAt } },
    data: { consumedAt: new Date() },
  });
}

/** Login step 1 (SMS). Same answer for every number, except an SMS provider failure (never reported as sent). */
export async function requestAdminMobileOtp(mobileRaw: unknown, ipAddress: string): Promise<{ ok: boolean; message: string }> {
  if (!(await getAdminOtpMethods()).mobile) return { ok: true, message: ADMIN_MOBILE_OTP_SENT };
  const mobile = parseIndianMobile(String(mobileRaw ?? "").slice(0, 40));
  if (!mobile) return { ok: false, message: INDIAN_MOBILE_ERROR };
  const admin = await findMobileAdmin(mobile.e164);
  if (!admin) {
    console.warn("[admin-otp] no SMS: number is not an active admin's verified mobile");
    return { ok: true, message: ADMIN_MOBILE_OTP_SENT };
  }
  try {
    await requestOtp(mobile.e164, "ADMIN_LOGIN", ipAddress);
    await closeOlderMobileCodes(mobile.e164);
  } catch (error) {
    if (!(error instanceof OtpError)) throw error;
    console.warn("[admin-otp] SMS code not sent", { reason: error.message.slice(0, 80) });
    if (error.message === SMS_SEND_FAILED) return { ok: false, message: error.message };
    // Cooldown / caps stay generic (a different answer would reveal the account exists).
  }
  return { ok: true, message: ADMIN_MOBILE_OTP_SENT };
}

/** Login step 1b: re-deliver the pending SMS code on WhatsApp (MSG91 retryOtp), when the site has it enabled. */
export async function requestAdminMobileOtpWhatsApp(mobileRaw: unknown, ipAddress: string): Promise<{ ok: boolean; message: string }> {
  if (!(await getAdminOtpMethods()).mobile) return { ok: true, message: ADMIN_WHATSAPP_SENT };
  const mobile = parseIndianMobile(String(mobileRaw ?? "").slice(0, 40));
  if (!mobile) return { ok: false, message: INDIAN_MOBILE_ERROR };
  const admin = await findMobileAdmin(mobile.e164);
  if (!admin) return { ok: true, message: ADMIN_WHATSAPP_SENT };
  try {
    await requestOtpOnWhatsApp(mobile.e164, "ADMIN_LOGIN", ipAddress);
  } catch (error) {
    if (!(error instanceof OtpError)) throw error;
    console.warn("[admin-otp] WhatsApp code not sent", { reason: error.message.slice(0, 80) });
    if (error.message === WHATSAPP_UNAVAILABLE || error.message === WHATSAPP_FAILED) return { ok: false, message: error.message };
  }
  return { ok: true, message: ADMIN_WHATSAPP_SENT };
}

/** Login step 2 for channel "mobile": the same session user and the same LoginAttempt limits as the email path. */
async function authorizeAdminMobileOtp(mobileRaw: unknown, codeRaw: unknown, ipAddress: string) {
  const code = String(codeRaw ?? "").trim();
  const mobile = parseIndianMobile(String(mobileRaw ?? "").slice(0, 40));
  if (!mobile || !/^\d{6}$/.test(code)) return null;
  if (!(await getAdminOtpMethods()).mobile) return null;
  const admin = await findMobileAdmin(mobile.e164);
  const key = admin?.username ?? `otp:${mobile.e164}`;
  const recent = await prisma.loginAttempt.count({ where: { username: key, ipAddress, createdAt: { gte: new Date(Date.now() - LOGIN_WINDOW_MS) } } });
  if (recent >= MAX_ATTEMPTS_IN_WINDOW || (await isAdminLoginBlocked(key, ipAddress))) throw new Error("TooManyAttempts");
  let success = false;
  if (admin) {
    try {
      await verifyOtp(mobile.e164, "ADMIN_LOGIN", code);
      success = true;
    } catch (error) {
      if (!(error instanceof OtpError)) throw error;
    }
  }
  await prisma.loginAttempt.create({ data: { username: key, ipAddress, success, adminUserId: admin?.id } });
  if (!admin || !success) return null;
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditLog.create({ data: { actorId: admin.id, action: "ADMIN_LOGIN", entityType: "AdminUser", entityId: admin.id, metadata: { method: "mobile_otp" } } });
  return { id: admin.id, name: admin.name, email: admin.email ?? undefined, role: admin.role.name };
}

/** Admin Users & Access → Edit Admin: SMS a code to the admin's saved (unverified) mobile. */
export async function sendAdminMobileVerification(adminId: string, ipAddress: string): Promise<void> {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { mobile: true, mobileVerifiedAt: true } });
  if (!admin?.mobile) throw new OtpError("Add and save a mobile number first.");
  if (admin.mobileVerifiedAt) throw new OtpError("This mobile number is already verified.");
  await requestOtp(admin.mobile, "ADMIN_LOGIN", ipAddress);
  await closeOlderMobileCodes(admin.mobile);
}

/** Checks the SMS code and marks the mobile verified (only if the number was not changed meanwhile). */
export async function verifyAdminMobile(adminId: string, code: string, actorId: string): Promise<void> {
  const admin = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { mobile: true } });
  if (!admin?.mobile) throw new OtpError("Add and save a mobile number first.");
  if (!/^\d{6}$/.test(String(code ?? "").trim())) throw new OtpError("Enter the 6-digit code.");
  await verifyOtp(admin.mobile, "ADMIN_LOGIN", String(code).trim());
  const done = await prisma.adminUser.updateMany({ where: { id: adminId, mobile: admin.mobile }, data: { mobileVerifiedAt: new Date() } });
  if (done.count !== 1) throw new OtpError("The mobile number changed while verifying. Send a new code.");
  await prisma.auditLog.create({ data: { actorId, action: "ADMIN_MOBILE_VERIFIED", entityType: "AdminUser", entityId: adminId } });
}
