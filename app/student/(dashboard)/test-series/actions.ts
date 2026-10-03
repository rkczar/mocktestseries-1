"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrExplain, startOrPaywall } from "@/lib/payments/paywall";
import { previewFormalTestStart, startMockTestAttempt, startOfflineOmrEntryAttempt } from "@/lib/test-attempt";

export interface StartMockTestFormState {
  error?: string;
}

/**
 * "Resume Test" (and "Start Test" for a mock that offers no Pre-Test Setup)
 * on the Mock Test Details page. The student has already read the
 * instructions there, so this goes straight to the player.
 * startMockTestAttempt stays the only gate (entitlement → resume existing
 * IN_PROGRESS attempt → availability window → attempt policy); a payment
 * error still redirects to checkout, and any other refusal (e.g. the window
 * closed while the page was open) is shown inline instead of an error page.
 * When no attempt is running any more (it timed out meanwhile) and this mock
 * offers a Pre-Test Setup, the page is reloaded to show it instead of
 * silently starting a new attempt with default choices.
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
    const preview = await startOrPaywall(() => previewFormalTestStart(student.id, { kind: "MOCK_TEST", id: mockTestId }));
    if (!preview.resume && preview.summary.configurable) redirect(`/student/test-series/${encodeURIComponent(mockTestId)}`);
    attempt = await startOrPaywall(() => startMockTestAttempt(student.id, mockTestId));
  } catch (error) {
    unstable_rethrow(error); // the paywall / setup redirect must propagate

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
  const attempt = await startOrExplain(() => startOfflineOmrEntryAttempt(student.id, mockTestId), {
    route: "test-series/omr-entry",
    studentId: student.id,
    contentId: mockTestId,
  });
  redirect(`/student/attempt/${attempt.id}/omr-entry`);
}
