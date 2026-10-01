import {
  normalizeStatMetrics,
  STAT_DATA_SOURCE_LABELS,
  STAT_ICON_KEYS,
  type StatDynamicKey,
  type StatMetric,
} from "@/lib/homepage-field-codec";
import { isSafeInternalRoute } from "@/lib/safe-route";

export const STAT_SECTION_BACKGROUNDS = ["DEFAULT", "SURFACE"] as const;
export const MAX_STAT_CARDS = 12;
export const MAX_STAT_LABEL_LENGTH = 60;
export const MAX_CUSTOM_VALUE_LENGTH = 16;

/**
 * A CUSTOM display value is a short presentation number such as "100+",
 * "1,500+", "2.8K+", "10K+", "25,000" or "5000": a number, an optional
 * K / M / L / Lakh / Cr unit and an optional "+" or "%". Shown exactly as
 * typed (after trimming), never parsed back into real statistics.
 */
const CUSTOM_VALUE_PATTERN = /^\d[\d,]*(\.\d+)?\s?(K|M|L|Lakh|Lakhs|Cr|Crore)?\s?[+%]?$/i;

export function isValidCustomDisplayValue(value: string | undefined): boolean {
  return typeof value === "string" && value.length <= MAX_CUSTOM_VALUE_LENGTH && CUSTOM_VALUE_PATTERN.test(value);
}

/**
 * Plain text only: strips control characters and angle brackets (no markup
 * can survive even if a future renderer stops escaping) and caps length.
 */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned || undefined;
}

function sanitizeMetric(metric: StatMetric): StatMetric {
  const dynamicKey = metric.dynamicKey && Object.hasOwn(STAT_DATA_SOURCE_LABELS, metric.dynamicKey) ? (metric.dynamicKey as StatDynamicKey) : undefined;
  const link = cleanText(metric.link, 300);
  return {
    id: cleanText(metric.id, 64) ?? crypto.randomUUID(),
    label: cleanText(metric.label, MAX_STAT_LABEL_LENGTH) ?? "",
    description: cleanText(metric.description, 160),
    icon: (STAT_ICON_KEYS as readonly string[]).includes(metric.icon ?? "") ? metric.icon : undefined,
    badge: cleanText(metric.badge, 24),
    link: isSafeInternalRoute(link) ? link : undefined,
    enabled: metric.enabled,
    mode: metric.mode,
    dynamicKey,
    demoValue: cleanText(metric.demoValue, 24),
    manualValue: cleanText(metric.manualValue, 24),
    format: metric.format,
    suffix: cleanText(metric.suffix, 6),
  };
}

/**
 * Server-side validation for the STATISTICS section's content before it is
 * written to the draft. Admin input is untrusted: every metric is
 * normalized to the known shape, enums are allow-listed (mode, format,
 * dynamicKey, icon), links must be safe internal routes, and free text is
 * stripped to plain, length-capped strings.
 */
export function sanitizeStatisticsContent(content: Record<string, unknown>): Record<string, unknown> {
  const background = (STAT_SECTION_BACKGROUNDS as readonly unknown[]).includes(content.background) ? content.background : "DEFAULT";
  return {
    ...content,
    heading: cleanText(content.heading, 120) ?? "",
    subheading: cleanText(content.subheading, 240) ?? "",
    background,
    showModeBadge: content.showModeBadge === true,
    hideZeroLive: content.hideZeroLive === true,
    metrics: normalizeStatMetrics(content.metrics).slice(0, MAX_STAT_CARDS).map(sanitizeMetric),
  };
}

/**
 * Rejects sanitized cards an admin could not have meant to publish: a blank
 * public label, or a CUSTOM card without a valid display value. Returns a
 * message for the first problem, or null when every card is valid.
 */
export function validateStatisticsMetrics(metrics: StatMetric[]): string | null {
  for (const [index, metric] of metrics.entries()) {
    const name = metric.label || `Card ${index + 1}`;
    if (!metric.label) return `Card ${index + 1}: enter a public label.`;
    if (metric.mode === "MANUAL" && !isValidCustomDisplayValue(metric.manualValue)) {
      return `${name}: enter a custom display value like 100+, 1,500+, 2.8K+ or 25,000 (max ${MAX_CUSTOM_VALUE_LENGTH} characters), or switch the card to LIVE.`;
    }
  }
  return null;
}
