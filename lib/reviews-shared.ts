/**
 * Student Reviews / Testimonials — shared, client-safe pieces: the homepage
 * section settings shape and its normalization, input limits and the text
 * sanitizer used by every write path (admin and student). Server-only data
 * access lives in lib/reviews.ts.
 */

export const REVIEWS_SECTION_SETTING_KEY = "website.reviews_section";

export const REVIEW_SPEEDS = ["SLOW", "NORMAL", "FAST"] as const;
export type ReviewSpeed = (typeof REVIEW_SPEEDS)[number];
export const REVIEW_DIRECTIONS = ["RTL", "LTR"] as const;
export type ReviewDirection = (typeof REVIEW_DIRECTIONS)[number];

/** Marquee speed in CSS pixels per second. */
export const REVIEW_SPEED_PX: Record<ReviewSpeed, number> = { SLOW: 22, NORMAL: 36, FAST: 56 };

export const REVIEW_LIMITS = {
  nameMax: 60,
  examMax: 80,
  commentMin: 20,
  commentMax: 600,
  maxShownMin: 1,
  maxShownMax: 30,
  headingMax: 80,
  subtitleMax: 200,
} as const;

export interface ReviewsSectionSettings {
  enabled: boolean;
  heading: string;
  subtitle: string;
  maxReviews: number;
  autoScroll: boolean;
  speed: ReviewSpeed;
  direction: ReviewDirection;
  showRating: boolean;
  showExam: boolean;
  showVerified: boolean;
  preferFeatured: boolean;
}

export const DEFAULT_REVIEWS_SECTION_SETTINGS: ReviewsSectionSettings = {
  enabled: true,
  heading: "What Students Say",
  subtitle: "",
  maxReviews: 12,
  autoScroll: true,
  speed: "NORMAL",
  direction: "RTL",
  showRating: true,
  showExam: true,
  showVerified: true,
  preferFeatured: true,
};

/** Any stored value -> a complete, valid settings object (unknown/invalid fields fall back to defaults). */
export function normalizeReviewsSectionSettings(raw: unknown): ReviewsSectionSettings {
  const d = DEFAULT_REVIEWS_SECTION_SETTINGS;
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bool = (k: keyof ReviewsSectionSettings) => (typeof r[k] === "boolean" ? (r[k] as boolean) : (d[k] as boolean));
  const max = Number(r.maxReviews);
  return {
    enabled: bool("enabled"),
    heading: typeof r.heading === "string" && r.heading.trim() ? cleanReviewText(r.heading, REVIEW_LIMITS.headingMax) : d.heading,
    subtitle: typeof r.subtitle === "string" ? cleanReviewText(r.subtitle, REVIEW_LIMITS.subtitleMax) : d.subtitle,
    maxReviews: Number.isInteger(max) && max >= REVIEW_LIMITS.maxShownMin && max <= REVIEW_LIMITS.maxShownMax ? max : d.maxReviews,
    autoScroll: bool("autoScroll"),
    speed: REVIEW_SPEEDS.includes(r.speed as ReviewSpeed) ? (r.speed as ReviewSpeed) : d.speed,
    direction: REVIEW_DIRECTIONS.includes(r.direction as ReviewDirection) ? (r.direction as ReviewDirection) : d.direction,
    showRating: bool("showRating"),
    showExam: bool("showExam"),
    showVerified: bool("showVerified"),
    preferFeatured: bool("preferFeatured"),
  };
}

/**
 * Plain-text sanitizer for review fields. Output is always rendered as React
 * text (escaped), so this is defence in depth: drops script/style blocks,
 * strips HTML tags, control and
 * zero-width/bidi-override characters, collapses runs of spaces and blank
 * lines, trims, and caps the length.
 */
export function cleanReviewText(input: string, maxLength: number, { multiline = false } = {}): string {
  let s = input
    .normalize("NFC")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n");
  s = multiline
    ? s.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n")
    : s.replace(/\s+/g, " ");
  return s.trim().slice(0, maxLength).trim();
}

/** Links/handles in a student comment are treated as spam. */
export function looksLikeSpam(comment: string): boolean {
  return /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|xyz|ly|me)\b|@[a-z0-9_]{3,}|(\d[\s-]?){10,})/i.test(comment);
}

/**
 * The public name for a student review: first name + last initial
 * ("Priya Sharma" -> "Priya S."). Never the email, phone or student code.
 */
export function publicStudentName(fullName: string | null | undefined): string {
  const parts = cleanReviewText(fullName ?? "", 120).split(" ").filter(Boolean);
  if (parts.length === 0) return "Student";
  const first = parts[0].slice(0, 30);
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

/** The only shape the public homepage ever receives — no ids, emails, phones or student codes. */
export interface PublicReview {
  key: string;
  name: string;
  rating: number;
  comment: string;
  exam: string | null;
  verified: boolean;
}
