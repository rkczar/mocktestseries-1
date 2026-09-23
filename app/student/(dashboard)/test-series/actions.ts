"use server";

import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { startOrPaywall } from "@/lib/payments/paywall";
import { startOfflineOmrEntryAttempt } from "@/lib/test-attempt";

/**
 * Enter OMR Answers Online (Phase 3): starts the same attempt engine as
 * "Start Test" (startMockTestAttempt under the hood — availableFrom/
 * attemptPolicy are enforced identically), only tagged OFFLINE_OMR_ENTRY so
 * the attempt pages route into the answer-only entry screen instead of the
 * question player.
 */
export async function startOfflineOmrEntryFromTestSeriesAction(mockTestId: string) {
  const student = await requireStudent();
  const attempt = await startOrPaywall(() => startOfflineOmrEntryAttempt(student.id, mockTestId));
  redirect(`/student/attempt/${attempt.id}/omr-entry`);
}
