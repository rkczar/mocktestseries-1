/**
 * Pure template helpers for the Question WhatsApp Share feature (Section 16)
 * — no Prisma/server-only imports, so both the server-side share-text
 * builder (lib/whatsapp-share-config.ts) and the Admin settings form's
 * client-side live preview can use the exact same substitution logic.
 *
 * This module is the single authority for the question share message:
 * buildQuestionShareText() is what the student Review page calls, and it only
 * ever reads student-facing fields (question text, option label/text, image
 * presence) — never the correct label, explanations, the student's answer,
 * marks or any id.
 */

export const WHATSAPP_SHARE_PLACEHOLDERS = ["heading", "exam", "subject", "question", "options", "website_url"] as const;

/** Canonical public origin used in share messages — never localhost/NEXTAUTH_URL. */
export const SHARE_SITE_URL = "https://mocktestseries.in";

export const DEFAULT_WHATSAPP_SHARE_TEMPLATE = [
  "{{heading}}",
  "",
  "Think you know the answer? Try this 👇",
  "{{website_url}}",
  "",
  "*Question:*",
  "{{question}}",
  "",
  "{{options}}",
  "",
  "Practice more questions & mock tests:",
  "{{website_url}}",
  "",
  "_Mock Test Series_",
].join("\n");

/**
 * The original default (question only). A stored template that is still this
 * untouched default is upgraded to the current default at read time, so the
 * new format reaches students without a data migration while any genuinely
 * customised admin template is left as the admin wrote it.
 */
export const LEGACY_DEFAULT_WHATSAPP_SHARE_TEMPLATE =
  "Check out this question from MockTestSeries.in\n\n{{question}}\n\n{{exam}} · {{subject}}\n\n{{website_url}}";

export function resolveWhatsAppShareTemplate(stored: string | null | undefined): string {
  const normalized = (stored ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized || normalized === LEGACY_DEFAULT_WHATSAPP_SHARE_TEMPLATE) return DEFAULT_WHATSAPP_SHARE_TEMPLATE;
  return normalized;
}

export interface WhatsAppShareValues {
  exam: string;
  subject: string;
  question: string;
  website_url: string;
  heading?: string;
  options?: string;
}

/**
 * Fills `{{placeholder}}` tokens with plain-text values only — never HTML,
 * never a raw student/attempt identifier. Unknown placeholders are left
 * untouched rather than silently dropped, so a typo in the admin template is
 * visible instead of quietly losing text. A template without `{{options}}`
 * still shares the options, directly below the question. Substitution is a
 * single pass over the template, so `{{…}}` inside a question is never
 * re-expanded.
 */
export function renderWhatsAppShareText(template: string, values: WhatsAppShareValues): string {
  const all: Record<string, string> = { heading: "", options: "", ...values };
  let source = template.replace(/\r\n?/g, "\n");
  if (all.options && !/\{\{\s*options\s*\}\}/.test(source)) {
    source = source.replace(/\{\{\s*question\s*\}\}/, "{{question}}\n\n{{options}}");
  }
  return source.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (key in all ? all[key] : match));
}

// ---------------------------------------------------------------------------
// Exam-aware heading
// ---------------------------------------------------------------------------

const ACRONYMS = new Set(["NEET", "UG", "PG", "RUHS", "RPSC", "UPSC", "AIIMS", "INICET", "FMGE", "NEXT", "MO", "MBBS", "JIPMER", "ESIC", "CHO", "PSC", "SSC"]);

/** "RUHS MEDICAL OFFICER EXAM 2026" → "RUHS Medical Officer"; "Neet UG" → "NEET UG". */
export function examDisplayName(name: string | null | undefined): string {
  let s = (name ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/\s+(19|20)\d{2}$/, "").replace(/\s+exam(ination)?$/i, "").trim();
  return s
    .split(" ")
    .map((word) => {
      const core = word.replace(/[^A-Za-z]/g, "");
      if (core && ACRONYMS.has(core.toUpperCase())) return word.toUpperCase();
      if (core.length > 1 && core === core.toUpperCase()) return word.toLowerCase().replace(/[a-z]/, (c) => c.toUpperCase());
      return word;
    })
    .join(" ");
}

export function examShareHeading(name: string | null | undefined): string {
  const display = examDisplayName(name);
  if (!display) return "📝 *Medical Exam Question*";
  const emoji = /medical officer/i.test(display) ? "🩺" : "📝";
  return `${emoji} *${display} Question*`;
}

