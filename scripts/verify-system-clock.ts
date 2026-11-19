/**
 * SYSTEM CLOCK card (components/admin/system-clock.tsx) — pure checks, no DB, no network.
 * IST = Asia/Kolkata (UTC+05:30), UTC = UTC; HH:MM:SS 24-hour; date transitions at each zone's midnight; the output
 * must not depend on the process timezone (run it under several TZ values):
 *   for z in UTC Asia/Kolkata America/Los_Angeles Pacific/Kiritimati; do TZ=$z npx tsx scripts/verify-system-clock.ts; done
 */
import { formatClock } from "@/components/admin/system-clock";

let fails = 0;
const check = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${JSON.stringify(info)}`}`);
};
const at = (iso: string) => Date.parse(iso);
const pad = (n: number) => String(n).padStart(2, "0");
// Independent reference: shift the epoch and read UTC fields (no Intl, no timezone database).
const ref = (ms: number, offsetMin: number) => {
  const d = new Date(ms + offsetMin * 60_000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

console.log(`process TZ=${process.env.TZ ?? "(unset)"} resolved=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

// 1. Accuracy against the independent reference over a spread of instants (every ~7 h 13 min for a year).
let bad = 0;
for (let ms = at("2026-01-01T00:00:00Z"); ms < at("2027-01-01T00:00:00Z"); ms += 26_003_000) {
  if (formatClock(ms, "ist").time !== ref(ms, 330) || formatClock(ms, "utc").time !== ref(ms, 0)) bad++;
}
check("IST = UTC + 05:30 and UTC = UTC, HH:MM:SS, over a year of instants", bad === 0, { bad });

// 2. Exact values.
const t = at("2026-11-19T12:34:56Z");
check("UTC 12:34:56 Thu 19 Nov 2026", JSON.stringify(formatClock(t, "utc")) === JSON.stringify({ time: "12:34:56", date: "Thu, 19 Nov 2026" }), formatClock(t, "utc"));
check("IST 18:04:56 Thu 19 Nov 2026", JSON.stringify(formatClock(t, "ist")) === JSON.stringify({ time: "18:04:56", date: "Thu, 19 Nov 2026" }), formatClock(t, "ist"));
check("24-hour format (no AM/PM, 00 not 24 at midnight)", formatClock(at("2026-11-19T00:00:00Z"), "utc").time === "00:00:00" && formatClock(at("2026-11-19T18:30:00Z"), "ist").time === "00:00:00");

// 3. Midnight transitions.
check("IST midnight: 18:29:59Z → 23:59:59 Thu 19 Nov", JSON.stringify(formatClock(at("2026-11-19T18:29:59Z"), "ist")) === JSON.stringify({ time: "23:59:59", date: "Thu, 19 Nov 2026" }), formatClock(at("2026-11-19T18:29:59Z"), "ist"));
check("IST midnight: 18:30:00Z → 00:00:00 Fri 20 Nov (UTC still 19 Nov)", JSON.stringify(formatClock(at("2026-11-19T18:30:00Z"), "ist")) === JSON.stringify({ time: "00:00:00", date: "Fri, 20 Nov 2026" }) && formatClock(at("2026-11-19T18:30:00Z"), "utc").date === "Thu, 19 Nov 2026");
check("UTC midnight: 23:59:59Z → 00:00:00Z next day", formatClock(at("2026-11-19T23:59:59Z"), "utc").date === "Thu, 19 Nov 2026" && JSON.stringify(formatClock(at("2026-11-20T00:00:00Z"), "utc")) === JSON.stringify({ time: "00:00:00", date: "Fri, 20 Nov 2026" }));
check("Year end: IST enters 2027 at 2026-12-31T18:30:00Z, UTC at 2027-01-01T00:00:00Z", formatClock(at("2026-12-31T18:30:00Z"), "ist").date === "Fri, 01 Jan 2027" && formatClock(at("2026-12-31T18:30:00Z"), "utc").date === "Thu, 31 Dec 2026" && formatClock(at("2027-01-01T00:00:00Z"), "utc").date === "Fri, 01 Jan 2027");
check("Leap day: 2028-02-29 shown in both zones", formatClock(at("2028-02-29T12:00:00Z"), "utc").date === "Tue, 29 Feb 2028" && formatClock(at("2028-02-29T12:00:00Z"), "ist").date === "Tue, 29 Feb 2028");

// 4. Each second advances the display by exactly one second.
let steps = 0;
for (let ms = at("2026-11-19T18:29:50Z"); ms < at("2026-11-19T18:30:10Z"); ms += 1000) if (formatClock(ms, "ist").time === ref(ms, 330) && formatClock(ms, "utc").time === ref(ms, 0)) steps++;
check("20 consecutive seconds across IST midnight: one second per tick", steps === 20, { steps });

console.log(fails ? `FAILED (${fails})` : "ALL PASS");
process.exit(fails ? 1 : 0);
