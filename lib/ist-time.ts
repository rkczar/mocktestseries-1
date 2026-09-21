/**
 * IST (Asia/Kolkata, UTC+5:30) wall-clock helpers for the Live Test
 * scheduling UI.
 *
 * The server runs in UTC (confirmed: `TZ=Etc/UTC`), but admins set Live Test
 * windows in India Standard Time and expect the wall-clock time they typed
 * to mean IST, not the server's local zone. `new Date("...")` on a bare
 * `<input type="datetime-local">` value (no offset) is parsed in the
 * RUNNING PROCESS's local zone — on this server, UTC — which would silently
 * shift every schedule by 5.5 hours. Appending the fixed `+05:30` offset
 * before parsing sidesteps that entirely: the resulting UTC instant is
 * correct regardless of what timezone the Node process happens to run in.
 * IST has no daylight-saving rules, so the offset is always exactly +05:30.
 */

const IST_OFFSET = "+05:30";

/** Parses a `datetime-local` form value ("YYYY-MM-DDTHH:mm"), read as IST wall-clock time, into the correct UTC Date. */
export function parseIstDateTimeLocal(value: string): Date | null {
  if (!value) return null;
  const date = new Date(`${value}:00${IST_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats a Date as a `datetime-local` input value ("YYYY-MM-DDTHH:mm") in IST, for pre-filling the edit form. */
export function toIstDateTimeLocalValue(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The IST calendar date ("YYYY-MM-DD") a moment falls on — used to bucket activity into study-streak days by IST, not UTC. */
export function toIstDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** The UTC instant of 00:00 IST on the calendar day containing `date` — the start of "today" by IST wall-clock, for daily-quota/limit windows. */
export function istStartOfDay(date: Date): Date {
  const istDate = toIstDateString(date);
  return parseIstDateTimeLocal(`${istDate}T00:00`)!;
}

/** Human-readable IST display, e.g. "17 Sep 2026, 2:00 PM IST". */
export function formatIst(date: Date): string {
  const formatted = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${formatted} IST`;
}
