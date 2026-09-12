"use server";

import { revalidatePath } from "next/cache";
import argon2 from "argon2";
import { StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireStudent } from "@/lib/student-session";
import { updateStudentProfile, requestAccountDeletion } from "@/lib/student-data";

export interface ProfileActionState {
  error?: string;
  success?: string;
}

export async function updateProfileAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const student = await requireStudent();
  const name = String(formData.get("name") ?? "").trim();
  const bio = String(formData.get("bio") ?? "").trim();

  if (name.length < 2) return { error: "Full name must be at least 2 characters." };

  await updateStudentProfile(student.id, { name, bio });
  revalidatePath("/student/profile");
  return { success: "Profile updated." };
}

export async function changePasswordAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const student = await requireStudent();
  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword.length < 8) return { error: "New password must be at least 8 characters." };
  if (newPassword !== confirmPassword) return { error: "New passwords do not match." };

  const record = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
  if (record.authProvider !== StudentAuthProvider.CREDENTIALS || !record.passwordHash) {
    return { error: "Password change is not available for this account type." };
  }

  const valid = await argon2.verify(record.passwordHash, currentPassword).catch(() => false);
  if (!valid) return { error: "Current password is incorrect." };

  const passwordHash = await argon2.hash(newPassword);
  await prisma.student.update({ where: { id: student.id }, data: { passwordHash } });
  return { success: "Password changed." };
}

export async function requestDeletionAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const student = await requireStudent();
  const reason = String(formData.get("reason") ?? "").trim();

  await requestAccountDeletion(student.id, reason || undefined);
  revalidatePath("/student/profile");
  return { success: "Your request has been submitted." };
}