// ---------------------------------------------------------------------------
// HTML / editor markup → WhatsApp plain text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  deg: "°", micro: "µ", plusmn: "±", times: "×", divide: "÷", le: "≤", ge: "≥", ne: "≠", asymp: "≈",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", mu: "μ", pi: "π", sigma: "σ", lambda: "λ", omega: "ω", Omega: "Ω",
  ndash: "–", mdash: "—", hellip: "…", rarr: "→", larr: "←", harr: "↔", uarr: "↑", darr: "↓",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", bull: "•", sup2: "²", sup3: "³", frac12: "½", frac14: "¼", frac34: "¾",
};

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ",
};
const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
};

function decodeEntities(s: string): string {
  // Single pass, so "&amp;lt;" becomes "&lt;" (not "<") — no double decoding.
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function mapScript(inner: string, table: Record<string, string>, fallbackPrefix: string): string {
  const text = inner.trim();
  const chars = [...text];
  if (chars.length > 0 && chars.every((c) => c in table)) return chars.map((c) => table[c]).join("");
  return chars.length === 1 ? `${fallbackPrefix}${text}` : `${fallbackPrefix}(${text})`;
}

const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i;

/**
 * Converts stored question/option text into WhatsApp-ready plain text. Text
 * without HTML markup is kept exactly as stored (only line endings are
 * normalised), so plain content like "a < b & c" is never altered.
 */
export function toShareText(raw: string | null | undefined): string {
  let s = (raw ?? "").replace(/\r\n?/g, "\n");
  if (HTML_TAG.test(s)) {
    s = s
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/\n/g, " ")
      .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, (_, inner: string) => mapScript(decodeEntities(inner.replace(/<[^>]+>/g, "")), SUPERSCRIPT, "^"))
      .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, (_, inner: string) => mapScript(decodeEntities(inner.replace(/<[^>]+>/g, "")), SUBSCRIPT, "_"))
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<img\b[^>]*>/gi, " [image] ")
      .replace(/<\/(p|div|h[1-6]|li|tr|ul|ol|table|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "");
    s = decodeEntities(s)
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/ *\n */g, "\n");
  }
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Authoritative question share message
// ---------------------------------------------------------------------------

/** Only the student-facing fields a share message may use — no answer key. */
export interface ShareableQuestion {
  text: string;
  imageUrl?: string | null;
  options: { label: string; text: string; imageUrl?: string | null }[];
  /** NEET Phase 4: absent / SINGLE_CORRECT shares exactly as before. */
  questionType?: string | null;
  /** MATCH_THE_FOLLOWING only: List I / List II (presentation, never the answer). */
  matchLists?: { listI: { key: string; text: string }[]; listII: { key: string; text: string }[] } | null;
}

export const MULTIPLE_CORRECT_SHARE_NOTE = "(More than one option may be correct.)";

function shareMatchLists(lists: NonNullable<ShareableQuestion["matchLists"]>): string {
  const block = (title: string, entries: { key: string; text: string }[]) =>
    [`*${title}*`, ...entries.map((e) => `${e.key}. ${toShareText(e.text) || "(image)"}`)].join("\n");
  return `${block("List I", lists.listI)}\n\n${block("List II", lists.listII)}`;
}

export const IMAGE_QUESTION_NOTE = "🖼️ This question has an image — view it on the website.";

export function formatShareOptions(options: ShareableQuestion["options"]): string {
  return options
    .map((o) => {
      const text = toShareText(o.text) || (o.imageUrl ? "(image)" : "");
      return `*${o.label.trim()}.* ${text}`.trimEnd();
    })
    .join("\n");
}

export function buildQuestionShareText(params: {
  template: string;
  examName: string | null | undefined;
  subjectName?: string | null;
  question: ShareableQuestion;
  siteUrl?: string;
}): string {
  const { question } = params;
  // Pick fields explicitly so nothing else on the caller's object (e.g. a
  // snapshot's correctLabel) can ever reach the message.
  let questionText = toShareText(question.text);
  if (question.imageUrl) questionText = questionText ? `${questionText}\n\n${IMAGE_QUESTION_NOTE}` : IMAGE_QUESTION_NOTE;
  // Advanced types (NEET Phase 4) add context only — never the answer.
  if (question.questionType === "MATCH_THE_FOLLOWING" && question.matchLists) {
    questionText = `${questionText}\n\n${shareMatchLists(question.matchLists)}`;
  }
  if (question.questionType === "MULTIPLE_CORRECT") questionText = `${questionText}\n\n${MULTIPLE_CORRECT_SHARE_NOTE}`;
  const options = formatShareOptions(question.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })));
  return renderWhatsAppShareText(resolveWhatsAppShareTemplate(params.template), {
    heading: examShareHeading(params.examName),
    exam: examDisplayName(params.examName),
    subject: (params.subjectName ?? "").trim(),
    question: questionText,
    options,
    website_url: params.siteUrl ?? SHARE_SITE_URL,
  });
}

/** Standard wa.me deep link; the text is encoded exactly once. */
export function whatsAppShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}
