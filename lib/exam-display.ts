/**
 * Pure display helpers for exam names and dates on public pages — no
 * database access, so client-safe components and scripts can import them.
 */

const DATE_ONLY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/** "13 Dec 2026" in IST. */
export function formatExamDate(date: Date): string {
  return DATE_ONLY.format(date);
}

/**
 * Exam names are stored for admin use (often upper-case, with "EXAM").
 * Public text reads better as "RUHS Medical Officer 2026": "EXAM" is
 * dropped, short acronyms (RUHS, NEET, UG, MO) and numbers are kept, other
 * all-caps words are title-cased. Mixed-case names are left as typed.
 */
export function displayExamName(name: string): string {
  const cleaned = name.replace(/\bEXAM\b/gi, " ").replace(/\s+/g, " ").trim();
  if (cleaned !== cleaned.toUpperCase()) return cleaned;
  return cleaned
    .split(" ")
    .map((w) => (/^[A-Z]{1,4}$/.test(w) || /\d/.test(w) ? w : w.toLowerCase().replace(/[a-z]/, (c) => c.toUpperCase())))
    .join(" ");
}
