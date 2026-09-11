"use server";

import { AuthError } from "next-auth";

import { studentSignIn } from "@/lib/auth/student";

export type LoginState = { error?: string } | undefined;

export async function studentLoginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/student/dashboard");

  try {
    await studentSignIn("credentials", {
      email,
      password,
      redirectTo: next.startsWith("/student") ? next : "/student/dashboard",
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Incorrect email or password." };
    }
    throw error;
  }
}
