/**
 * Live CBT = an existing Mock Test with a Fixed Window (availableFrom →
 * availableUntil) plus optional per-test enrollment. Pure rules, safe on
 * server and client (the countdown panel). The server is always the
 * authority: these drive UI and the gates in lib/live-cbt.ts /
 * lib/test-attempt.ts call the same functions with server time.
 */

export interface LiveEnrollmentRow {
  enrollmentEnabled: boolean;
  enrollmentOpensAt: Date | null;
  enrollmentClosesAt: Date | null;
  availableUntil: Date | null;
}

/** Enrollment closes at its own time, else when the test window closes, else never. */
export function effectiveEnrollmentCloseAt(m: Pick<LiveEnrollmentRow, "enrollmentClosesAt" | "availableUntil">): Date | null {
  return m.enrollmentClosesAt ?? m.availableUntil ?? null;
}

export type EnrollmentWindowState = "DISABLED" | "NOT_OPEN_YET" | "OPEN" | "CLOSED";

export function enrollmentWindowState(m: LiveEnrollmentRow, now: Date = new Date()): EnrollmentWindowState {
  if (!m.enrollmentEnabled) return "DISABLED";
  const t = now.getTime();
  if (m.enrollmentOpensAt && t < m.enrollmentOpensAt.getTime()) return "NOT_OPEN_YET";
  const closeAt = effectiveEnrollmentCloseAt(m);
  if (closeAt && t >= closeAt.getTime()) return "CLOSED";
  return "OPEN";
}

/** A Live CBT in the product sense: a Fixed Window mock (enrollment optional). */
export function isFixedWindow(m: { availableUntil: Date | null }): boolean {
  return m.availableUntil !== null;
}

/** "02:05:09" (or "3d 02:05:09") until `target`; "00:00:00" once reached. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hms = [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
  return d > 0 ? `${d}d ${hms}` : hms;
}
