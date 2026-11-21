"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headers } from "next/headers";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { requestAdminLoginOtp } from "@/lib/admin-otp-login";

export interface LoginFormState {
  error?: string;
}

export async function loginAction(
  _prevState: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const callbackUrl = String(formData.get("callbackUrl") ?? "/admin");

  // Teachers sign in here too, but land in the Teacher Portal (a redirect to
  // /admin would only be bounced by the proxy, leaving /admin in the address bar).
  const isTeacher = username
    ? (await prisma.adminUser.findUnique({ where: { username }, select: { role: { select: { name: true } } } }))?.role.name === "TEACHER"
    : false;
  const toTeacher = callbackUrl === "/teacher" || callbackUrl.startsWith("/teacher/");
  try {
    await signIn("credentials", {
      username,
      password,
      redirectTo: isTeacher ? (toTeacher ? callbackUrl : "/teacher") : callbackUrl.startsWith("/admin") ? callbackUrl : "/admin",
    });
    return {};
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.type === "CredentialsSignin") {
        const cause = (error.cause as { err?: Error } | undefined)?.err;
        if (cause?.message === "TooManyAttempts") {
          return { error: "Too many login attempts. Please wait a few minutes and try again." };
        }
        return { error: "Invalid Admin ID or password." };
      }
      return { error: "Something went wrong signing you in. Please try again." };
    }
    // Next.js throws a special redirect "error" on success — rethrow it.
    throw error;
  }
}

/** Login with OTP, step 1: sends a code when the identifier is an eligible admin (the answer never says which). */
export async function requestAdminOtpAction(identifier: string): Promise<{ ok: boolean; message: string }> {
  return requestAdminLoginOtp(String(identifier ?? "").slice(0, 200), clientIpFromHeaders(await headers()));
}

/** Login with OTP, step 2: the normal admin session through the "admin-otp" provider. */
export async function otpLoginAction(_prevState: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const callbackUrl = String(formData.get("callbackUrl") ?? "/admin");
  try {
    await signIn("admin-otp", {
      identifier: String(formData.get("identifier") ?? ""),
      code: String(formData.get("code") ?? ""),
      redirectTo: callbackUrl.startsWith("/admin") ? callbackUrl : "/admin",
    });
    return {};
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.type === "CredentialsSignin") {
        const cause = (error.cause as { err?: Error } | undefined)?.err;
        if (cause?.message === "TooManyAttempts") return { error: "Too many login attempts. Please wait a few minutes and try again." };
        return { error: "Invalid or expired code. Request a new code and try again." };
      }
      return { error: "Something went wrong signing you in. Please try again." };
    }
    throw error;
  }
}
