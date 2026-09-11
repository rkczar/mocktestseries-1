"use server";

import { AuthError } from "next-auth";

import { adminSignIn } from "@/lib/auth/admin";

export type LoginState = { error?: string } | undefined;

export async function adminLoginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  try {
    await adminSignIn("credentials", { email, password, redirectTo: "/admin/dashboard" });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Incorrect email or password." };
    }
    throw error;
  }
}
