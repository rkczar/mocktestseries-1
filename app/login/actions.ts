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
import { getClientIp } from "@/lib/client-ip";
import { ensureDefaultExamEnrollmentSafely } from "@/lib/default-enrollment";
import {
  requestPasswordReset,
  verifyPasswordResetCode,
  resetPasswordWithToken,
  PasswordResetError,
} from "@/lib/password-reset";

export interface AuthFormState {
  error?: string;
  info?: string;
  sent?: boolean;
  existing?: boolean;
  mobile?: string;
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

  try {
    await studentSignIn("password", { identifier: email, password, redirectTo: callbackUrl });
    return {};
  } catch (error) {
    return { error: unwrapAuthError(error, "Account created — please login.") };
  }
}

function normalizeMobile(mobile: string) {
  return mobile.trim().replace(/[^\d+]/g, "");
}

export async function sendMobileOtpAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const mobile = normalizeMobile(String(formData.get("mobile") ?? ""));
  if (!/^\+?[0-9]{7,15}$/.test(mobile)) return { error: "Enter a valid mobile number." };

  const existingStudent = await prisma.student.findUnique({ where: { mobile } });
  const purpose = existingStudent ? "LOGIN" : "REGISTER";

  try {
    const { devCode } = await requestOtp(mobile, purpose, await clientIp());
    return { sent: true, existing: Boolean(existingStudent), mobile, devCode };
  } catch (error) {
    if (error instanceof OtpError) return { error: error.message };
    throw error;
  }
}

export async function verifyMobileOtpAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const mobile = normalizeMobile(String(formData.get("mobile") ?? ""));
  const code = String(formData.get("code") ?? "").trim();
  const existing = formData.get("existing") === "true";
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const callbackUrl = safeCallback(String(formData.get("callbackUrl") ?? ""));

  if (!mobile || !code) return { error: "Enter the verification code." };
  if (!existing && !name) return { error: "Full name is required to create your account." };

  try {
    await studentSignIn("otp", {
      mobile,
      code,
      mode: existing ? "login" : "register",
      name,
      email,
      redirectTo: callbackUrl,
    });
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
