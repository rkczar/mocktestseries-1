/**
 * Display formatting for homepage statistic cards (Platform Stats / Social
 * Proof). Pure and dependency-free so the server renderer, the client
 * count-up animation and the admin editor's preview all format a number the
 * exact same way.
 */

export const STAT_FORMATS = ["EXACT", "K", "K_PLUS", "LAKH", "LAKH_PLUS"] as const;
export type StatFormat = (typeof STAT_FORMATS)[number];

export const STAT_FORMAT_LABELS: Record<StatFormat, string> = {
  EXACT: "Exact (1,25,430)",
  K: "Thousands (125.4K)",
  K_PLUS: "Thousands+ (125K+)",
  LAKH: "Lakh (1.2 Lakh)",
  LAKH_PLUS: "Lakh+ (1.2 Lakh+)",
};

export function isStatFormat(value: unknown): value is StatFormat {
  return typeof value === "string" && (STAT_FORMATS as readonly string[]).includes(value);
}

/** Trims to at most one decimal, dropping a trailing ".0". */
function oneDecimal(n: number, floor: boolean): string {
  const scaled = floor ? Math.floor(n * 10) / 10 : Math.round(n * 10) / 10;
  return scaled.toFixed(1).replace(/\.0$/, "");
}

/**
 * Formats a non-negative count. The "+" formats round DOWN, so the claim is
 * always true ("1.2 Lakh+" never stands for 1,19,000); the plain formats
 * round to nearest. Values below the unit fall back to exact grouping so a
 * small live number never renders as "0.1K".
 */
export function formatStatNumber(value: number, format: StatFormat = "EXACT"): string {
  const n = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const exact = n.toLocaleString("en-IN");
  switch (format) {
    case "K":
      return n >= 1000 ? `${oneDecimal(n / 1000, false)}K` : exact;
    case "K_PLUS":
      return n >= 1000 ? `${Math.floor(n / 1000).toLocaleString("en-IN")}K+` : n > 0 ? `${exact}+` : exact;
    case "LAKH":
      return n >= 100000 ? `${oneDecimal(n / 100000, false)} Lakh` : exact;
    case "LAKH_PLUS":
      return n >= 100000 ? `${oneDecimal(n / 100000, true)} Lakh+` : n > 0 ? `${exact}+` : exact;
    default:
      return exact;
  }
}

/**
 * Parses a MANUAL display value as a plain number ("12500", "12,500") so it
 * can be formatted/animated like a live one. Anything else ("50+", "4.8/5")
 * returns null and is shown verbatim.
 */
export function parseManualNumber(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.trim().replace(/,/g, "");
  if (!/^\d{1,12}$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Appends the admin suffix unless the formatted value already ends with it ("K+" + "+"). */
export function withSuffix(formatted: string, suffix: string | undefined): string {
  if (!suffix) return formatted;
  return formatted.endsWith(suffix) ? formatted : `${formatted}${suffix}`;
}
