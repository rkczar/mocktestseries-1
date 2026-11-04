/**
 * Student-facing Premium Trial length, derived ONLY from the admin-saved
 * `trialHours` (Admin → Payments → Free Access & Trial). Pure — safe in
 * client components. Whole days read as days (48 → "2-Day"), anything else
 * as hours (12 → "12-Hour"), so the copy can never disagree with the expiry.
 */

/** Suggested durations in the admin select; any whole number in TRIAL_HOURS_MIN..MAX is still accepted. */
export const TRIAL_HOURS_PRESETS = [1, 2, 6, 12, 24, 48, 72] as const;

/** "12-Hour", "1-Hour", "2-Day" — for titles and buttons ("Start 12-Hour Free Trial"). */
export function trialLengthLabel(hours: number): string {
  return hours % 24 === 0 ? `${hours / 24}-Day` : `${hours}-Hour`;
}

/** "12 hours", "1 hour", "2 days" — for running text. */
export function trialLengthText(hours: number): string {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return `${d} ${d === 1 ? "day" : "days"}`;
  }
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
