/**
 * Server-side test duration enforcement.
 *
 * The countdown shown to a student is UI only. This module is the single
 * source of truth for a test's authoritative time window:
 *
 *     effectiveEnd = MIN(startedAt + durationMinutes, liveTestEndAt ?? +Infinity)
 *
 * The `liveTestEndAt` cap only ever applies to Live Test attempts (see
 * `ServerTimedAttempt`) — every other test type is unaffected and behaves
 * exactly as before.
 *
 * Every mutating server action (saveAnswer / submitAttempt / resume /
 * continue) must verify the window through `isExpired` here — never by
 * trusting a browser clock or the client-submitted countdown.
 *
 * Boundary contract (deliberate, tested by scripts/verify-test-engine.ts):
 *   - `effectiveEnd` is EXCLUSIVE. The moment `now >= effectiveEnd` the
 *     attempt is over and answers can no longer be changed. There is no
 *     grace period — the endpoint of the window belongs to "after" on
 *     purpose, so a manipulated client clock can never squeeze edits in by
 *     hitting the boundary.
 *   - Submission is ALWAYS accepted, even late. Submitting after the window
 *     simply grades the answers that were on record before the deadline.
 *     This is what keeps a resume of a timed-out attempt safe: it closes out
 *     to a result instead of being invalidated.
 *   - Existing in-progress attempts created before this module shipped are
 *     not retroactively invalidated: they were already auto-submitted by the
 *     run page when resumed past their window, and `submit` still accepts
 *     them — only further edits are now refused once time is up.
 *
 * Everything here is pure (no prisma, no `server-only`) so the exact
 * boundary behavior is directly testable from a Node script.
 */

export interface ServerTimedAttempt {
  startedAt: Date;
  durationMinutes: number;
  /**
   * The test's global window end, shared by every student: a Fixed Window
   * Mock Test's availableUntil (or a legacy Live Test's endAt — the field
   * name predates Mock Test windows and is kept for script compatibility).
   * When present, it caps the by-duration end so a student who joins late
   * never gets their full duration past the global window — e.g. a
   * 2:00–3:00 PM window with a 60-minute duration, joined at 2:40 PM, ends
   * at 3:00 PM, not 3:40 PM. Undefined/null for every other test, which is
   * a no-op (unbounded cap).
   */
  liveTestEndAt?: Date | null;
  /**
   * Student practice with UNLIMITED time (AttemptDurationMode.UNLIMITED):
   * there is no window at all — never expired, no time-based auto-submit.
   */
  unlimited?: boolean;
}

/** Stand-in "end" for an unlimited attempt: far enough to never be reached. */
const UNLIMITED_END = new Date(8_640_000_000_000_000);

/** Authoritative end of an attempt: startedAt + duration, capped by the Live Test's global endAt when present. */
export function effectiveEndFor(attempt: ServerTimedAttempt): Date {
  if (attempt.unlimited) return UNLIMITED_END;
  const byDuration = new Date(attempt.startedAt.getTime() + attempt.durationMinutes * 60_000);
  if (attempt.liveTestEndAt && attempt.liveTestEndAt.getTime() < byDuration.getTime()) {
    return attempt.liveTestEndAt;
  }
  return byDuration;
}

/** Server's own clock — the only clock ever trusted. */
export function serverNow(): Date {
  return new Date();
}

/**
 * True once the attempt window is over. `effectiveEnd` is exclusive: at the
 * exact boundary `now === effectiveEnd` the attempt is already expired.
 */
export function isExpired(attempt: ServerTimedAttempt, now: Date = serverNow()): boolean {
  return now.getTime() >= effectiveEndFor(attempt).getTime();
}

/**
 * Whole seconds remaining before the window ends, never negative; 0 once
 * `now` crosses `effectiveEnd` (or is at it). The run page uses this as the
 * initial client countdown value only — it is NOT an allowance.
 */
export function remainingSecondsFor(attempt: ServerTimedAttempt, now: Date = serverNow()): number {
  const remainingMs = effectiveEndFor(attempt).getTime() - now.getTime();
  return Math.max(Math.floor(remainingMs / 1000), 0);
}

/**
 * Whole seconds that elapsed since the attempt started, clamped to
 * [0, effective window]. Used for `timeTakenSeconds` on submission so a late
 * submit can never report more time than the window actually permitted —
 * for a Live Test this is the effective (possibly global-endAt-capped)
 * window, not the nominal per-student duration.
 */
export function elapsedSecondsFor(attempt: ServerTimedAttempt, now: Date = serverNow()): number {
  if (attempt.unlimited) return Math.max(Math.floor((now.getTime() - attempt.startedAt.getTime()) / 1000), 0);
  const windowMs = effectiveEndFor(attempt).getTime() - attempt.startedAt.getTime();
  const elapsedMs = now.getTime() - attempt.startedAt.getTime();
  return Math.min(Math.max(Math.floor(elapsedMs / 1000), 0), Math.floor(windowMs / 1000));
}