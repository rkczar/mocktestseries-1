"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrPaywall } from "@/lib/payments/paywall";
import { startMockTestAttempt, startOfflineOmrEntryAttempt } from "@/lib/test-attempt";

export interface StartMockTestFormState {
  error?: string;
}

/**
 * "Start Test" / "Resume Test" on the Mock Test Details page. The student has
 * already read the instructions there, so this goes straight to the player.
 * startMockTestAttempt stays the only gate (entitlement → resume existing
 * IN_PROGRESS attempt → availability window → attempt policy); a payment
 * error still redirects to checkout, and any other refusal (e.g. the window
 * closed while the page was open) is shown inline instead of an error page.
 */
export async function startMockTestFromDetailsAction(
  _prev: StartMockTestFormState,
  formData: FormData
): Promise<StartMockTestFormState> {
  const student = await requireStudentOrLogin();
  const mockTestId = String(formData.get("mockTestId") ?? "");
  if (!mockTestId) return { error: "Mock test is required." };

  let attempt: Awaited<ReturnType<typeof startMockTestAttempt>>;
  try {
    attempt = await startOrPaywall(() => startMockTestAttempt(student.id, mockTestId));
  } catch (error) {
    unstable_rethrow(error); // the paywall redirect must propagate

    return { error: error instanceof Error ? error.message : "Could not start this test." };
  }
  redirect(attempt.entryMode === "OFFLINE_OMR_ENTRY" ? `/student/attempt/${attempt.id}/omr-entry` : `/student/attempt/${attempt.id}/run`);
}

/**
 * Enter OMR Answers Online (Phase 3): starts the same attempt engine as
 * "Start Test" (startMockTestAttempt under the hood — availableFrom/
 * attemptPolicy are enforced identically), only tagged OFFLINE_OMR_ENTRY so
 * the attempt pages route into the answer-only entry screen instead of the
 * question player.
 */
export async function startOfflineOmrEntryFromTestSeriesAction(mockTestId: string) {
  const student = await requireStudentOrLogin();
  const attempt = await startOrPaywall(() => startOfflineOmrEntryAttempt(student.id, mockTestId));
  redirect(`/student/attempt/${attempt.id}/omr-entry`);
}
