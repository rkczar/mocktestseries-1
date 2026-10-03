"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { AttemptEntryMode } from "@prisma/client";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrPaywall } from "@/lib/payments/paywall";
import { FORMAL_TIME_MODES, parseAttemptConfigForm } from "@/lib/attempt-config";
import { startMockTestAttempt, startPreviousYearPaperAttempt, TestEngineError } from "@/lib/test-attempt";

export interface PreTestSetupState {
  error?: string;
}

/**
 * Pre-Test Setup → start. The ONE start action for a configurable formal
 * test (Mock Test, Previous Year Paper). The choice is re-validated here and
 * applied by start*Attempt only when that test allows configuration
 * (studentConfigAllowed); every gate (entitlement, Platform Controls,
 * availability, attempt policy, idempotent start) runs inside the engine
 * exactly as for any other start. A running attempt is resumed untouched:
 * its frozen time and answer mode can never be changed from here.
 */
export async function startConfiguredTestAction(_prev: PreTestSetupState, formData: FormData): Promise<PreTestSetupState> {
  const student = await requireStudentOrLogin();
  const kind = formData.get("kind");
  const testId = formData.get("testId");
  if (typeof testId !== "string" || !testId || (kind !== "MOCK_TEST" && kind !== "PREVIOUS_YEAR_PAPER")) {
    return { error: "This test could not be found." };
  }
  const parsed = parseAttemptConfigForm(formData, FORMAL_TIME_MODES, "FIXED");
  if (!parsed.ok) return { error: parsed.error };

  let attempt: Awaited<ReturnType<typeof startMockTestAttempt>>;
  try {
    attempt = await startOrPaywall(() =>
      kind === "MOCK_TEST"
        ? startMockTestAttempt(student.id, testId, AttemptEntryMode.ONLINE, parsed.config)
        : startPreviousYearPaperAttempt(student.id, testId, parsed.config)
    );
  } catch (error) {
    unstable_rethrow(error); // paywall / pause redirects propagate
    if (error instanceof TestEngineError) return { error: error.message };
    console.error("[test-start] pre-test setup failed", error instanceof Error ? error.name : typeof error);
    return { error: "Could not start this test. Please try again." };
  }
  redirect(attempt.entryMode === AttemptEntryMode.OFFLINE_OMR_ENTRY ? `/student/attempt/${attempt.id}/omr-entry` : `/student/attempt/${attempt.id}/run`);
}
