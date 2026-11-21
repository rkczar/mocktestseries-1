import "server-only";
import { prisma } from "@/lib/prisma";
import { EmailOtpError, SEND_FAILED, isEmailOtpAvailable, normalizeEmail, sendEmailOtp, verifyEmailOtp } from "@/lib/email-otp";
import { isAdminLoginBlocked } from "@/lib/auth-rate-limit";
import { isAdminOtpLoginEnabled } from "@/lib/admin-otp-settings";

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
export async function authorizeAdminOtp(identifierRaw: unknown, codeRaw: unknown, ipAddress: string) {
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
