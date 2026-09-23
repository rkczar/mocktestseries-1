/**
 * Derives a Scheduled Mock Test's release state from server time, the same
 * way lib/live-test.ts#deriveLiveTestState derives LIVE/ENDED from
 * startAt/endAt. Deliberately pure (no `prisma`, no `server-only`) so it's
 * unit-testable and safe to call from both server and client code.
 *
 * Unlike LiveTest, there is no availableUntil — once AVAILABLE, a Scheduled
 * Mock Test never auto-closes. `availableFrom: null` preserves the test's
 * pre-existing behavior exactly: a PUBLISHED test with no schedule is
 * available immediately, so every MockTest row that existed before this
 * feature is unaffected.
 */
import type { MockTestStatus } from "@prisma/client";

export type MockTestAvailability = "UPCOMING" | "AVAILABLE";

export interface MockTestScheduleRow {
  status: MockTestStatus;
  availableFrom: Date | null;
}

/**
 * The single source of truth for whether a student may start/see this test.
 * Every server-side gate (attempt creation, resource release, dashboard
 * queries) must go through this function rather than re-deriving the logic.
 */
export function isMockTestAvailable(mockTest: MockTestScheduleRow, now: Date = new Date()): boolean {
  if (mockTest.status !== "PUBLISHED") return false;
  if (!mockTest.availableFrom) return true;
  return now.getTime() >= mockTest.availableFrom.getTime();
}

export function deriveMockTestAvailability(mockTest: MockTestScheduleRow, now: Date = new Date()): MockTestAvailability {
  return isMockTestAvailable(mockTest, now) ? "AVAILABLE" : "UPCOMING";
}
