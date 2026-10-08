"use server";

import { AuthError } from "next-auth";
import { z } from "zod";
import argon2 from "argon2";
import { StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { studentSignIn } from "@/lib/auth-student";
import { nextStudentId } from "@/lib/student-id";
import { requestOtp, OtpError } from "@/lib/otp";
import { safeStudentCallback } from "@/lib/student-callback";
import { getAuthProviderConfig } from "@/lib/auth-provider-config";
import { getClientIp } from "@/lib/client-ip";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";
import { getPlatformControls, effectivePlatformControls, pausedMessage } from "@/lib/platform-controls";
import {
  requestPasswordReset,
  verifyPasswordResetCode,
  resetPasswordWithToken,
  PasswordResetError,
} from "@/lib/password-reset";
import { queueWelcomeEmail } from "@/lib/email/events";
import { parseIndianMobile, INDIAN_MOBILE_ERROR } from "@/lib/indian-mobile";

export interface AuthFormState {
  error?: string;
  info?: string;
  sent?: boolean;
  existing?: boolean;
  mobile?: string;
  name?: string;
  devCode?: string;
}

const safeCallback = safeStudentCallback;

const clientIp = getClientIp;

function unwrapAuthError(error: unknown, fallback: string): string {
  if (error instanceof AuthError) {
    const cause = (error.cause as { err?: Error } | undefined)?.err;
    return cause?.message ?? fallback;
  }
  throw error;
}

export async function loginWithPasswordAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const callbackUrl = safeCallback(String(formData.get("callbackUrl") ?? ""));

  if (!identifier || !password) return { error: "Please fill in all fields." };

  try {
    await studentSignIn("password", { identifier, password, redirectTo: callbackUrl });
    return {};
  } catch (error) {
    return { error: unwrapAuthError(error, "Invalid email/mobile or password.") };
  }
}

const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Full name is required."),
    email: z.string().trim().toLowerCase().email("Enter a valid email address."),
    mobile: z.string().trim().regex(/^\+?[0-9]{7,15}$/, "Enter a valid mobile number."),
    password: z.string().min(8, "Password must be at least 8 characters."),
    confirmPassword: z.string(),
    acceptTerms: z.string().optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  })
  .refine((data) => data.acceptTerms === "on", {
    message: "You must accept the Terms & Conditions.",
    path: ["acceptTerms"],
  });

export async function registerWithPasswordAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  // The Admin API Manager toggles hide the form; enforce them here too.
  const providerConfig = await getAuthProviderConfig();
  if (!providerConfig.registerEnabled) return { error: "New account creation is currently disabled." };
  // Mandatory mobile verification: the only way to create an account is the
  // mobile-first OTP sign-up (sendRegisterOtpAction → verifyRegisterOtpAction).
  // Refused here too, so a direct POST to this action cannot bypass it.
  if (providerConfig.mobileVerificationRequired) {
    return { error: "Please create your account with your mobile number and OTP verification." };
  }
  if (!providerConfig.passwordEnabled) return { error: "Password login is currently disabled." };
  // Platform Controls → New Registrations (also Lockdown / Maintenance / Login paused).
  const platform = await getPlatformControls();
  if (!effectivePlatformControls(platform).registrationsOpen) return { error: pausedMessage(platform, "registrations") };

  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form and try again." };
  }
  const { name, email, mobile, password } = parsed.data;
  const callbackUrl = safeCallback(String(formData.get("callbackUrl") ?? ""));

  const existing = await prisma.student.findFirst({ where: { OR: [{ email }, { mobile }] } });
  if (existing) {
    return { error: "An account with this email or mobile number already exists. Please login instead." };
  }

  const passwordHash = await argon2.hash(password);
  const studentId = await nextStudentId();

  const student = await prisma.student.create({
    data: { studentId, name, email, mobile, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
  });
  await prisma.studentProfile.create({ data: { studentId: student.id } });
  await prisma.studentActivity.create({
    data: { studentId: student.id, activity: "REGISTERED", metadata: { method: "password" } },
  });
  await ensureDefaultExamEnrollmentSafely(student.id);
  await queueWelcomeEmail(student.id);

  try {
    await studentSignIn("password", { identifier: email, password, redirectTo: callbackUrl });
    return {};
  } catch (error) {
    return { error: unwrapAuthError(error, "Account created — please login.") };
  }
}

/**
 * Phone OTP sign-in, step 1. The answer is the same whether or not the number
 * has an account (no enumeration before the OTP); the sign-in provider tells
 * the number's owner after the code is verified. New accounts are created only
 * through Create Account (sendRegisterOtpAction).
 */
export async function sendMobileOtpAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const mobile = parseIndianMobile(String(formData.get("mobile") ?? ""));
  if (!mobile) return { error: INDIAN_MOBILE_ERROR };

  // Platform Controls: don't send (or pay for) an OTP that could only be refused at verify time.
  const platform = await getPlatformControls();
  if (!effectivePlatformControls(platform).loginOpen) return { error: pausedMessage(platform, "login") };

  try {
    const { devCode } = await requestOtp(mobile.e164, "LOGIN", await clientIp());
    return { sent: true, existing: true, mobile: mobile.e164, devCode };
  } catch (error) {
    if (error instanceof OtpError) return { error: error.message };
    throw error;
  }
}

