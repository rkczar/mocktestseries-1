import "server-only";
import crypto from "node:crypto";
import type { EmailOtpPurpose } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getEmailProvider } from "@/lib/email/provider";
import { getEmailEnvConfig } from "@/lib/email/config";
import { renderEmailLayout } from "@/lib/email/layout";
import { escapeHtml } from "@/lib/email/sanitize";

/**
 * Email OTP — six-digit codes sent to an email address.
 *
 * - Sent DIRECTLY through the email provider (never the campaign queue), and
 *   only while the Admin switch "Security code emails" is ON
 *   (Setting "email.otp", independent of production campaign sending).
 * - Only HMAC-SHA256(AUTH_SECRET, row id + code) is stored. The code is never
 *   stored, returned to the browser or logged.
 * - 5-minute expiry, 5 wrong attempts per code, 60 s resend cooldown,
 *   per-address / per-student / per-IP / platform-wide send caps.
 * - Verification is atomic and single-use (conditional consume).
 */

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const MINUTE = 60 * 1000;
const LIMITS = {
  perAddress15m: { max: 5, windowMs: 15 * MINUTE },
  perAddressDaily: { max: 10, windowMs: 24 * 60 * MINUTE },
  perStudentDaily: { max: 15, windowMs: 24 * 60 * MINUTE },
  perIp15m: { max: 10, windowMs: 15 * MINUTE },
  perIpDaily: { max: 30, windowMs: 24 * 60 * MINUTE },
  globalHourly: { max: 300, windowMs: 60 * MINUTE },
} as const;

export const EMAIL_OTP_UNAVAILABLE = "Email verification codes are not available right now. Please try again later or contact support.";
const SEND_FAILED = "We couldn't send the email right now. Please try again in a few minutes.";
const TOO_MANY = "Too many attempts. Please try again later.";

export class EmailOtpError extends Error {}

// --------------------------------------------------------------- Admin switch

const SETTING_KEY = "email.otp";

export interface EmailOtpSettings {
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Last Admin "Send test security code". */
  lastTest: { at: string; ok: boolean; message: string } | null;
}

export async function getEmailOtpSettings(): Promise<EmailOtpSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const raw = (row?.value ?? {}) as Partial<EmailOtpSettings>;
  return {
    enabled: raw.enabled === true,
    updatedAt: raw.updatedAt ?? null,
    updatedBy: raw.updatedBy ?? null,
    lastTest: raw.lastTest ?? null,
  };
}

async function writeEmailOtpSettings(next: EmailOtpSettings) {
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: next as unknown as object },
    update: { value: next as unknown as object },
  });
}

export async function setEmailOtpEnabled(enabled: boolean, adminName: string) {
  const current = await getEmailOtpSettings();
  await writeEmailOtpSettings({ ...current, enabled, updatedAt: new Date().toISOString(), updatedBy: adminName });
}

export async function recordEmailOtpTest(result: { ok: boolean; message: string }) {
  const current = await getEmailOtpSettings();
  await writeEmailOtpSettings({ ...current, lastTest: { at: new Date().toISOString(), ...result } });
}

/** Email OTP works only with the switch ON and a configured provider. */
export async function isEmailOtpAvailable(): Promise<boolean> {
  if (!getEmailEnvConfig().providerConfigured) return false;
  return (await getEmailOtpSettings()).enabled;
}

// ------------------------------------------------------------------- Helpers

