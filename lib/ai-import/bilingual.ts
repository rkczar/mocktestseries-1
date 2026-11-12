import type { ExtractedQuestion, HindiVersion } from "@/lib/ai-import/types";
import { formulaPlain, isNonLinguistic, scriptCounts } from "@/lib/ai-import/script-text";

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
- Hindi options: in printed order with their printed labels. same_option_order: true only if Hindi option (1) is the same option as English option (1), (2) as (2), and so on; false if they differ in order, count or meaning; leave it out if you cannot tell.
- If only one language version of a number is on this page: Hindi missing → leave "hi" out and say so in "unreadable"; English missing → put the Hindi in "hi", leave "stem" "" and "options" [] and say so in "unreadable".
- Formulas, chemistry and symbols: write them the same way in both versions (same $...$ / \\ce{...} notation); never translate or re-type symbols, and never put Devanagari inside $...$.
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

// A translation may spell a small number out ("The 3 new reserves" / "तीन नए रिज़र्व", FSO 2022 Q20). A number word only
// ever explains a digit missing on the other side — it never creates a mismatch ("दो" is also a verb).
const NUMBER_WORDS: Record<string, string> = {
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  // Not एक ("a") or दो ("give") or "one": everyday words that would explain away a genuinely missing 1 or 2.
  तीन: "3", चार: "4", पाँच: "5", पांच: "5", छह: "6", "छः": "6", छ: "6", सात: "7", आठ: "8", नौ: "9", दस: "10",
  // Ordinals ("1st" / "पहला", FSO 2019 Q44).
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5",
  पहला: "1", पहली: "1", पहले: "1", प्रथम: "1", दूसरा: "2", दूसरी: "2", दूसरे: "2", द्वितीय: "2", तीसरा: "3", तीसरी: "3", तीसरे: "3", तृतीय: "3",
  चौथा: "4", चौथी: "4", चौथे: "4", चतुर्थ: "4", पाँचवाँ: "5", पांचवां: "5", पाँचवीं: "5", पांचवीं: "5", पंचम: "5",
};
const wordNumbers = (text: string) => new Set(text.toLowerCase().split(/[\s,.;:!?()[\]{}"'“”‘’–—\-/|।]+/).map((w) => NUMBER_WORDS[w]).filter(Boolean));
// Line-start enumerators ("35. …" — the question's own number — or "1. / (2) / 3)" statement labels) are layout, not
// content: one column printing them and the other not is not a translation difference (FSO 2019 Q35, Q44).
const stripEnumerators = (text: string) => text.replace(/^[ \t]*[([]?[0-9०-९]{1,3}[.)\]][ \t]+/gm, "");

/**
 * The numbers of the two versions differ in a way a translation cannot explain; null = they agree. Compared as sets:
 * a value printed twice in one column (a repeated year in List I and in the options, FSO 2022 Q61/Q132) is not a
 * different number. A digit is matched by the same value spelled out on the other side.
 */
export function numberMismatch(hiText: string, enText: string): string | null {
  const nh = new Set(numbersIn(stripEnumerators(hiText)));
  const ne = new Set(numbersIn(stripEnumerators(enText)));
  const onlyEn = [...ne].filter((n) => !nh.has(n) && !wordNumbers(hiText).has(n));
  const onlyHi = [...nh].filter((n) => !ne.has(n) && !wordNumbers(enText).has(n));
  if (!onlyEn.length && !onlyHi.length) return null;
  return `the numbers differ (only in Hindi: ${onlyHi.join(" ") || "none"}; only in English: ${onlyEn.join(" ") || "none"})`;
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
// The English side of the numbers check includes what the Hindi side prints inside its question text: Match-the-Following
// lists (List I / List II keys and entries) and a passage — the Hindi version has no separate list fields.
const englishText = (e: ExtractedQuestion) => [e.passage ?? "", e.stem, ...(e.listI ?? []).map((x) => `${x.key} ${x.text}`), ...(e.listII ?? []).map((x) => `${x.key} ${x.text}`), ...e.options.map((o) => o.text)].join("\n");

/** Below these the Hindi reading goes to review. */
export const HINDI_MIN_CONFIDENCE = 0.85;
export const HINDI_MIN_DEVANAGARI = 0.35;
export const HINDI_MIN_SECOND_READ = 0.9;

export interface BilingualFinding {
  code: "BILINGUAL_HINDI_MISSING" | "BILINGUAL_MISMATCH" | "BILINGUAL_HINDI_UNCERTAIN";
  detail: string;
}

/** Per-field language result (shown on the question page; only OCR_UNCERTAIN / SOURCE_UNAVAILABLE ask for review). */
export type LanguageOutcome = "HINDI_VERIFIED" | "ENGLISH_VERIFIED" | "MIXED_VERIFIED" | "NON_LINGUISTIC" | "OCR_UNCERTAIN" | "SOURCE_UNAVAILABLE";
export interface LanguageFieldCheck {
  field: string;
  outcome: LanguageOutcome;
  detail: string;
}
export const LANGUAGE_OUTCOME_LABELS: Record<LanguageOutcome, string> = {
  HINDI_VERIFIED: "Hindi text verified",
  ENGLISH_VERIFIED: "English text verified",
  MIXED_VERIFIED: "Mixed Hindi–English text verified",
  NON_LINGUISTIC: "Non-linguistic content verified",
  OCR_UNCERTAIN: "OCR uncertainty — manual review required",
  SOURCE_UNAVAILABLE: "Source text unavailable",
};

const withoutMath = (t: string) => t.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, " ").replace(/\\[A-Za-z]+(\{[^{}]*\})?/g, " ");
const near = (t: string, i: number) => `“${t.slice(Math.max(0, i - 12), i + 14).trim()}”`;

/** Free local signs of a damaged Devanagari reading in one field (quoted, so the administrator can find the word). */
export function devanagariProblems(text: string): string[] {
  const t = withoutMath(text);
  if (!/[\u0900-\u097F]/.test(t)) return [];
  const out: string[] = [];
  let m = /(?:^|[\s(\[“"'‘,])([\u0900-\u0903\u093A-\u094D\u0951-\u0957\u0962\u0963])/.exec(t);
  if (m) out.push(`a vowel sign / mark without its letter near ${near(t, m.index + m[0].length - 1)}`);
  m = /[\u093E-\u094C]{2,}/.exec(t);
  if (m) out.push(`two vowel signs in a row near ${near(t, m.index)}`);
  m = /[\u0900-\u097F][A-Za-z]|[A-Za-z][\u0900-\u097F]/.exec(t);
  if (m) out.push(`Latin letters joined to a Hindi word near ${near(t, m.index)}`);
  m = /\uFFFD/.exec(t);
  if (m) out.push(`an unreadable character near ${near(t, m.index)}`);
  // Duplicated text: a repeated two-word PHRASE (single words repeat on purpose in Hindi: "कौन कौन", "धीरे धीरे").
  m = /(^|\s)([\u0900-\u097F]+\s+[\u0900-\u097F]+)\s+\2(?=$|[\s।?,.])/.exec(t);
  if (m) out.push(`the words “${m[2]}” are repeated`);
  return out;
}

const norm = (t: string) => formulaPlain(t).toLowerCase().replace(/[^a-z0-9\u0900-\u097F]+/g, "");

/**
 * Language check of ONE field of the Hindi version against its English counterpart. A field without words (formula,
 * number, symbol, structure) is fine; English technical words are fine when the English version prints the same words.
 */
function fieldCheck(field: string, hiText: string, enText: string, imageOwned: boolean): LanguageFieldCheck {
  const c = scriptCounts(hiText);
  const problems = devanagariProblems(hiText);
  if (problems.length) return { field, outcome: "OCR_UNCERTAIN", detail: `possible OCR error — ${problems.join("; ")}` };
  if (c.dev + c.latin === 0) {
    if (!hiText.trim() && !imageOwned) return enText.trim() ? { field, outcome: "OCR_UNCERTAIN", detail: "empty, although the English version has text" } : { field, outcome: "NON_LINGUISTIC", detail: "empty in both versions" };
    if (!hiText.trim() || imageOwned) return { field, outcome: "NON_LINGUISTIC", detail: "image (structure / diagram) — no text expected" };
    const en = scriptCounts(enText);
    if (en.latin >= 8 && en.latinWords.length >= 3) return { field, outcome: "OCR_UNCERTAIN", detail: `no words were read, although the English version has words (“${enText.slice(0, 60)}”)` };
    return { field, outcome: "NON_LINGUISTIC", detail: "formula / number / symbol" };
  }
  const share = c.dev / (c.dev + c.latin);
  const enLower = enText.toLowerCase();
  if (share >= HINDI_MIN_DEVANAGARI) return c.latin ? { field, outcome: "MIXED_VERIFIED", detail: `Hindi with English term(s): ${c.latinWords.slice(0, 5).join(", ")}` } : { field, outcome: "HINDI_VERIFIED", detail: "Devanagari text" };
  if (!c.dev && norm(hiText) && norm(hiText) === norm(enText)) return { field, outcome: "ENGLISH_VERIFIED", detail: "printed in English in both versions (technical terms)" };
  if (c.dev && c.latinWords.every((w) => enLower.includes(w.toLowerCase()))) return { field, outcome: "MIXED_VERIFIED", detail: `English technical term(s) as in the English version: ${c.latinWords.slice(0, 5).join(", ")}` };
  return { field, outcome: "OCR_UNCERTAIN", detail: `only ${Math.round(share * 100)}% of its words are Devanagari and they differ from the English version (“${hiText.slice(0, 60)}”)` };
}

/**
 * Field-by-field language result of a bilingual question: the Hindi question text, each Hindi option and (when present)
 * the explanation are checked on their own — a chemical structure in the options never counts against a Hindi stem.
 * `imageOptions` = labels of options that carry an image (structure / diagram).
 */
export function hindiFieldChecks(e: ExtractedQuestion, imageOptions?: Set<string>): LanguageFieldCheck[] {
  const h = e.hi ?? null;
  const imgs = imageOptions ?? new Set((e.figures ?? []).filter((f) => f.owner === "OPTION" && f.optionLabel).map((f) => f.optionLabel!));
  const out: LanguageFieldCheck[] = [];
  if (!h || !h.stem.trim()) out.push({ field: "Hindi question text", outcome: "SOURCE_UNAVAILABLE", detail: "no Hindi version was read" });
  else {
    out.push(fieldCheck("Hindi question text", h.stem, englishText({ ...e, options: [] }), false));
    h.options.forEach((o, k) => {
      const label = e.options[k]?.label ?? o.label;
      out.push(fieldCheck(`Hindi option ${label}`, o.text, e.options[k]?.text ?? "", imgs.has(label) && isNonLinguistic(o.text)));
    });
    // A "Hindi" version with no Devanagari anywhere is an English copy, not a reading of the Hindi column.
    const all = scriptCounts(hindiText(h));
    if (!all.dev && all.latin && scriptCounts(englishText(e)).latin) {
      out[0] = { field: "Hindi question text", outcome: "OCR_UNCERTAIN", detail: "the Hindi version has no Devanagari at all — the Hindi column may not have been read" };
    }
  }
  const ex = e.hints?.explanation?.trim();
  if (ex) out.push({ field: "Explanation", outcome: isNonLinguistic(ex) ? "NON_LINGUISTIC" : scriptCounts(ex).dev ? "MIXED_VERIFIED" : "ENGLISH_VERIFIED", detail: "kept in the language it was printed in (no separate Hindi explanation)" });
  return out;
}

/** A reader note that says the text is fine after all ("slight smudge, text remains clear") is not a doubt. */
const BENIGN_NOTE = /\b(remains?|is|still|fully|clearly|perfectly)\s+(clear|legible|readable)\b|does not affect|no effect on (the )?(text|reading)/i;
function noteField(note: string): string {
  const m = /option\s*\(?\s*([1-4A-D])\s*\)?|\(([1-4])\)/i.exec(note);
  const k = m ? (m[1] ?? m[2]).toUpperCase() : null;
  return k ? `Hindi option ${/\d/.test(k) ? String.fromCharCode(64 + Number(k)) : k}` : "Hindi text";
}

/**
 * Checks of one question of a bilingual paper. An administrator-confirmed Hindi version is trusted for the reading
 * checks (confidence, script, second read) but never for the structural ones (option count, numbers, missing side).
 * Every doubt names its field ("Hindi option C: …"); content that is legitimately not Hindi (formulas, structures,
 * numbers, English technical terms printed the same in both versions) is not a doubt.
 */
export function bilingualFindings(e: ExtractedQuestion, imageOptions?: Set<string>): BilingualFinding[] {
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
    const label = e.options[k]?.label;
    const img = (imageOptions ?? new Set((e.figures ?? []).filter((f) => f.owner === "OPTION").map((f) => f.optionLabel))).has(label);
    if (!o.text.trim() && e.options[k]?.text.trim() && !img) mismatch.push(`Hindi option ${label} is empty`);
  });
  const numbers = numberMismatch(hindiText(h), englishText(e));
  if (numbers) mismatch.push(numbers);
  if (h.sameOptionOrder === false) mismatch.push("the reader reports that the Hindi options are not in the same order / meaning as the English options");
  if (h.figuresDiffer === true) mismatch.push("a figure appears in only one language version");
  if (mismatch.length) out.push({ code: "BILINGUAL_MISMATCH", detail: `Hindi and English versions do not match: ${mismatch.join("; ")}. Compare both columns with the page; the English version is authoritative, the Hindi text is kept as printed.`.slice(0, 600) });
  if (!h.confirmedById) {
    const doubt: string[] = [];
    if (h.confidence < HINDI_MIN_CONFIDENCE) doubt.push(`reader confidence ${Math.round(h.confidence * 100)}%`);
    for (const n of h.unreadable) if (!BENIGN_NOTE.test(n)) doubt.push(`${noteField(n)}: the reader could not read “${n.slice(0, 120)}”`);
    for (const f of hindiFieldChecks(e, imageOptions)) if (f.outcome === "OCR_UNCERTAIN") doubt.push(`${f.field}: ${f.detail}`);
    if (h.sameOptionOrder === null) doubt.push("the option order could not be confirmed");
    if (typeof h.secondReadAgreement === "number" && h.secondReadAgreement < HINDI_MIN_SECOND_READ) doubt.push(`an independent second read agrees only ${Math.round(h.secondReadAgreement * 100)}%`);
    if (doubt.length) out.push({ code: "BILINGUAL_HINDI_UNCERTAIN", detail: `Hindi needs review — ${doubt.join("; ")}. Compare with the page and save the Hindi text to confirm it.`.slice(0, 600) });
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
