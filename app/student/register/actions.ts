"use server";

import { hash } from "@node-rs/argon2";
import { AuthError } from "next-auth";
import { z } from "zod";

import { studentSignIn } from "@/lib/auth/student";
import { prisma } from "@/lib/db";

const registerSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

export type RegisterState = { error?: string } | undefined;

export async function registerAction(
  _prevState: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const parsed = registerSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }
  const { name, email, password } = parsed.data;

  const existing = await prisma.student.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with this email already exists." };
  }

  const passwordHash = await hash(password);
  await prisma.student.create({ data: { name, email, passwordHash } });

  try {
    await studentSignIn("credentials", { email, password, redirectTo: "/student/dashboard" });
  } catch (error) {
    if (error instanceof AuthError) {
      return { error: "Account created, but sign-in failed — try logging in." };
    }
    throw error;
  }
}
