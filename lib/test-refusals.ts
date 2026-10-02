/**
 * Student-facing explanations for a refused test start, keyed by a short
 * slug that travels in the /student/unavailable?test=<key> URL. Only these
 * fixed texts are ever shown — never text taken from the URL.
 */
export const TEST_REFUSALS = {
  "not-released": "This test is not available yet. It opens on its scheduled release date — check the schedule in Test Series.",
  closed: "This test window has closed. New attempts are no longer accepted.",
  "no-questions": "This test has no questions yet. Please try again later.",
  "retake-blocked": "You have already attempted this test. Retakes are not allowed — open your result from History.",
  "live-not-started": "This live test has not started yet.",
  "live-ended": "This live test has ended.",
  "live-cancelled": "This live test was cancelled.",
  "not-found": "This test is no longer available. It may have been withdrawn or replaced.",
} as const;

export type TestRefusalKey = keyof typeof TEST_REFUSALS;

/** Maps a lib/test-attempt.ts refusal message to its explanation key. */
export function testRefusalKey(message: string): TestRefusalKey {
  if (/not available yet/i.test(message)) return "not-released";
  if (/window has closed/i.test(message)) return "closed";
  if (/no questions/i.test(message)) return "no-questions";
  if (/retakes are not allowed/i.test(message)) return "retake-blocked";
  if (/has not started yet/i.test(message)) return "live-not-started";
  if (/has ended/i.test(message)) return "live-ended";
  if (/cancelled/i.test(message)) return "live-cancelled";
  return "not-found";
}

export function isTestRefusalKey(value: string | undefined): value is TestRefusalKey {
  return !!value && Object.prototype.hasOwnProperty.call(TEST_REFUSALS, value);
}
