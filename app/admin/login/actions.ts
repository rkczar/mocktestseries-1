"use server";

import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