export function normalizeEmail(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

/** "rajesh@gmail.com" → "r****@gmail.com" (safe to show to someone who proved the linked phone). */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "****";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(3, Math.min(local.length - 1, 6)))}@${domain}`;
}

function hmacKey(): string {
  const key = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!key) throw new Error("AUTH_SECRET is required for email OTP hashing");
  return key;
}

function hashCode(rowId: string, code: string): string {
  return crypto.createHmac("sha256", hmacKey()).update(`${rowId}:${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const since = (ms: number) => new Date(Date.now() - ms);

async function assertSendAllowed(email: string, studentId: string | null, ip: string) {
  const knownIp = Boolean(ip) && ip !== "unknown";
  const [a15, aDay, sDay, ip15, ipDay, global] = await Promise.all([
    prisma.emailOtpRequest.count({ where: { email, createdAt: { gte: since(LIMITS.perAddress15m.windowMs) } } }),
    prisma.emailOtpRequest.count({ where: { email, createdAt: { gte: since(LIMITS.perAddressDaily.windowMs) } } }),
    studentId ? prisma.emailOtpRequest.count({ where: { studentId, createdAt: { gte: since(LIMITS.perStudentDaily.windowMs) } } }) : 0,
    knownIp ? prisma.emailOtpRequest.count({ where: { ipAddress: ip, createdAt: { gte: since(LIMITS.perIp15m.windowMs) } } }) : 0,
    knownIp ? prisma.emailOtpRequest.count({ where: { ipAddress: ip, createdAt: { gte: since(LIMITS.perIpDaily.windowMs) } } }) : 0,
    prisma.emailOtpRequest.count({ where: { createdAt: { gte: since(LIMITS.globalHourly.windowMs) } } }),
  ]);
  if (global >= LIMITS.globalHourly.max) {
    console.warn("[email-otp] global hourly send ceiling reached", { global });
    throw new EmailOtpError(TOO_MANY);
  }
  if (
    a15 >= LIMITS.perAddress15m.max ||
    aDay >= LIMITS.perAddressDaily.max ||
    sDay >= LIMITS.perStudentDaily.max ||
    ip15 >= LIMITS.perIp15m.max ||
    ipDay >= LIMITS.perIpDaily.max
  ) {
    throw new EmailOtpError(TOO_MANY);
  }
}

const PURPOSE_TEXT: Record<EmailOtpPurpose, { subject: string; intro: string }> = {
  VERIFY_EMAIL: {
    subject: "Your MockTestSeries email verification code",
    intro: "Use this code to verify the email address on your MockTestSeries account.",
  },
  RECOVERY_PROOF: {
    subject: "Your MockTestSeries account recovery code",
    intro:
      "Someone who verified the mobile number linked to your MockTestSeries account asked to move that number to another account. Enter this code only if that request is yours.",
  },
  ADMIN_TEST: {
    subject: "MockTestSeries test security code",
    intro: "This is a test of MockTestSeries security code emails.",
  },
};

function renderOtpEmail(purpose: EmailOtpPurpose, code: string) {
  const t = PURPOSE_TEXT[purpose];
  const bodyHtml = `<p>${escapeHtml(t.intro)}</p>
<p style="font-size:30px;letter-spacing:8px;font-weight:bold;margin:20px 0;">${code}</p>
<p>This code expires in 5 minutes. MockTestSeries will never ask you for this code by phone, chat or email.</p>
<p>If you did not request it, you can ignore this email — nothing changes on your account.</p>`;
  const { html, text } = renderEmailLayout({
    heading: escapeHtml(t.subject.replace(/^Your /, "").replace(/^./, (c) => c.toUpperCase())),
    bodyHtml,
    ctaText: null,
    ctaUrl: null,
    siteUrl: "https://mocktestseries.in",
    preferencesUrl: null,
    promotional: false,
    preheader: "Your code expires in 5 minutes.",
  });
  return { subject: t.subject, html, text };
}

// --------------------------------------------------------------------- Send

export interface SendEmailOtpInput {
  email: string;
  purpose: EmailOtpPurpose;
  studentId: string | null;
  recoveryRequestId?: string | null;
  ipAddress: string;
  /** ADMIN_TEST may send while the switch is OFF (that's how the switch gets tested). */
  ignoreSwitch?: boolean;
}

export async function sendEmailOtp(input: SendEmailOtpInput): Promise<{ id: string }> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new EmailOtpError("Enter a valid email address.");
  const provider = getEmailProvider();
  if (!provider.configured) throw new EmailOtpError(EMAIL_OTP_UNAVAILABLE);
  if (!input.ignoreSwitch && !(await getEmailOtpSettings()).enabled) throw new EmailOtpError(EMAIL_OTP_UNAVAILABLE);

  await assertSendAllowed(email, input.studentId, input.ipAddress);
  const last = await prisma.emailOtpRequest.findFirst({
    where: { email, purpose: input.purpose, ...(input.studentId ? { studentId: input.studentId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  if (last) {
    const elapsed = Date.now() - last.lastSentAt.getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      throw new EmailOtpError(`Please wait ${Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000)}s before requesting another code.`);
    }
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  const id = crypto.randomUUID();
  // Older open codes for the same target stop working the moment a new one is issued.
  await prisma.emailOtpRequest.updateMany({
    where: { email, purpose: input.purpose, studentId: input.studentId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  await prisma.emailOtpRequest.create({
    data: {
      id,
      email,
      purpose: input.purpose,
      studentId: input.studentId,
      recoveryRequestId: input.recoveryRequestId ?? null,
      otpHash: hashCode(id, code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
      maxAttempts: MAX_VERIFY_ATTEMPTS,
      ipAddress: input.ipAddress || null,
    },
  });

  const message = renderOtpEmail(input.purpose, code);
  const result = await provider.send({
    to: email,
    subject: message.subject,
    html: message.html,
    text: message.text,
    idempotencyKey: `email-otp:${id}`,
    tags: [{ name: "category", value: "security_code" }],
  });
  if (!result.ok) {
    // No channel reached the student: void the row so it can never verify,
    // and report honestly instead of "check your inbox".
    await prisma.emailOtpRequest.update({ where: { id }, data: { consumedAt: new Date() } });
    console.error("[email-otp] provider send failed", { purpose: input.purpose, reason: result.reason });
    throw new EmailOtpError(SEND_FAILED);
  }
  await prisma.emailOtpRequest.update({ where: { id }, data: { providerMessageId: result.providerMessageId } });
  return { id };
}

// ------------------------------------------------------------------- Verify

/**
 * Verifies and consumes the latest open code for (email, purpose, studentId).
 * Throws EmailOtpError on any failure; succeeds at most once per code.
 */
export async function verifyEmailOtp(input: {
  email: string;
  purpose: EmailOtpPurpose;
  studentId: string | null;
  recoveryRequestId?: string | null;
  code: string;
}): Promise<void> {
  const email = normalizeEmail(input.email);
  const code = String(input.code ?? "").trim();
  if (!/^[0-9]{6}$/.test(code)) throw new EmailOtpError("Enter the 6-digit code from the email.");

  const record = await prisma.emailOtpRequest.findFirst({
    where: {
      email,
      purpose: input.purpose,
      studentId: input.studentId,
      consumedAt: null,
      ...(input.recoveryRequestId ? { recoveryRequestId: input.recoveryRequestId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!record) throw new EmailOtpError("No active code. Please request a new one.");
  if (record.expiresAt.getTime() < Date.now()) throw new EmailOtpError("This code has expired. Please request a new one.");
  if (record.attempts >= record.maxAttempts) throw new EmailOtpError("Too many incorrect attempts. Please request a new code.");

  if (!sameHash(record.otpHash, hashCode(record.id, code))) {
    // Conditional increment: parallel wrong guesses can't exceed the cap unnoticed.
    await prisma.emailOtpRequest.updateMany({
      where: { id: record.id, attempts: { lt: record.maxAttempts } },
      data: { attempts: { increment: 1 } },
    });
    throw new EmailOtpError("Incorrect code.");
  }

  const consumed = await prisma.emailOtpRequest.updateMany({
    where: { id: record.id, consumedAt: null, attempts: { lt: record.maxAttempts } },
    data: { consumedAt: new Date() },
  });
  if (consumed.count !== 1) throw new EmailOtpError("This code has already been used. Please request a new one.");
}

// ------------------------------------------- Student: verify own account email

export async function sendOwnEmailVerification(studentDbId: string, ipAddress: string) {
  const student = await prisma.student.findUnique({ where: { id: studentDbId }, select: { email: true, emailVerifiedAt: true } });
  if (!student?.email) throw new EmailOtpError("There is no email address on your account.");
  if (student.emailVerifiedAt) throw new EmailOtpError("Your email is already verified.");
  await sendEmailOtp({ email: student.email, purpose: "VERIFY_EMAIL", studentId: studentDbId, ipAddress });
  return { maskedEmail: maskEmail(student.email) };
}

export async function confirmOwnEmailVerification(studentDbId: string, code: string) {
  const student = await prisma.student.findUnique({ where: { id: studentDbId }, select: { email: true, emailVerifiedAt: true } });
  if (!student?.email) throw new EmailOtpError("There is no email address on your account.");
  if (student.emailVerifiedAt) return;
  await verifyEmailOtp({ email: student.email, purpose: "VERIFY_EMAIL", studentId: studentDbId, code });
  // Only if the address is still the one the code was sent to.
  const updated = await prisma.student.updateMany({
    where: { id: studentDbId, email: student.email, emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });
  if (updated.count === 1) {
    await prisma.studentActivity.create({ data: { studentId: studentDbId, activity: "EMAIL_VERIFIED", metadata: { method: "email-otp" } } });
  }
}
