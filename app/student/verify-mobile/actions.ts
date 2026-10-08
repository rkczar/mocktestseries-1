"use server";

import { getClientIp } from "@/lib/client-ip";
import { requireStudentAllowUnverified, StudentUnauthorizedError } from "@/lib/student-session";
import {
  sendMobileVerificationOtp,
  confirmMobileVerificationOtp,
  MobileVerificationError,
} from "@/lib/mobile-verification";

export interface VerifyMobileState {
  error?: string;
  sent?: boolean;
  /** E.164 of the number the code was sent to. */
  mobile?: string;
  verified?: boolean;
  devCode?: string;
}

const SIGNED_OUT = "Your session has ended. Please sign in again.";

/**
 * The restricted actions an unverified student may call: they use
 * requireStudentAllowUnverified() (signed in, verification not yet required)
 * and only ever touch the signed-in student's own row.
 */
export async function sendVerifyMobileOtpAction(_prev: VerifyMobileState, formData: FormData): Promise<VerifyMobileState> {
  try {
    const student = await requireStudentAllowUnverified();
    const { mobile, devCode } = await sendMobileVerificationOtp(student.id, String(formData.get("mobile") ?? ""), await getClientIp());
    return { sent: true, mobile: mobile.e164, devCode };
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) return { error: SIGNED_OUT };
    if (error instanceof MobileVerificationError) return { error: error.message };
    throw error;
  }
}

export async function confirmVerifyMobileOtpAction(prev: VerifyMobileState, formData: FormData): Promise<VerifyMobileState> {
  // A duplicate submit (autofill + button) after success must not turn into "code already used".
  if (prev.verified) return prev;
  const mobile = String(formData.get("mobile") ?? "");
  try {
    const student = await requireStudentAllowUnverified();
    await confirmMobileVerificationOtp(student.id, mobile, String(formData.get("code") ?? ""), await getClientIp());
    return { sent: true, mobile, verified: true };
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) return { sent: true, mobile, error: SIGNED_OUT };
    if (error instanceof MobileVerificationError) return { sent: true, mobile, error: error.message };
    throw error;
  }
}
