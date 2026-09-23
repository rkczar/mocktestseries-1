/**
 * Money helpers. Every amount in the commerce layer is an integer number of
 * paise — never a float rupee value — so arithmetic is exact. These helpers
 * are pure and client-safe (no server-only import) so the checkout UI can
 * format server-computed quotes without recomputing them.
 */

export function formatInr(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}

/** Parses an admin-entered rupee string ("499", "499.50") into paise, or null if invalid. */
export function rupeesToPaise(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (s === "") return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function paiseToRupeeString(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  const whole = Math.floor(paise / 100);
  const frac = paise % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

/** Whole-percent discount off `base`, floored so the student is never overcharged by rounding. */
export function percentOf(base: number, percent: number): number {
  return Math.floor((base * percent) / 100);
}

export function discountPercent(mrp: number, final: number): number {
  if (mrp <= 0 || final >= mrp) return 0;
  return Math.round(((mrp - final) * 100) / mrp);
}
