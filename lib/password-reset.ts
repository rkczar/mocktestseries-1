import "server-only";
import crypto from "node:crypto";
import argon2 from "argon2";
import { OtpPurpose } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requestOtp, verifyOtp, OtpError } from "@/lib/otp";
import { isStudentAuthEligible } from "@/lib/student-lifecycle";
import { getAuthProviderConfig } from "@/lib/auth-provider-config";

/**
 * Student Forgot Password — the one reset path, built on the existing phone
 * OTP infrastructure (lib/otp.ts: MSG91 / configured SMS provider, hashed
 * codes, expiry, attempt caps, resend cooldown, per-mobile send cap). There
 * is no email provider in this project, so the account's registered mobile
 * is the recovery channel.
 *
 *   identifier (email / mobile / User ID)
 *     → RESET_PASSWORD OTP to the account's registered mobile
 *     → verify OTP → short-lived single-use reset token (hash at rest)
 *     → new password (argon2, same as registration) → token + siblings voided
 *
 * Anti-enumeration: requestPasswordReset answers identically whether or not
 * the identifier matches an account; verify failures are one generic message.
 * Nothing here logs a password, OTP or token.
 */

const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_IP = 10;
export const MIN_PASSWORD_LENGTH = 8;

export class PasswordResetError extends Error {}

const GENERIC_VERIFY_ERROR = "Incorrect or expired code. Please request a new one.";

function normalizeMobile(mobile: string) {
  return mobile.trim().replace(/[^\d+]/g, "");
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Resolves the student behind a login identifier: email, mobile, or User ID (e.g. MTS-000123). */
async function findStudentByIdentifier(rawIdentifier: string) {
  const identifier = rawIdentifier.trim();
  if (!identifier) return null;
  const or: { email?: string; mobile?: string; studentId?: string }[] = [{ email: identifier.toLowerCase() }];
  const mobile = normalizeMobile(identifier);
  if (/^\+?[0-9]{7,15}$/.test(mobile)) or.push({ mobile });
  or.push({ studentId: identifier.toUpperCase() });
  const student = await prisma.student.findFirst({
    where: { OR: or },
    select: { id: true, mobile: true, status: true },
  });
  if (!student || !student.mobile || !isStudentAuthEligible(student.status)) return null;
  return { id: student.id, mobile: student.mobile };
}

/**
 * Step 1. Sends a RESET_PASSWORD code to the matching account's registered
 * mobile. Returns normally whether or not an account matched. The only
 * thrown errors are the per-IP cap (independent of any account) and a real
 * delivery failure.
 */
export async function requestPasswordReset(identifier: string, ipAddress: string): Promise<{ devCode?: string }> {
  const config = await getAuthProviderConfig();
  if (!config.passwordEnabled) throw new PasswordResetError("Password login is currently disabled.");

  const windowStart = new Date(Date.now() - REQUEST_WINDOW_MS);
  const recent = await prisma.studentLoginAttempt.count({
    where: { ipAddress, method: "PASSWORD_RESET_REQUEST", createdAt: { gte: windowStart } },
  });
  if (recent >= MAX_REQUESTS_PER_IP) {
    throw new PasswordResetError("Too many reset requests. Please try again later.");
  }

  const student = await findStudentByIdentifier(identifier);
  await prisma.studentLoginAttempt.create({
    data: {
      identifier: identifier.trim().toLowerCase().slice(0, 200),
      ipAddress,
      success: false,
      method: "PASSWORD_RESET_REQUEST",
      studentId: student?.id,
    },
  });
  if (!student) return {};

  try {
    return await requestOtp(student.mobile, OtpPurpose.RESET_PASSWORD, ipAddress);
  } catch (error) {
    // Cooldown / send-cap only happen for a real account — answering them
    // differently would reveal the account exists, so they read as "sent".
    if (error instanceof OtpError && /wait|too many/i.test(error.message)) return {};
    throw error;
  }
}

/** Step 2. Verifies the code and returns a one-time reset token (plaintext only to the caller). */
export async function verifyPasswordResetCode(identifier: string, code: string): Promise<string> {
  const student = await findStudentByIdentifier(identifier);
  if (!student || !/^\d{4,8}$/.test(code.trim())) throw new PasswordResetError(GENERIC_VERIFY_ERROR);

  try {
    await verifyOtp(student.mobile, OtpPurpose.RESET_PASSWORD, code.trim());
  } catch (error) {
    if (error instanceof OtpError) {
      throw new PasswordResetError(/too many/i.test(error.message) ? error.message : GENERIC_VERIFY_ERROR);
    }
    throw error;
  }

  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.passwordResetToken.create({
    data: { studentId: student.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
  });
  return token;
}

/** Step 3. Sets the new password. Single-use: the token and every other open token for the student are consumed. */
export async function resetPasswordWithToken(token: string, newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordResetError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const record = token ? await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } }) : null;
  const expired = "This reset link has expired. Please start again.";
  if (!record || record.usedAt || record.expiresAt < new Date()) throw new PasswordResetError(expired);

  const student = await prisma.student.findUnique({ where: { id: record.studentId }, select: { status: true } });
  if (!student || !isStudentAuthEligible(student.status)) throw new PasswordResetError(expired);

  const passwordHash = await argon2.hash(newPassword);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Conditional claim — two concurrent submits of the same token can't both win.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw new PasswordResetError(expired);
    await tx.passwordResetToken.updateMany({
      where: { studentId: record.studentId, usedAt: null },
      data: { usedAt: now },
    });
    await tx.student.update({ where: { id: record.studentId }, data: { passwordHash } });
    await tx.studentActivity.create({
      data: { studentId: record.studentId, activity: "PASSWORD_RESET", metadata: { method: "phone_otp" } },
    });
  });
}
