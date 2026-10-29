import { checkInvisible, checkStockPhrases, repeatedPhrases, sentences, stripInvisible, wordsOf } from "@/lib/text-lint/common";
import { finding, type LintFinding } from "@/lib/text-lint/types";

/**
 * Instagram caption lint. Limits come from the caller — the publisher's real limits are the source of truth
 * (lib/instagram/publish.ts CAPTION_MAX, the Studio hashtag limit) — so nothing here hard-codes a platform rule.
 */

export interface CaptionLintOptions {
  /** Hard limit the publisher enforces (Instagram: 2,200). */
  captionMax: number;
  /** Configurable hashtag limit (Studio default 15). */
  hashtagLimit: number;
  /** Approximate characters the feed shows before "… more" (Instagram shows about 125; it varies by device). */
  feedPreviewChars?: number;
  /** Domains the caption may mention (the site itself); others are flagged. */
  allowedDomains?: string[];
  /** Below this many characters (hashtags excluded) a caption is "suspiciously short". */
  minChars?: number;
}

export interface CaptionLintResult {
  findings: LintFinding[];
  characters: number;
  /** What the feed shows before "… more" (approximate), and whether the caption is cut there. */
  feedPreview: { text: string; truncated: boolean; approximate: true };
  hashtags: string[];
  asks: string[];
}

export const FEED_PREVIEW_CHARS = 125;
// \p{M}: Devanagari vowel signs and viramas are combining marks (#चिकित्सा must stay whole).
const HASHTAG = /(^|[^\p{L}\p{M}\p{N}_&])#([\p{L}\p{M}\p{N}_]+)/gu;
const BROKEN_HASHTAG = /(^|\s)#(\s|$|[^\p{L}\p{M}\p{N}_#\s])/u;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|in|org|net|io|co|app|ai)(?:\/[^\s]*)?\b/gi;
const MARKDOWN = [
  { re: /\*\*[^*\n]+\*\*|__[^_\n]+__/, what: "**bold**" },
  { re: /(^|\n)#{1,6}\s/, what: "# heading" },
  { re: /\[[^\]\n]+\]\([^)\s]+\)/, what: "[link](url)" },
  { re: /`[^`\n]+`/, what: "`code`" },
];
/** Calls to action: each kind is counted once. */
export const ASKS: { re: RegExp; label: string }[] = [
  { re: /\bcomment\b/i, label: "comment" },
  { re: /\b(save|bookmark) (this|it|for later)\b/i, label: "save" },
  { re: /\b(share|send) (this|it) (with|to)\b/i, label: "share" },
  { re: /\bfollow\b/i, label: "follow" },
  { re: /\blink in (my |our |the )?bio\b/i, label: "link in bio" },
  { re: /\b(dm|message) (me|us)\b/i, label: "DM" },
  { re: /\b(join|subscribe)\b/i, label: "join / subscribe" },
  { re: /\b(practi[cs]e|attempt|take) (the|this|our|a|free)\b[^.\n]{0,40}\b(test|mock|quiz|questions?)\b/i, label: "practice / take a test" },
];

/** Grapheme-safe prefix (keeps emoji and Devanagari clusters whole). */
function prefix(text: string, n: number): string {
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  let out = "";
  let i = 0;
  for (const { segment } of seg.segment(text)) {
    if (i++ >= n) break;
    out += segment;
  }
  return out;
}

function graphemeLength(text: string): number {
  return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)].length;
}

export function feedPreview(text: string, chars = FEED_PREVIEW_CHARS): CaptionLintResult["feedPreview"] {
  const t = text.trim();
  // The feed shows at most the first two lines.
  const lines = t.split("\n");
  const twoLines = lines.slice(0, 2).join("\n");
  const cut = prefix(twoLines, chars);
  const truncated = cut.length < t.length;
  return { text: cut, truncated, approximate: true };
}

export function hashtagsOf(text: string): string[] {
  return [...text.matchAll(HASHTAG)].map((m) => `#${m[2]}`);
}

