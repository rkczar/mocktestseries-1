"use server";

import { revalidatePath } from "next/cache";
import argon2 from "argon2";
import { StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireStudentOrLogin } from "@/lib/student-session";
import { updateStudentProfile, requestAccountDeletion } from "@/lib/student-data";
import { DeletionLifecycleError } from "@/lib/student-lifecycle";
import { getClientIp } from "@/lib/client-ip";
import { sendOwnEmailVerification, confirmOwnEmailVerification, EmailOtpError } from "@/lib/email-otp";
import {
  DeviceActionError,
  logoutAllStudentSessions,
  revokeStudentSession,
  studentRemoveOwnDevice,
} from "@/lib/student-devices";

export interface ProfileActionState {
  error?: string;
  success?: string;
}

/**
 * Student-facing profile edit. The account `name` is a Student-Profile field
 * a student must never be able to change themselves (see Admin -> Students
 * for the authorized correction path) — this handler intentionally never
 * reads a "name" field from formData, so a modified form, a raw fetch to
 * this Server Action, or DevTools-edited HTML cannot rename the account
 * either; only `bio` is ever forwarded to updateStudentProfile.
 */
export async function updateProfileAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const student = await requireStudentOrLogin();
  const bio = String(formData.get("bio") ?? "").trim();

  await updateStudentProfile(student.id, { bio });
  revalidatePath("/student/profile");
  return { success: "Profile updated." };
}

export async function changePasswordAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const student = await requireStudentOrLogin();
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
  // Sign out every other session and keep this one. An untracked (pre-device-security)
  // session is skipped: the cut-off would sign out the current session too.
  if (student.sessionRowId) {
    await logoutAllStudentSessions(student.id, { studentId: student.id }, { exceptSessionRowId: student.sessionRowId, reason: "PASSWORD_CHANGED" });
    return { success: "Password changed. Your other devices have been signed out." };
  }
  return { success: "Password changed." };
}

export async function requestDeletionAction(_prev: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  // A revoked (e.g. already-deleted) session lands on login, never on a second request.
  const student = await requireStudentOrLogin();
  const reason = String(formData.get("reason") ?? "").trim();

  try {
    await requestAccountDeletion(student.id, reason || undefined);
  } catch (error) {
    if (error instanceof DeletionLifecycleError) return { error: error.message };
    throw error;
  }
  revalidatePath("/student/profile");
  return { success: "Your request has been submitted." };
}

// ---------------------------------------------------------------------------
// Devices & Security (lib/student-devices.ts). Every id is re-scoped to the
// signed-in student server-side; a forged id for someone else's device or
// session is simply "not found".
// ---------------------------------------------------------------------------

export interface DeviceActionState {
  error?: string;
  success?: string;
}

function deviceActionError(error: unknown): DeviceActionState {
  if (error instanceof DeviceActionError) return { error: error.message };
  throw error;
}

/** Sign out one other session. The device keeps its slot. */
export async function logoutDeviceSessionAction(sessionRowId: string): Promise<DeviceActionState> {
  const student = await requireStudentOrLogin();
  if (typeof sessionRowId !== "string" || !sessionRowId) return { error: "Session not found." };
  if (sessionRowId === student.sessionRowId) return { error: "This is your current session. Use Logout instead." };
  try {
    await revokeStudentSession(student.id, sessionRowId, { studentId: student.id }, "STUDENT_LOGOUT");
  } catch (error) {
    return deviceActionError(error);
  }
  revalidatePath("/student/profile");
  return { success: "That device has been signed out." };
}

/** Sign out everywhere except this session. */
export async function logoutOtherSessionsAction(): Promise<DeviceActionState> {
  const student = await requireStudentOrLogin();
  const { sessionsRevoked } = await logoutAllStudentSessions(
    student.id,
    { studentId: student.id },
    { exceptSessionRowId: student.sessionRowId, reason: "STUDENT_LOGOUT_OTHERS", cutoffUntracked: Boolean(student.sessionRowId) }
  );
  revalidatePath("/student/profile");
  return { success: sessionsRevoked > 0 ? "All other devices have been signed out." : "No other device was signed in." };
}

/** Remove a registered device (frees a slot) — only when Admin allows it, rate-limited. */
export async function removeOwnDeviceAction(deviceId: string): Promise<DeviceActionState> {
  const student = await requireStudentOrLogin();
  if (typeof deviceId !== "string" || !deviceId) return { error: "Device not found." };
  try {
    await studentRemoveOwnDevice(student.id, deviceId, student.deviceId);
  } catch (error) {
    return deviceActionError(error);
  }
  revalidatePath("/student/profile");
  return { success: "Device removed." };
}

// ------------------------------------------------------- Email verification
// Codes go to the address already on the account; the student can't choose
// another one here (lib/email-otp.ts).

export interface EmailVerifyState {
  error?: string;
  sent?: boolean;
  maskedEmail?: string | null;
  verified?: boolean;
}

export async function sendEmailVerificationAction(): Promise<EmailVerifyState> {
  const student = await requireStudentOrLogin();
  try {
    const { maskedEmail } = await sendOwnEmailVerification(student.id, await getClientIp());
    return { sent: true, maskedEmail };
  } catch (error) {
    if (error instanceof EmailOtpError) return { error: error.message };
    throw error;
  }
}

export async function confirmEmailVerificationAction(prev: EmailVerifyState, formData: FormData): Promise<EmailVerifyState> {
  if (prev.verified) return prev;
  const student = await requireStudentOrLogin();
  try {
    await confirmOwnEmailVerification(student.id, String(formData.get("code") ?? ""));
  } catch (error) {
    if (error instanceof EmailOtpError) return { ...prev, error: error.message };
    throw error;
  }
  // No revalidate here: the card stays to show the success message; the
  // "Verified" badge appears on the next load of the profile.
  return { sent: true, verified: true };
}
