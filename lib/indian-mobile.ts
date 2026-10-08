/**
 * Indian mobile numbers — the only kind accepted for student verification.
 * Pure helpers shared by the browser forms and the server (which always
 * re-validates; the client check is only for instant feedback).
 *
 * Storage format is E.164 (`+919876543210`); display is `+91 9876543210`.
 */

/** A 10-digit Indian mobile number starts with 6, 7, 8 or 9. */
export const INDIAN_MOBILE_PATTERN = /^[6-9][0-9]{9}$/;

export const INDIAN_MOBILE_ERROR = "Enter a valid 10-digit Indian mobile number.";

export interface IndianMobile {
  /** The 10-digit national number, e.g. 9876543210. */
  digits: string;
  /** E.164, e.g. +919876543210 — the only format written to the database. */
  e164: string;
}

/**
 * Parses what a student typed (or an old stored value) into an Indian mobile:
 * `9876543210`, `+91 98765 43210`, `919876543210`, `09876543210`.
 * Returns null for anything else.
 */
export function parseIndianMobile(input: string | null | undefined): IndianMobile | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!INDIAN_MOBILE_PATTERN.test(digits)) return null;
  // A leading "+" must be +91 (e.g. +1 555… is not accepted as Indian).
  if (raw.startsWith("+") && !raw.replace(/[\s-]/g, "").startsWith("+91")) return null;
  return { digits, e164: `+91${digits}` };
}

/** `+919876543210` → `+91 9876543210` (anything unparseable is returned as-is). */
export function formatIndianMobile(value: string | null | undefined): string {
  const parsed = parseIndianMobile(value);
  return parsed ? `+91 ${parsed.digits}` : String(value ?? "");
}

/**
 * Every spelling an older account may have stored for the same number
 * (registration used to accept any `+?[0-9]{7,15}`), so duplicate checks and
 * lookups by mobile see all of them, not just the E.164 form.
 */
export function storedMobileVariants(mobile: IndianMobile): string[] {
  const d = mobile.digits;
  return [`+91${d}`, `91${d}`, d, `0${d}`, `+910${d}`];
}