export async function verifyMobileOtpAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const mobile = parseIndianMobile(String(formData.get("mobile") ?? ""));
  const code = String(formData.get("code") ?? "").trim();
  const callbackUrl = safeCallback(String(formData.get("callbackUrl") ?? ""));

  if (!mobile) return { error: INDIAN_MOBILE_ERROR };
  if (!code) return { error: "Enter the verification code." };

  try {
    await studentSignIn("otp", { mobile: mobile.e164, code, mode: "login", redirectTo: callbackUrl });
    return {};
  } catch (error) {
    return { error: unwrapAuthError(error, "Verification failed. Please try again.") };
  }
}

function parseFullName(raw: FormDataEntryValue | null): string | null {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  return name.length >= 2 && name.length <= 80 ? name : null;
}

/**
 * Create Account (mobile-first), step 1: Full Name + +91 mobile → OTP.
 * Same answer whether or not the number already has an account; that is
 * only revealed after the OTP proves ownership (lib/auth-student.ts).
 */
export async function sendRegisterOtpAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const providerConfig = await getAuthProviderConfig();
  if (!providerConfig.registerEnabled) return { error: "New account creation is currently disabled." };
  const platform = await getPlatformControls();
  if (!effectivePlatformControls(platform).registrationsOpen) return { error: pausedMessage(platform, "registrations") };

  const name = parseFullName(formData.get("name"));
  if (!name) return { error: "Enter your full name (2–80 characters)." };
  const mobile = parseIndianMobile(String(formData.get("mobile") ?? ""));
  if (!mobile) return { error: INDIAN_MOBILE_ERROR };

  try {
    const { devCode } = await requestOtp(mobile.e164, "REGISTER", await clientIp());
    return { sent: true, mobile: mobile.e164, name, devCode };
  } catch (error) {
    if (error instanceof OtpError) return { error: error.message };
    throw error;
  }
}

/**
 * Create Account, step 2. The OTP is verified and the account created in ONE
 * server-side call (the "otp" provider, register mode), which then signs the
 * student in — there is no verified-flag or token for the browser to replay.
 */
export async function verifyRegisterOtpAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const name = parseFullName(formData.get("name"));
  const mobile = parseIndianMobile(String(formData.get("mobile") ?? ""));
  const code = String(formData.get("code") ?? "").trim();
  const callbackUrl = safeCallback(String(formData.get("callbackUrl") ?? ""));

  if (!name) return { error: "Enter your full name (2–80 characters)." };
  if (!mobile) return { error: INDIAN_MOBILE_ERROR };
  if (!/^[0-9]{6}$/.test(code)) return { error: "Enter the 6-digit verification code." };

  try {
    await studentSignIn("otp", { mobile: mobile.e164, code, mode: "register", name, redirectTo: callbackUrl });
    return {};
  } catch (error) {
    return { error: unwrapAuthError(error, "Verification failed. Please try again.") };
  }
}

export async function googleSignInAction(formData: FormData) {
  const callbackUrl = safeCallback(String(formData.get("callbackUrl") ?? ""));
  await studentSignIn("google", { redirectTo: callbackUrl });
}

// --- Forgot Password (phone OTP → reset token → new password). See lib/password-reset.ts.

export interface ResetFormState {
  error?: string;
  step?: "code" | "password" | "done";
  identifier?: string;
  token?: string;
  devCode?: string;
}

export async function requestPasswordResetAction(
  _prevState: ResetFormState,
  formData: FormData
): Promise<ResetFormState> {
  const identifier = String(formData.get("identifier") ?? "").trim();
  if (!identifier) return { error: "Enter your email, mobile number or User ID." };
  try {
    const { devCode } = await requestPasswordReset(identifier, await clientIp());
    return { step: "code", identifier, devCode };
  } catch (error) {
    if (error instanceof PasswordResetError || error instanceof OtpError) return { error: error.message };
    throw error;
  }
}

export async function verifyPasswordResetCodeAction(
  prevState: ResetFormState,
  formData: FormData
): Promise<ResetFormState> {
  // Already verified: a duplicate submit (OTP box auto-submit + button) must not
  // replace the issued token with a "code already used" error.
  if (prevState.step === "password" && prevState.token) return prevState;
  const identifier = String(formData.get("identifier") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { step: "code", identifier, error: "Enter the verification code." };
  try {
    const token = await verifyPasswordResetCode(identifier, code, await clientIp());
    return { step: "password", identifier, token };
  } catch (error) {
    if (error instanceof PasswordResetError) return { step: "code", identifier, error: error.message };
    throw error;
  }
}

export async function resetPasswordAction(
  _prevState: ResetFormState,
  formData: FormData
): Promise<ResetFormState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");
  if (password !== confirmPassword) return { step: "password", token, error: "Passwords do not match." };
  try {
    await resetPasswordWithToken(token, password);
    return { step: "done" };
  } catch (error) {
    if (error instanceof PasswordResetError) {
      return { step: /expired/i.test(error.message) ? undefined : "password", token, error: error.message };
    }
    throw error;
  }
}