export function lintCaption(raw: string, opts: CaptionLintOptions): CaptionLintResult {
  const findings: LintFinding[] = [];
  const text = raw ?? "";
  const chars = graphemeLength(text);
  const tags = hashtagsOf(text);
  const body = text.replace(HASHTAG, "$1").trim();
  const preview = feedPreview(text, opts.feedPreviewChars ?? FEED_PREVIEW_CHARS);

  // Length and emptiness.
  if (!text.trim()) findings.push(finding("CAPTION_EMPTY", "error", "The caption is empty."));
  else if (graphemeLength(body) < (opts.minChars ?? 40)) findings.push(finding("CAPTION_SHORT", "warning", `The caption has only ${graphemeLength(body)} characters besides hashtags — readers get no context.`, { suggestion: "Add one or two sentences that say what the post teaches." }));
  if (chars > opts.captionMax) findings.push(finding("CAPTION_TOO_LONG", "error", `${chars} characters — Instagram allows ${opts.captionMax}.`, { suggestion: `Cut ${chars - opts.captionMax} characters.` }));

  // The first visible line.
  const first = text.trim().split("\n")[0] ?? "";
  if (first.trim().startsWith("#")) findings.push(finding("CAPTION_STARTS_WITH_HASHTAG", "warning", "The caption starts with a hashtag — the feed preview shows tags instead of the point.", { suggestion: "Start with the claim or the question; put hashtags at the end." }));
  if (preview.truncated && graphemeLength(first) > (opts.feedPreviewChars ?? FEED_PREVIEW_CHARS)) {
    findings.push(finding("FEED_PREVIEW_CUT", "info", `The first line is ${graphemeLength(first)} characters; the feed shows about ${opts.feedPreviewChars ?? FEED_PREVIEW_CHARS} before "… more", so it is cut mid-sentence.`, { suggestion: "Make the first line a complete thought under ~125 characters.", excerpt: preview.text }));
  }

  // Hashtags.
  if (tags.length > opts.hashtagLimit) findings.push(finding("HASHTAGS_OVER_LIMIT", "error", `${tags.length} hashtags — the limit is ${opts.hashtagLimit}.`, { suggestion: `Remove ${tags.length - opts.hashtagLimit}; keep the most specific ones.` }));
  const lower = tags.map((t) => t.toLowerCase());
  const dups = [...new Set(lower.filter((t, i) => lower.indexOf(t) !== i))];
  if (dups.length) findings.push(finding("HASHTAG_DUPLICATE", "warning", `Repeated hashtag(s): ${dups.join(" ")}.`, { suggestion: "Keep each hashtag once.", excerpt: dups.join(" ") }));
  if (BROKEN_HASHTAG.test(text)) findings.push(finding("HASHTAG_FORMAT", "warning", 'A "#" is followed by a space or punctuation, so it is not a hashtag.', { suggestion: "Write hashtags as one word: #MedicalOfficer." }));
  const long = tags.filter((t) => t.length > 31);
  if (long.length) findings.push(finding("HASHTAG_TOO_LONG", "info", `Very long hashtag(s): ${long.join(" ")} — hard to read and rarely searched.`, { excerpt: long.join(" ") }));

  // Links (captions are not clickable).
  const allowed = (opts.allowedDomains ?? []).map((d) => d.toLowerCase().replace(/^www\./, ""));
  const urls = [...text.matchAll(URL_RE)].map((m) => m[0]);
  const foreign = urls.filter((u) => !allowed.some((d) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").startsWith(d)));
  if (urls.length) {
    findings.push(
      finding(foreign.length ? "CAPTION_LINK_FOREIGN" : "CAPTION_LINK", foreign.length ? "warning" : "info", foreign.length ? `Link to another site: ${foreign.join(" ")}. Caption links are not clickable, and only our own site should be named.` : "Caption links are not clickable on Instagram.", { suggestion: "Point to the link in bio, or write the site name without https://.", excerpt: urls.join(" ") })
    );
  }

  // Calls to action.
  const asks = ASKS.filter((a) => a.re.test(body)).map((a) => a.label);
  if (asks.length > 2) findings.push(finding("CAPTION_MANY_ASKS", "warning", `${asks.length} different asks (${asks.join(", ")}) — several asks are weaker than one.`, { suggestion: "Keep the one that matters most for this post." }));

  // Formatting Instagram does not render.
  for (const m of MARKDOWN) if (m.re.test(text)) findings.push(finding("CAPTION_MARKDOWN", "warning", `Instagram shows ${m.what} formatting as plain symbols.`, { suggestion: "Remove the formatting characters." }));

  // Invisible characters, stock phrasing, repetition, readability.
  findings.push(...checkInvisible(text));
  findings.push(...checkStockPhrases(body));
  const reps = repeatedPhrases(body);
  if (reps.length) findings.push(finding("REPEATED_PHRASE", "info", `Repeated wording: "${reps.join('", "')}".`, { suggestion: "Say it once." }));
  const longSentences = sentences(body).filter((s) => wordsOf(s).length > 30);
  if (longSentences.length) findings.push(finding("LONG_SENTENCE", "info", `${longSentences.length} sentence(s) over 30 words — hard to read on a phone.`, { suggestion: "Split them.", excerpt: longSentences[0].slice(0, 80) }));

  return { findings, characters: chars, feedPreview: preview, hashtags: tags, asks };
}

/** The caption with invisible characters removed (offered as a fix, never applied silently). */
export function cleanCaption(text: string): string {
  return stripInvisible(text);
}
