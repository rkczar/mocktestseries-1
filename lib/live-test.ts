/**
 * Derives a Live Test's effective, student-facing state from authoritative
 * server time rather than trusting a browser clock or a manually-set status
 * alone (Step 5.1/5.4).
 *
 * `LiveTestStatus` on the row only ever persists the states an admin
 * explicitly controls: DRAFT (not yet locked), SCHEDULED (locked — question
 * set resolved, window set), CANCELLED, and RESULT_PUBLISHED. LIVE and ENDED
 * are never written to the database — they are computed here, every time,
 * from `now` vs `startAt`/`endAt`, so they can never drift out of sync with
 * the wall clock the way a cron-updated status column could.
 *
 * Everything here is pure (no prisma, no `server-only`) so the exact
 * transition boundaries are directly testable from a Node script.
 */

export type DerivedLiveTestState = "DRAFT" | "SCHEDULED" | "LIVE" | "ENDED" | "RESULT_PUBLISHED" | "CANCELLED";

export interface LiveTestTimingRow {
  status: "DRAFT" | "SCHEDULED" | "LIVE" | "ENDED" | "RESULT_PUBLISHED" | "CANCELLED";
  startAt: Date;
  endAt: Date;
}

/**
 * DRAFT, CANCELLED and RESULT_PUBLISHED are explicit admin decisions and
 * always win outright — they can't be "derived away" by the clock. Once a
 * test is locked (persisted status SCHEDULED, i.e. neither DRAFT nor a
 * terminal state), LIVE/ENDED are derived purely from `now` against the
 * window.
 */
export function deriveLiveTestState(liveTest: LiveTestTimingRow, now: Date): DerivedLiveTestState {
  if (liveTest.status === "DRAFT" || liveTest.status === "CANCELLED" || liveTest.status === "RESULT_PUBLISHED") {
    return liveTest.status;
  }
  if (now.getTime() < liveTest.startAt.getTime()) return "SCHEDULED";
  if (now.getTime() < liveTest.endAt.getTime()) return "LIVE";
  return "ENDED";
}
