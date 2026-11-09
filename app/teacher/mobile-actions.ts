"use server";

import { revalidatePath } from "next/cache";
import { getClientIp } from "@/lib/client-ip";
import { requireTeacher } from "@/lib/teacher/session";
import { TeacherAccessError } from "@/lib/teacher/scope";
import { TeacherAuthError, confirmTeacherMobile, sendTeacherMobileVerifyCode } from "@/lib/teacher/auth";

export type MobileVerifyState = { sent?: boolean; ok?: string; error?: string; devCode?: string };

/**
 * Registered-mobile verification for OTP sign-in. The code always goes to the
 * number the Master Admin registered; a teacher can't enter or change it.
 */
async function run(fn: (teacherId: string) => Promise<MobileVerifyState>): Promise<MobileVerifyState> {
  try {
    const scope = await requireTeacher();
    return await fn(scope.teacherId);
  } catch (e) {
    if (e instanceof TeacherAuthError || e instanceof TeacherAccessError) return { error: e.message };
    throw e;
  }
}

export async function sendMobileVerifyCodeAction(): Promise<MobileVerifyState> {
  return run(async (id) => {
    const { devCode } = await sendTeacherMobileVerifyCode(id, await getClientIp());
    return { sent: true, devCode };
  });
}

export async function confirmMobileAction(_prev: MobileVerifyState, fd: FormData): Promise<MobileVerifyState> {
  return run(async (id) => {
    await confirmTeacherMobile(id, fd.get("code"));
    revalidatePath("/teacher");
    return { ok: "Mobile verified. You can now log in with OTP." };
  });
}
