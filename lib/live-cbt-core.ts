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

// ---------------------------------------------------------------------------
// Live CBT promotion + sharing (Student Dashboard card, Share buttons and the
// public invitation page /live-cbt/[id]). Display text only — the invitation
// never grants anything: login, enrollment, payment, the window and result
// release are all still enforced by the normal server gates.
// ---------------------------------------------------------------------------

/** Public invitation page (works signed out). */
export function liveCbtInvitePath(mockTestId: string): string {
  return `/live-cbt/${encodeURIComponent(mockTestId)}`;
}

/** Where a signed-out visitor goes: login/register, then back to the test's enrollment page. */
export function liveCbtLoginHref(mockTestId: string): string {
  return `/login?callbackUrl=${encodeURIComponent(`/student/test-series/${encodeURIComponent(mockTestId)}`)}`;
}

const IST_DATE = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
const IST_TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });

/** "Thu, 08 Oct 2026" in IST (built from parts: en-IN puts a comma before the year). */
export function formatIstDay(date: Date): string {
  const part = Object.fromEntries(IST_DATE.formatToParts(date).map((p) => [p.type, p.value]));
  return `${part.weekday}, ${part.day} ${part.month} ${part.year}`;
}

/** "10:00 am" in IST (no suffix). */
export function formatIstClock(date: Date): string {
  return IST_TIME.format(date);
}

/** "10:00 am – 12:00 pm IST" (or "10:00 am IST" without an end). */
export function formatIstWindow(start: Date, end: Date | null): string {
  return end ? `${formatIstClock(start)} – ${formatIstClock(end)} IST` : `${formatIstClock(start)} IST`;
}

/**
 * The share text. Only the admin-configured test details and the public
 * invitation URL — never a student, attempt, answer or result.
 */
export function buildLiveCbtShareMessage(t: { examName: string; title: string; startsAt: Date; endsAt: Date | null; url: string }): string {
  return [
    `🩺 ${t.examName} — LIVE CBT`,
    "",
    `Test: ${t.title}`,
    `Date: ${formatIstDay(t.startsAt)}`,
    `Time: ${formatIstWindow(t.startsAt, t.endsAt)}`,
    "",
    "Experience a real-time computer-based mock test.",
    "Enroll now and compete with other aspirants.",
    "",
    t.url,
    "",
    "MockTestSeries.in",
  ].join("\n");
}

/** WhatsApp: the whole message (it already ends with the URL), encoded once. */
export function whatsappShareHref(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

/** Telegram puts `url` first, so the text is the message without its URL line. */
export function telegramShareHref(url: string, message: string): string {
  const text = message
    .split("\n")
    .filter((line) => line !== url)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}
