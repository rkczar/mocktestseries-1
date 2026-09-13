import "server-only";
import crypto from "node:crypto";
import argon2 from "argon2";
import type { OtpPurpose } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendSms } from "@/lib/sms";
import { getSmsProviderName } from "@/lib/auth-provider-config";

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 15 * 60 * 1000;

export class OtpError extends Error {}

function generateOtp(): string {
  return crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
}

/** Requests a fresh OTP for `mobile`, enforcing resend cooldown + a send-rate cap. */
export async function requestOtp(mobile: string, purpose: OtpPurpose, ipAddress: string) {
  const windowStart = new Date(Date.now() - SEND_WINDOW_MS);
  const recentSends = await prisma.otpRequest.count({
    where: { mobile, purpose, createdAt: { gte: windowStart } },
  });
  if (recentSends >= MAX_SENDS_PER_WINDOW) {
    throw new OtpError("Too many OTP requests. Please try again later.");
  }

  const last = await prisma.otpRequest.findFirst({
    where: { mobile, purpose },
    orderBy: { createdAt: "desc" },
  });
  if (last) {
    const elapsed = Date.now() - last.lastSentAt.getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      throw new OtpError(`Please wait ${Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000)}s before requesting another code.`);
    }
  }

  const code = generateOtp();
  const otpHash = await argon2.hash(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.otpRequest.create({
    data: { mobile, purpose, otpHash, expiresAt, ipAddress, maxAttempts: MAX_VERIFY_ATTEMPTS },
  });

  const providerName = await getSmsProviderName();
  try {
    await sendSms(mobile, `Your MockTestSeries.in verification code is ${code}. It expires in 5 minutes.`);
  } catch (error) {
    // The row above is already written, but with no channel that reached the
    // student it must not be reported as a pending code — surface a clear,
    // honest failure instead of a false "check your phone" state.
    console.error(`[otp] sendSms failed via ${providerName}:`, error);
    throw new OtpError("We couldn't send a verification code right now. Please try Password login instead, or contact support.");
  }

  const isDevProvider = providerName === "console";
  return { devCode: process.env.NODE_ENV !== "production" && isDevProvider ? code : undefined };
}

/** Verifies and consumes the most recent unconsumed OTP for `mobile`/`purpose`. Throws OtpError on failure. */
export async function verifyOtp(mobile: string, purpose: OtpPurpose, code: string): Promise<void> {
  const record = await prisma.otpRequest.findFirst({
    where: { mobile, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) throw new OtpError("No pending verification code for this number. Please request a new one.");
  if (record.expiresAt < new Date()) throw new OtpError("This code has expired. Please request a new one.");
  if (record.attempts >= record.maxAttempts) {
    throw new OtpError("Too many incorrect attempts. Please request a new code.");
  }

  const valid = await argon2.verify(record.otpHash, code).catch(() => false);
  if (!valid) {
    await prisma.otpRequest.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    throw new OtpError("Incorrect code.");
  }

  await prisma.otpRequest.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
}
