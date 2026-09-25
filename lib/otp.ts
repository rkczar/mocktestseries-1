import "server-only";
import crypto from "node:crypto";
import argon2 from "argon2";
import type { OtpPurpose } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendSms } from "@/lib/sms";
import { getSmsProviderName, getMsg91Credentials } from "@/lib/auth-provider-config";
import { assertOtpSendAllowed, AuthRateLimitError, TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/auth-rate-limit";

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 15 * 60 * 1000;

const MSG91_WIDGET_BASE = "https://api.msg91.com/api/v5/widget";

export class OtpError extends Error {}

function generateOtp(): string {
  return crypto.randomInt(0, 10 ** OTP_LENGTH).toString().padStart(OTP_LENGTH, "0");
}

/** MSG91 wants the mobile number as bare digits with country code, no `+`. */
function toMsg91Identifier(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  return digits.startsWith("91") ? digits : `91${digits}`;
}

interface Msg91WidgetResponse {
  type: "success" | "error";
  message: string;
}

/**
 * Calls one of MSG91's OTP Widget REST endpoints (sendOtp / verifyOtp /
 * verifyAccessToken) — server-to-server, authenticated with the account auth
 * key. Unlike the client-side widget script, this never touches the browser.
 */
async function msg91WidgetRequest(
  path: "sendOtp" | "verifyOtp" | "verifyAccessToken",
  authKey: string,
  body: Record<string, unknown>
): Promise<Msg91WidgetResponse> {
  const res = await fetch(`${MSG91_WIDGET_BASE}/${path}`, {
    method: "POST",
    headers: { authkey: authKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Msg91WidgetResponse | null;
  if (!data || typeof data.message !== "string") {
    throw new Error(`MSG91 widget ${path} returned an unexpected response (${res.status}).`);
  }
  return data;
}

/**
 * Requests a fresh OTP for `mobile`, enforcing the central send caps
 * (per-IP, per-mobile daily, global provider ceiling — lib/auth-rate-limit.ts)
 * plus this purpose's resend cooldown and 15-minute per-mobile cap.
 * `ipAddress` must come from lib/client-ip.ts.
 */
export async function requestOtp(mobile: string, purpose: OtpPurpose, ipAddress: string) {
  try {
    await assertOtpSendAllowed(mobile, ipAddress);
  } catch (error) {
    // Same wording as the per-mobile cap below, so callers (and the
    // password-reset anti-enumeration path) treat every cap identically.
    if (error instanceof AuthRateLimitError) throw new OtpError(TOO_MANY_ATTEMPTS_MESSAGE);
    throw error;
  }

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

  const { authKey, widgetId } = await getMsg91Credentials();

  if (authKey && widgetId) {
    let reqId: string;
    try {
      const result = await msg91WidgetRequest("sendOtp", authKey, {
        widgetId,
        identifier: toMsg91Identifier(mobile),
      });
      if (result.type !== "success") throw new Error(result.message);
      reqId = result.message;
    } catch (error) {
      console.error("[otp] MSG91 widget sendOtp failed:", error);
      throw new OtpError("We couldn't send a verification code right now. Please try Password login instead, or contact support.");
    }

    // otpHash is unused when MSG91 holds the code (see the OtpRequest doc comment
    // in prisma/schema.prisma) — a random placeholder keeps the column non-null.
    const placeholderHash = await argon2.hash(crypto.randomUUID());
    await prisma.otpRequest.create({
      data: {
        mobile,
        purpose,
        otpHash: placeholderHash,
        providerRef: reqId,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        ipAddress,
        maxAttempts: MAX_VERIFY_ATTEMPTS,
      },
    });
    return { devCode: undefined };
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

/** Single use: only one concurrent verification can consume a code. */
async function consumeOrThrow(id: string) {
  const consumed = await prisma.otpRequest.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (consumed.count !== 1) throw new OtpError("This code has already been used. Please request a new one.");
}

/** Verifies and consumes the most recent unconsumed OTP for `mobile`/`purpose`. Throws OtpError on failure. */
export async function verifyOtp(mobile: string, purpose: OtpPurpose, code: string): Promise<void> {
  const record = await prisma.otpRequest.findFirst({
    where: { mobile, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!record) throw new OtpError("No pending verification code for this number. Please request a new one.");
  if (record.expiresAt < new Date()) throw new OtpError("This code has expired. Please request a new one.");
  // Atomically claim one of the code's attempts BEFORE checking it, so
  // parallel guesses can never exceed maxAttempts (a read-then-increment
  // would let concurrent requests all pass the check).
  const claimed = await prisma.otpRequest.updateMany({
    where: { id: record.id, consumedAt: null, attempts: { lt: record.maxAttempts } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) {
    throw new OtpError("Too many incorrect attempts. Please request a new code.");
  }

  if (record.providerRef) {
    const { authKey, widgetId } = await getMsg91Credentials();
    if (!authKey || !widgetId) {
      // Credentials were removed after the code was sent — there is no local
      // hash to fall back to, so this pending request can only be expired.
      throw new OtpError("This code has expired. Please request a new one.");
    }

    let verifyResult: Msg91WidgetResponse;
    try {
      verifyResult = await msg91WidgetRequest("verifyOtp", authKey, {
        widgetId,
        reqId: record.providerRef,
        otp: code,
      });
    } catch (error) {
      console.error("[otp] MSG91 widget verifyOtp request failed:", error);
      throw new OtpError("Verification failed. Please try again.");
    }

    let verified = false;
    if (verifyResult.type === "success") {
      // verifyOtp returns a JWT access token; verifyAccessToken is the step that
      // actually confirms it's genuine and tells us which identifier it was
      // issued for, so we check that instead of trusting the token itself.
      try {
        const check = await msg91WidgetRequest("verifyAccessToken", authKey, {
          "access-token": verifyResult.message,
        });
        verified = check.type === "success" && check.message === toMsg91Identifier(mobile);
      } catch (error) {
        console.error("[otp] MSG91 widget verifyAccessToken request failed:", error);
        throw new OtpError("Verification failed. Please try again.");
      }
    }

    if (!verified) {
      throw new OtpError("Incorrect code.");
    }

    await consumeOrThrow(record.id);
    return;
  }

  const valid = await argon2.verify(record.otpHash, code).catch(() => false);
  if (!valid) {
    throw new OtpError("Incorrect code.");
  }

  await consumeOrThrow(record.id);
}
