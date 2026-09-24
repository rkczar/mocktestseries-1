/**
 * Derives a Mock Test's release state from server time. Mock Test is the one
 * canonical admin-created test: the retired Live Test product's fixed window
 * now lives here as an optional `availableUntil`. Deliberately pure (no
 * `prisma`, no `server-only`) so it's unit-testable and safe to call from
 * both server and client code.
 *
 * Availability mode is DERIVED from the two columns, never stored:
 *
 *   availableFrom null,  availableUntil null  → AVAILABLE_NOW
 *   availableFrom set,   availableUntil null  → SCHEDULED_RELEASE
 *   availableUntil set                        → FIXED_WINDOW
 *
 * `availableFrom: null` preserves the pre-existing behavior exactly: a
 * PUBLISHED test with no schedule is available immediately, so every
 * MockTest row that existed before these features is unaffected.
 */
import type { MockResultRelease, MockTestStatus } from "@prisma/client";

/**
 * Student-facing state of a PUBLISHED test. AVAILABLE = open with no end;
 * LIVE_NOW = inside a fixed window; CLOSED = fixed window has ended.
 */
export type MockTestAvailability = "UPCOMING" | "AVAILABLE" | "LIVE_NOW" | "CLOSED";

export type MockAvailabilityMode = "AVAILABLE_NOW" | "SCHEDULED_RELEASE" | "FIXED_WINDOW";

export const AVAILABILITY_MODE_LABELS: Record<MockAvailabilityMode, string> = {
  AVAILABLE_NOW: "Available Now",
  SCHEDULED_RELEASE: "Scheduled Release",
  FIXED_WINDOW: "Fixed Window",
};

export const AVAILABILITY_LABELS: Record<MockTestAvailability, string> = {
  UPCOMING: "Upcoming",
  AVAILABLE: "Available",
  LIVE_NOW: "Live Now",
  CLOSED: "Closed",
};

export const RESULT_RELEASE_LABELS: Record<MockResultRelease, string> = {
  IMMEDIATE: "Immediately after submission",
  AFTER_WINDOW: "After test window closes",
  CUSTOM_DATE: "Custom date/time",
};

export interface MockTestScheduleRow {
  status: MockTestStatus;
  availableFrom: Date | null;
  /** Optional so callers that only select availableFrom keep compiling; undefined = no window. */
  availableUntil?: Date | null;
}

export function deriveAvailabilityMode(mockTest: Pick<MockTestScheduleRow, "availableFrom" | "availableUntil">): MockAvailabilityMode {
  if (mockTest.availableUntil) return "FIXED_WINDOW";
  if (mockTest.availableFrom) return "SCHEDULED_RELEASE";
  return "AVAILABLE_NOW";
}

/**
 * Time-only state, ignoring publication. `availableUntil` is exclusive: at
 * the exact end instant the window is already CLOSED, matching
 * lib/attempt-timing.ts's boundary rule.
 */
export function deriveMockTestAvailability(
  mockTest: Pick<MockTestScheduleRow, "availableFrom" | "availableUntil">,
  now: Date = new Date()
): MockTestAvailability {
  const t = now.getTime();
  if (mockTest.availableFrom && t < mockTest.availableFrom.getTime()) return "UPCOMING";
  if (mockTest.availableUntil) return t < mockTest.availableUntil.getTime() ? "LIVE_NOW" : "CLOSED";
  return "AVAILABLE";
}

/**
 * The single source of truth for whether a student may START this test now.
 * Every server-side start gate must go through this function rather than
 * re-deriving the logic.
 */
export function isMockTestAvailable(mockTest: MockTestScheduleRow, now: Date = new Date()): boolean {
  if (mockTest.status !== "PUBLISHED") return false;
  const state = deriveMockTestAvailability(mockTest, now);
  return state === "AVAILABLE" || state === "LIVE_NOW";
}

/**
 * Whether the test has been RELEASED (its start time has passed), regardless
 * of whether a fixed window has since closed. Used by resource release
 * (Paper PDF "after available-from"), where a closed window must not
 * re-lock material that was already released.
 */
export function hasMockTestReleased(mockTest: MockTestScheduleRow, now: Date = new Date()): boolean {
  if (mockTest.status !== "PUBLISHED") return false;
  return !mockTest.availableFrom || now.getTime() >= mockTest.availableFrom.getTime();
}

export interface MockResultReleaseRow {
  availableUntil: Date | null;
  resultReleaseMode: MockResultRelease;
  resultReleaseAt: Date | null;
}

/**
 * The instant a submitted attempt's score/answer key/Review/Ask AI unlock,
 * or null for "immediately". A misconfigured row (AFTER_WINDOW with no
 * window, CUSTOM_DATE with no date) degrades to immediate release rather
 * than locking results forever — the admin actions refuse to save those.
 */
export function mockResultReleaseInstant(mockTest: MockResultReleaseRow): Date | null {
  if (mockTest.resultReleaseMode === "AFTER_WINDOW") return mockTest.availableUntil;
  if (mockTest.resultReleaseMode === "CUSTOM_DATE") return mockTest.resultReleaseAt;
  return null;
}

export function isMockResultReleased(mockTest: MockResultReleaseRow, now: Date = new Date()): boolean {
  const at = mockResultReleaseInstant(mockTest);
  return !at || now.getTime() >= at.getTime();
}

/**
 * Validates a posted schedule. Returns an error message or null. Shared by
 * the Mock Test editor, the create form and the Scheduled Tests view so the
 * three can never accept different shapes.
 */
export function validateMockSchedule(s: {
  mode: MockAvailabilityMode;
  availableFrom: Date | null;
  availableUntil: Date | null;
  resultReleaseMode: MockResultRelease;
  resultReleaseAt: Date | null;
}): string | null {
  if (s.mode === "SCHEDULED_RELEASE" && !s.availableFrom) return "Scheduled Release needs a release date/time.";
  if (s.mode === "FIXED_WINDOW") {
    if (!s.availableFrom || !s.availableUntil) return "Fixed Window needs both a start and an end date/time.";
    if (s.availableUntil.getTime() <= s.availableFrom.getTime()) return "The window's end must be after its start.";
  }
  if (s.resultReleaseMode === "AFTER_WINDOW" && s.mode !== "FIXED_WINDOW") {
    return "“After test window closes” needs a Fixed Window — choose another result release.";
  }
  if (s.resultReleaseMode === "CUSTOM_DATE" && !s.resultReleaseAt) return "Choose the result release date/time.";
  return null;
}

/**
 * Prisma filter for mocks that are LIVE to students/public: the test is
 * PUBLISHED and it is either standalone or inside a PUBLISHED Test Series.
 * One definition so every listing, count and the start gate agree.
 */
export const LIVE_MOCK_TEST_WHERE = {
  status: "PUBLISHED" as const,
  OR: [{ testSeriesId: null }, { testSeries: { status: "PUBLISHED" as const } }],
};
