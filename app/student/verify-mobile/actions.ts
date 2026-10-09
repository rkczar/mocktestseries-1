"use server";

import { getClientIp } from "@/lib/client-ip";
import { requireStudentAllowUnverified, StudentUnauthorizedError } from "@/lib/student-session";
import {
  sendMobileVerificationOtp,
  confirmMobileVerificationOtp,
  MobileVerificationError,
  MobileInUseError,
} from "@/lib/mobile-verification";
import {
  getStudentRecoveryState,
  sendHolderEmailProof,
  confirmHolderEmailProof,
  submitRecoveryRequest,
  cancelRecoveryRequest,
  AccountRecoveryError,
  type StudentRecoveryView,
} from "@/lib/account-recovery";

export interface VerifyMobileState {
  error?: string;
  sent?: boolean;
  /** E.164 of the number the code was sent to. */
  mobile?: string;
  verified?: boolean;
  devCode?: string;
  /** Set when the proven number belongs to another account (recovery request recorded server-side). */
  recovery?: StudentRecoveryView;
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
    if (error instanceof MobileInUseError) {
      const student = await requireStudentAllowUnverified();
      return { sent: true, mobile, error: error.message, recovery: (await getStudentRecoveryState(student.id)) ?? undefined };
    }
    if (error instanceof MobileVerificationError) return { sent: true, mobile, error: error.message };
    throw error;
  }
}

// ------------------------------------------------------------ Recovery request
// Same restricted session: each action only reaches the signed-in student's
// OWN request (lib/account-recovery.ts filters by requesterId).

export interface RecoveryActionState {
  error?: string;
  notice?: string;
  view?: StudentRecoveryView | null;
}

async function recoveryAction(run: (studentId: string) => Promise<string | void>): Promise<RecoveryActionState> {
  try {
    const student = await requireStudentAllowUnverified();
    const notice = (await run(student.id)) ?? undefined;
    return { notice, view: await getStudentRecoveryState(student.id) };
  } catch (error) {
    if (error instanceof StudentUnauthorizedError) return { error: SIGNED_OUT };
    if (error instanceof AccountRecoveryError) {
      const student = await requireStudentAllowUnverified().catch(() => null);
      return { error: error.message, view: student ? await getStudentRecoveryState(student.id) : undefined };
    }
    throw error;
  }
}

export async function sendRecoveryEmailProofAction(_prev: RecoveryActionState, formData: FormData): Promise<RecoveryActionState> {
  const ip = await getClientIp();
  return recoveryAction(async (studentId) => {
    const { holderEmailMasked } = await sendHolderEmailProof(studentId, String(formData.get("requestId") ?? ""), ip);
    return `We sent a 6-digit code to ${holderEmailMasked}.`;
  });
}

export async function confirmRecoveryEmailProofAction(_prev: RecoveryActionState, formData: FormData): Promise<RecoveryActionState> {
  return recoveryAction(async (studentId) => {
    await confirmHolderEmailProof(studentId, String(formData.get("requestId") ?? ""), String(formData.get("code") ?? ""));
    return "Email confirmed.";
  });
}

export async function submitRecoveryRequestAction(_prev: RecoveryActionState, formData: FormData): Promise<RecoveryActionState> {
  return recoveryAction(async (studentId) => {
    await submitRecoveryRequest(studentId, String(formData.get("requestId") ?? ""), String(formData.get("note") ?? ""));
  });
}

export async function cancelRecoveryRequestAction(_prev: RecoveryActionState, formData: FormData): Promise<RecoveryActionState> {
  return recoveryAction(async (studentId) => {
    await cancelRecoveryRequest(studentId, String(formData.get("requestId") ?? ""));
    return "Request cancelled.";
  });
}
