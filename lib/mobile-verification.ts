import "server-only";
import { OtpPurpose, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAuthProviderConfig } from "@/lib/auth-provider-config";
import { requestOtp, requestOtpOnWhatsApp, verifyOtp, OtpError } from "@/lib/otp";
import { assertOtpVerifyAllowed, AuthRateLimitError, TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/auth-rate-limit";
import { parseIndianMobile, storedMobileVariants, INDIAN_MOBILE_ERROR, type IndianMobile } from "@/lib/indian-mobile";
import { recordMobileConflict } from "@/lib/account-recovery";

/**
 * Mandatory mobile OTP verification for students.
 *
 * - `Student.mobileVerifiedAt` is set ONLY here (existing-account verification)
 *   and in the OTP sign-up / OTP sign-in providers (lib/auth-student.ts), each
 *   right after verifyOtp() succeeded on the server. Nothing the browser sends
 *   can set it.
 * - A verified number is always stored as E.164. Student.mobile is @unique, so
 *   two accounts can never hold the same verified number; older spellings of
 *   the same number (9876543210, 919876543210, …) are checked explicitly.
 * - A number already on another account is never moved or merged here: the
 *   student gets MOBILE_IN_USE_MESSAGE plus a recovery request (DRAFT, see
 *   lib/account-recovery.ts) that an Admin must approve. That answer is only
 *   given AFTER the OTP proved the student owns the number, so it cannot be
 *   used to probe which numbers have accounts.
 * - Enforcement (requireStudent → /student/verify-mobile) follows the Admin
 *   switch "Require mobile verification" (isMobileVerificationRequired).
 */

export const MOBILE_IN_USE_MESSAGE =
  "This mobile number is already linked to another MockTestSeries account. For your security it can't be moved automatically. You can ask our team to review a transfer below, or use a different number.";

export class MobileVerificationError extends Error {}

/** The proven number is held by another account; a recovery request was recorded server-side. */
export class MobileInUseError extends MobileVerificationError {
  constructor(readonly recoveryRequestId: string) {
    super(MOBILE_IN_USE_MESSAGE);
  }
}

async function conflict(studentDbId: string, mobile: IndianMobile, others: { id: string; status: string }[]): Promise<never> {
  await prisma.studentActivity.create({
    data: { studentId: studentDbId, activity: "MOBILE_VERIFY_CONFLICT", metadata: { conflictingAccounts: others.length } },
  });
  const request = await recordMobileConflict(studentDbId, mobile.e164, others);
  throw new MobileInUseError(request.id);
}

const OTP_CODE_PATTERN = /^[0-9]{6}$/;

/** The Admin switch (cached 15 s with the rest of the provider config). */
export async function isMobileVerificationRequired(): Promise<boolean> {
  return (await getAuthProviderConfig()).mobileVerificationRequired;
}

/** Every account (any status) whose stored mobile is a spelling of `mobile`. */
export async function findStudentsByMobile(mobile: IndianMobile, excludeStudentId?: string) {
  return prisma.student.findMany({
    where: {
      mobile: { in: storedMobileVariants(mobile) },
      ...(excludeStudentId ? { id: { not: excludeStudentId } } : {}),
    },
    select: { id: true, status: true, mobile: true, mobileVerifiedAt: true, authProvider: true },
  });
}

/** True when the student has an OTP-verified mobile. */
export async function isStudentMobileVerified(studentDbId: string): Promise<boolean> {
  const row = await prisma.student.findUnique({ where: { id: studentDbId }, select: { mobileVerifiedAt: true } });
  return Boolean(row?.mobileVerifiedAt);
}

export async function getMobileVerificationState(studentDbId: string) {
  const row = await prisma.student.findUnique({
    where: { id: studentDbId },
    select: { mobile: true, mobileVerifiedAt: true },
  });
  return {
    verified: Boolean(row?.mobileVerifiedAt),
    /** The stored number, prefilled only when it is a valid Indian mobile. */
    suggestedDigits: parseIndianMobile(row?.mobile)?.digits ?? "",
  };
}

function parseOrThrow(rawMobile: string): IndianMobile {
  const mobile = parseIndianMobile(rawMobile);
  if (!mobile) throw new MobileVerificationError(INDIAN_MOBILE_ERROR);
  return mobile;
}

/** Step 1 for a signed-in student: send a VERIFY_MOBILE code to the number they entered. */
export async function sendMobileVerificationOtp(studentDbId: string, rawMobile: string, ipAddress: string) {
  const mobile = parseOrThrow(rawMobile);
  if (await isStudentMobileVerified(studentDbId)) {
    throw new MobileVerificationError("Your mobile number is already verified.");
  }
  try {
    const { devCode } = await requestOtp(mobile.e164, OtpPurpose.VERIFY_MOBILE, ipAddress);
    return { mobile, devCode };
  } catch (error) {
    if (error instanceof OtpError) throw new MobileVerificationError(error.message);
    throw error;
  }
}

/** Step 1b: "Get OTP on WhatsApp" for the pending VERIFY_MOBILE code (same caps as SMS). */
export async function sendMobileVerificationOtpOnWhatsApp(studentDbId: string, rawMobile: string, ipAddress: string) {
  const mobile = parseOrThrow(rawMobile);
  if (await isStudentMobileVerified(studentDbId)) {
    throw new MobileVerificationError("Your mobile number is already verified.");
  }
  try {
    await requestOtpOnWhatsApp(mobile.e164, OtpPurpose.VERIFY_MOBILE, ipAddress);
    return { mobile };
  } catch (error) {
    if (error instanceof OtpError) throw new MobileVerificationError(error.message);
    throw error;
  }
}

/**
 * Step 2: verify the code on the server, then mark THIS student's mobile as
 * verified. The code is single-use (lib/otp.ts consumes it atomically), so a
 * replay or a parallel duplicate submit cannot verify twice.
 */
export async function confirmMobileVerificationOtp(studentDbId: string, rawMobile: string, rawCode: string, ipAddress: string) {
  const mobile = parseOrThrow(rawMobile);
  const code = String(rawCode ?? "").trim();
  if (!OTP_CODE_PATTERN.test(code)) throw new MobileVerificationError("Enter the 6-digit verification code.");

  try {
    await assertOtpVerifyAllowed(ipAddress);
  } catch (error) {
    if (error instanceof AuthRateLimitError) throw new MobileVerificationError(TOO_MANY_ATTEMPTS_MESSAGE);
    throw error;
  }

  try {
    await verifyOtp(mobile.e164, OtpPurpose.VERIFY_MOBILE, code);
  } catch (error) {
    // Counted toward the per-IP OTP failure cap (OTP_VERIFY_METHODS).
    await prisma.studentLoginAttempt.create({
      data: { identifier: mobile.e164, ipAddress, success: false, method: "MOBILE_VERIFY", studentId: studentDbId },
    });
    if (error instanceof OtpError) throw new MobileVerificationError(error.message);
    throw new MobileVerificationError("Verification failed. Please try again.");
  }

  const current = await prisma.student.findUnique({
    where: { id: studentDbId },
    select: { mobile: true, mobileVerifiedAt: true },
  });
  if (!current) throw new MobileVerificationError("Your session has ended. Please sign in again.");
  if (current.mobileVerifiedAt) return; // a duplicate submit already finished

  const others = await findStudentsByMobile(mobile, studentDbId);
  if (others.length > 0) await conflict(studentDbId, mobile, others);

  const now = new Date();
  try {
    // Only an unverified row is updated, so a concurrent verification of the
    // same account cannot overwrite an already-verified number.
    const updated = await prisma.student.updateMany({
      where: { id: studentDbId, mobileVerifiedAt: null },
      data: { mobile: mobile.e164, mobileVerifiedAt: now },
    });
    if (updated.count !== 1) return;
  } catch (error) {
    // Unique(mobile): another account claimed this exact number in parallel.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      await conflict(studentDbId, mobile, await findStudentsByMobile(mobile, studentDbId));
    }
    throw error;
  }

  await prisma.studentActivity.create({
    data: {
      studentId: studentDbId,
      activity: "MOBILE_VERIFIED",
      // The replaced value is kept so support can always see what was on the account before.
      metadata: { method: "otp", ...(current.mobile && current.mobile !== mobile.e164 ? { previousMobile: current.mobile } : {}) },
    },
  });
  await prisma.studentLoginAttempt.create({
    data: { identifier: mobile.e164, ipAddress, success: true, method: "MOBILE_VERIFY", studentId: studentDbId },
  });
}
