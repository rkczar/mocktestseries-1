import type { ExtractedQuestion, HindiVersion } from "@/lib/ai-import/types";

/**
 * Bilingual (Hindi + English) question papers — RPSC style: every question is printed twice, Hindi in one column and
 * English in the other, under the same number. The vision reader returns ONE question per number with the English text
 * in stem/options and the Hindi text in `hi` (transcribed, never translated). These checks decide whether the pair is
 * trustworthy; anything uncertain is a blocking issue for an administrator — a pair is never merged or fixed silently.
 * Pure functions (no server imports): used by post-processing and the fixture tests.
 */

/** Extra extraction rules sent after EXTRACT_SYSTEM for a BILINGUAL exam (English-only jobs never see them). */
export const BILINGUAL_RULES = `
BILINGUAL PAPER (this exam prints every question in Hindi AND English):
- Each question number appears twice on the page: the Hindi (Devanagari) version in one column (usually the LEFT) and the English version in the other (usually the RIGHT). The two columns need not line up row by row: match them by the printed question number.
- Return each question number ONCE. Put the ENGLISH version in stem / options / list_i / list_ii exactly as before, and the HINDI version in "hi": {"stem":"...","options":[{"label":"(1)","text":"..."}],"confidence":0.9,"unreadable":[],"same_option_order":true,"figures_differ":false}.
- Transcribe the Hindi exactly as printed in Devanagari, including matras, half letters, conjuncts, nukta, punctuation and any English words or symbols printed inside the Hindi text. NEVER translate the English into Hindi or the Hindi into English, never transliterate, never fill a gap in one language from the other. If a Hindi part is unreadable, keep what is readable, name the doubt in hi.unreadable and lower hi.confidence.
- Hindi options: in printed order with their printed labels. same_option_order: true only if Hindi option (1) is the same option as English option (1), (2) as (2), and so on; false if they differ in order, count or meaning; null if you cannot tell.
- If only one language version of a number is on this page: Hindi missing → "hi": null and say so in "unreadable"; English missing → put the Hindi in "hi", leave "stem" "" and "options" [] and say so in "unreadable".
- Formulas, chemistry and symbols: write them the same way in both versions (same $...$ / \\ce{...} notation).
- Figures, diagrams and tables drawn as images are shared by both versions: report each figure ONCE in "figures". Set hi.figures_differ true if a figure appears in only one language version.
- IGNORE HANDWRITING: ticks, circles, crosses, underlines, scribbles, numbers or notes added by a candidate in pen or pencil are not part of the paper. Never copy them and never treat them as an answer (printed_answer stays [] unless the paper itself PRINTS the answer).`;

/** The vision reader's raw "hi" object (lib/ai-import/prompts.ts pageSchema), labels still as printed. */
export interface RawHindi {
  stem: string;
  options: { label: string | null; text: string }[];
  confidence?: number;
  unreadable: string[];
  same_option_order?: boolean | null;
  figures_differ?: boolean | null;
}

/** Normalizes the raw Hindi reading; options get the canonical labels of the same POSITION in the English options. */
export function toHindi(raw: RawHindi | null | undefined, englishLabels: string[]): HindiVersion | null {
  if (!raw || (!raw.stem?.trim() && !raw.options?.length)) return null;
  return {
    stem: raw.stem.trim(),
    options: raw.options.map((o, k) => ({ label: englishLabels[k] ?? String.fromCharCode(65 + k), printed: o.label ?? String(k + 1), text: o.text.trim() })),
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0.5,
    unreadable: raw.unreadable ?? [],
    sameOptionOrder: raw.same_option_order ?? null,
    figuresDiffer: raw.figures_differ ?? null,
  };
}

const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-z]/g;
const DEV_DIGITS = "०१२३४५६७८९";

/** Share of Devanagari among the letters of a text (0..1; 1 when it has no letters at all, e.g. a pure formula). */
export function devanagariShare(text: string): number {
  const d = text.match(DEVANAGARI)?.length ?? 0;
  const l = text.match(LATIN)?.length ?? 0;
  return d + l === 0 ? 1 : d / (d + l);
}

/** Every number in a text (Devanagari digits read as 0–9, "0.929" kept whole), sorted — compared as a multiset. */
export function numbersIn(text: string): string[] {
  const t = text.replace(/[०-९]/g, (c) => String(DEV_DIGITS.indexOf(c)));
  return (t.match(/\d+(?:\.\d+)?/g) ?? []).sort();
}

/** Character-bigram similarity (Dice, 0..1) of two texts with whitespace removed — for two reads of the same Hindi text. */
export function textSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/\s+/g, "");
    const m = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
    return { m, n: Math.max(0, t.length - 1) };
  };
  const x = grams(a);
  const y = grams(b);
  if (!x.n && !y.n) return 1;
  let common = 0;
  for (const [g, c] of x.m) common += Math.min(c, y.m.get(g) ?? 0);
  return (2 * common) / (x.n + y.n);
}

const hindiText = (h: HindiVersion) => [h.stem, ...h.options.map((o) => o.text)].join("\n");
const englishText = (e: ExtractedQuestion) => [e.stem, ...e.options.map((o) => o.text)].join("\n");

