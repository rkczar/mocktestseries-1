"use server";

import { AuthError } from "next-auth";
import { auth, signIn, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/client-ip";
import { OTP_SENT_GENERIC, TeacherAuthError, requestTeacherLoginOtp } from "@/lib/teacher/auth";

export interface TeacherLoginState {
  error?: string;
  info?: string;
  sent?: boolean;
  mobile?: string;
  /** Local/dev console provider only (lib/otp.ts never returns it in production). */
  devCode?: string;
}

/** Shows only our own, deliberately worded messages; anything else is generic. */
function failure(error: unknown, fallback: string): TeacherLoginState {
  if (error instanceof AuthError) {
    const cause = (error.cause as { err?: unknown } | undefined)?.err;
    return { error: cause instanceof TeacherAuthError ? cause.message : fallback };
  }
  throw error; // Next.js redirect on success
}

export async function teacherPasswordLoginAction(_prev: TeacherLoginState, fd: FormData): Promise<TeacherLoginState> {
  const username = String(fd.get("username") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  if (!username || !password) return { error: "Enter your username and password." };
  try {
    await signIn("teacher-password", { username, password, redirectTo: "/teacher" });
    return {};
  } catch (error) {
    return failure(error, "Invalid username or password.");
  }
}

export async function sendTeacherOtpAction(_prev: TeacherLoginState, fd: FormData): Promise<TeacherLoginState> {
  try {
    const { devCode } = await requestTeacherLoginOtp(fd.get("mobile"), await getClientIp());
    return { sent: true, mobile: String(fd.get("mobile") ?? "").trim(), info: OTP_SENT_GENERIC, devCode };
  } catch (error) {
    if (error instanceof TeacherAuthError) return { error: error.message, mobile: String(fd.get("mobile") ?? "").trim() };
    throw error;
  }
}

export async function teacherOtpLoginAction(_prev: TeacherLoginState, fd: FormData): Promise<TeacherLoginState> {
  const mobile = String(fd.get("mobile") ?? "").trim();
  try {
    await signIn("teacher-otp", { mobile, code: String(fd.get("code") ?? ""), redirectTo: "/teacher" });
    return {};
  } catch (error) {
    return { ...failure(error, "Verification failed. Please try again."), sent: true, mobile };
  }
}

/** Teacher sign-out: same server-side invalidation as the admin logout, back to the Teacher Login. */
export async function teacherLogoutAction() {
  const session = await auth();
  const id = session?.user?.id;
  if (id) {
    try {
      await prisma.adminUser.update({ where: { id }, data: { sessionsValidAfter: new Date() } });
      await prisma.auditLog.create({ data: { actorId: id, action: "TEACHER_LOGOUT", entityType: "AdminUser", entityId: id } });
    } catch {
      // Never block sign-out; the cookie is cleared regardless.
    }
  }
  await signOut({ redirectTo: "/teacher" });
}