/** Below these the Hindi reading goes to review. */
export const HINDI_MIN_CONFIDENCE = 0.85;
export const HINDI_MIN_DEVANAGARI = 0.35;
export const HINDI_MIN_SECOND_READ = 0.9;

export interface BilingualFinding {
  code: "BILINGUAL_HINDI_MISSING" | "BILINGUAL_MISMATCH" | "BILINGUAL_HINDI_UNCERTAIN";
  detail: string;
}

/**
 * Checks of one question of a bilingual paper. An administrator-confirmed Hindi version is trusted for the reading
 * checks (confidence, script, second read) but never for the structural ones (option count, numbers, missing side).
 */
export function bilingualFindings(e: ExtractedQuestion): BilingualFinding[] {
  const out: BilingualFinding[] = [];
  const h = e.hi ?? null;
  if (!h || !h.stem.trim()) {
    out.push({ code: "BILINGUAL_HINDI_MISSING", detail: "No Hindi version was read for this question. Add the Hindi text from the paper, or check that the number is printed in both columns." });
    return out;
  }
  const mismatch: string[] = [];
  if (!e.stem.trim()) mismatch.push("the English version is missing");
  if (h.options.length !== e.options.length) mismatch.push(`${h.options.length} Hindi option(s) but ${e.options.length} English option(s)`);
  else h.options.forEach((o, k) => {
    if (!o.text.trim() && e.options[k]?.text.trim()) mismatch.push(`Hindi option ${e.options[k].label} is empty`);
  });
  const nh = numbersIn(hindiText(h)).join(" ");
  const ne = numbersIn(englishText(e)).join(" ");
  if (nh !== ne) mismatch.push(`the numbers differ (Hindi: ${nh || "none"}; English: ${ne || "none"})`);
  if (h.sameOptionOrder === false) mismatch.push("the reader reports that the Hindi options are not in the same order / meaning as the English options");
  if (h.figuresDiffer === true) mismatch.push("a figure appears in only one language version");
  if (mismatch.length) out.push({ code: "BILINGUAL_MISMATCH", detail: `Hindi and English versions do not match: ${mismatch.join("; ")}. Compare both columns with the page; the English version is authoritative, the Hindi text is kept as printed.`.slice(0, 600) });
  if (!h.confirmedById) {
    const doubt: string[] = [];
    if (h.confidence < HINDI_MIN_CONFIDENCE) doubt.push(`reader confidence ${Math.round(h.confidence * 100)}%`);
    if (h.unreadable.length) doubt.push(`unreadable: ${h.unreadable.join("; ").slice(0, 160)}`);
    // The question text on its own as well as the whole question: a garbled stem must not hide behind good options.
    const share = Math.min(devanagariShare(h.stem), devanagariShare(hindiText(h)));
    if (share < HINDI_MIN_DEVANAGARI) doubt.push(`only ${Math.round(share * 100)}% of its letters are Devanagari`);
    if (h.sameOptionOrder === null) doubt.push("the option order could not be confirmed");
    if (typeof h.secondReadAgreement === "number" && h.secondReadAgreement < HINDI_MIN_SECOND_READ) doubt.push(`an independent second read agrees only ${Math.round(h.secondReadAgreement * 100)}%`);
    if (doubt.length) out.push({ code: "BILINGUAL_HINDI_UNCERTAIN", detail: `The Hindi reading is uncertain (${doubt.join("; ")}). Check it against the page and save the Hindi text to confirm it.`.slice(0, 600) });
  }
  return out;
}

/** Joins the Hindi parts of a question printed across two pages (same rules as the English join in process.ts). */
export function mergeHindi(a: HindiVersion | null | undefined, b: HindiVersion | null | undefined): HindiVersion | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const tailLost = a.options.length > 0 && !!b.stem.trim();
  const order = a.sameOptionOrder === false || b.sameOptionOrder === false ? false : a.sameOptionOrder === null || b.sameOptionOrder === null ? null : true;
  return {
    ...a,
    stem: a.options.length ? a.stem : `${a.stem}\n${b.stem}`.trim(),
    options: [...a.options, ...b.options].map((o, i) => ({ ...o, label: String.fromCharCode(65 + i) })),
    confidence: tailLost ? Math.min(a.confidence, b.confidence, 0.4) : Math.min(a.confidence, b.confidence),
    unreadable: [...a.unreadable, ...b.unreadable, ...(tailLost ? [`Hindi text on the next page could not be placed: "${b.stem.slice(0, 200)}"`] : [])],
    sameOptionOrder: order,
    figuresDiffer: a.figuresDiffer || b.figuresDiffer ? true : a.figuresDiffer === null && b.figuresDiffer === null ? null : false,
    secondReadAgreement: null,
  };
}

/** Similarity of two Hindi readings of the same question (stem + options). */
export function hindiAgreement(a: HindiVersion | null | undefined, b: HindiVersion | null | undefined): number {
  if (!a || !b) return 0;
  return textSimilarity(hindiText(a), hindiText(b));
}
