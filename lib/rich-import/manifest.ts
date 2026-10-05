import katex from "katex";
import "katex/contrib/mhchem";
import { KATEX_OPTIONS, parseRich } from "@/lib/rich-content";
import type { BulkImportRow } from "@/lib/bulk-import";

/**
 * The normalized, typed import manifest (NEET Phase 3).
 *
 *   XLSX + ZIP → staged BulkImportRow (rawData + admin edits)
 *             → toManifestQuestion()  ← this file, pure, no DB, no I/O
 *             → validation (lib/rich-import/validate.ts)
 *             → preview → commit (lib/bulk-import-execute.ts)
 *
 * The manifest is derived deterministically from the staged row every time
 * it is needed (validate, preview, commit), so an inline edit can never leave
 * a stale normalized copy behind. Author text is carried VERBATIM: formulas
 * are neither rewritten nor rendered here — rendering happens at display time
 * through lib/rich-content.ts, exactly like a manually authored question.
 */

export type ManifestContentFormat = "PLAIN" | "RICH_V1";
export type ManifestQuestionType = "SINGLE_CORRECT" | "MULTIPLE_CORRECT" | "MATCH_THE_FOLLOWING";
export type ManifestImageRole = "QUESTION" | "OPTION" | "EXPLANATION";

export const OPTION_LABELS = ["A", "B", "C", "D"] as const;
export type OptionLabel = (typeof OPTION_LABELS)[number];

/** One image reference from a cell, e.g. `NEET-001-Q1.png :: Circuit with two resistors`. */
export interface ManifestImageRef {
  /** The logical file name from the spreadsheet (matched against bundle basenames). Never a storage key. */
  filename: string;
  role: ManifestImageRole;
  optionLabel: OptionLabel | null;
  order: number;
  /** Author alt text; null when the author gave none (a generic description is used, with a warning). */
  alt: string | null;
  decorative: boolean;
  /** Source column, for error messages. */
  field: string;
  /** Match the Following list image: caption such as "List I (A)". */
  caption: string | null;
}

export interface ManifestMatchEntry {
  key: string;
  text: string;
  images: ManifestImageRef[];
}

export interface ManifestQuestion {
  rowNumber: number;
  /** Author's stable code from the file (Code column); the DB code is still allocated canonically. */
  sourceCode: string | null;
  questionNumber: string | null;
  exam: string;
  year: string;
  paperCode: string | null;
  taxonomy: { subject: string; topic: string; subTopic: string };
  questionType: ManifestQuestionType | null;
  contentFormat: ManifestContentFormat | null;
  text: string;
  options: { label: OptionLabel; text: string; images: ManifestImageRef[] }[];
  /**
   * Correct option labels. An ARRAY on purpose: MULTIPLE_CORRECT is parsed and
   * represented already, even though only SINGLE_CORRECT may be imported today.
   */
  correct: string[];
  explanation: string | null;
  images: { question: ManifestImageRef[]; explanation: ManifestImageRef[] };
  /** Structured Match the Following lists (null when the row has none). */
  match: { listI: ManifestMatchEntry[]; listII: ManifestMatchEntry[] } | null;
  difficulty: string;
  source: string;
  requestedStatus: string;
  review: { required: boolean; reason: string | null };
  /** Problems found while normalizing (malformed cells); validate.ts turns them into ERRORs. */
  parseIssues: { field: string; message: string }[];
  formulaCells: string[];
}

export const IMAGE_LIMITS = { question: 8, perOption: 3, explanation: 8, perListEntry: 1 } as const;

/** Item separator in image cells: `|` or a line break. Alt text follows `::`. */
const ITEM_SPLIT = /\s*(?:\||\r?\n)\s*/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9 _().+-]*\.[A-Za-z0-9]{2,5}$/;

export function parseImageCell(cell: string | undefined, role: ManifestImageRole, field: string, optionLabel: OptionLabel | null, issues: ManifestQuestion["parseIssues"]): ManifestImageRef[] {
  if (!cell || !cell.trim()) return [];
  const out: ManifestImageRef[] = [];
  for (const item of cell.split(ITEM_SPLIT).filter(Boolean)) {
    const sep = item.indexOf("::");
    const filename = (sep >= 0 ? item.slice(0, sep) : item).trim();
    const altRaw = sep >= 0 ? item.slice(sep + 2).trim() : "";
    if (!filename) {
      issues.push({ field, message: `An image reference has alt text but no file name ("${item}").` });
      continue;
    }
    if (/[\\/]/.test(filename) || filename.includes("..")) {
      issues.push({ field, message: `Image reference "${filename}" contains a path. Use the bare file name only (folders inside the ZIP are ignored for matching).` });
      continue;
    }
    if (/^https?:/i.test(filename)) {
      issues.push({ field, message: `Image reference "${filename}" is a URL. Rich imports take images from the uploaded ZIP bundle only.` });
      continue;
    }
    if (!SAFE_FILENAME.test(filename) || filename.length > 120) {
      issues.push({ field, message: `Image reference "${filename}" is not a valid file name (letters, digits, space, _ . - ( ) + and an extension).` });
      continue;
    }
    const decorative = /^decorative$/i.test(altRaw);
    out.push({ filename, role, optionLabel, order: out.length, alt: decorative ? "" : altRaw || null, decorative, field, caption: null });
  }
  return out;
}

const TYPE_ALIASES: Record<string, ManifestQuestionType> = {
  "": "SINGLE_CORRECT",
  mcq: "SINGLE_CORRECT",
  single: "SINGLE_CORRECT",
  singlecorrect: "SINGLE_CORRECT",
  singleanswer: "SINGLE_CORRECT",
  multiplecorrect: "MULTIPLE_CORRECT",
  multiple: "MULTIPLE_CORRECT",
  msq: "MULTIPLE_CORRECT",
  matchthefollowing: "MATCH_THE_FOLLOWING",
  mtf: "MATCH_THE_FOLLOWING",
  match: "MATCH_THE_FOLLOWING",
};

export function parseQuestionType(v: string | undefined): ManifestQuestionType | null {
  const key = (v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return TYPE_ALIASES[key] ?? null;
}

export function parseContentFormat(v: string | undefined): ManifestContentFormat | null {
  const key = (v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key === "" || key === "PLAIN" || key === "TEXT") return "PLAIN";
  if (key === "RICHV1" || key === "RICH") return "RICH_V1";
  return null;
}

/** "A", "a", "A,B", "A | C", "A and D" → ["A","B"]; anything else → null. */
export function parseCorrect(v: string | undefined): string[] | null {
  const raw = (v ?? "").trim().toUpperCase();
  if (!raw) return [];
  const parts = raw.split(/\s*(?:,|\||;|\/|\+|&|\bAND\b|\s)\s*/).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !/^[A-D]$/.test(p))) return null;
  return [...new Set(parts)].sort();
}

export function parseBoolFlag(v: string | undefined): boolean | null {
  const key = (v ?? "").trim().toLowerCase();
  if (!key) return false;
  if (["true", "yes", "y", "1"].includes(key)) return true;
  if (["false", "no", "n", "0"].includes(key)) return false;
  return null;
}

/**
 * List I / List II cell → entries. Entries are separated by line breaks or
 * `|`; each starts with its key ("A." / "A)" / "A:" / "I." / "(iii)").
 * An entry's image goes after `@@` with optional `::alt`:
 *   A. $\vec F = q\vec v\times\vec B$ | B. Lorentz @@ list-b.png :: Field lines
 */
export function parseMatchList(cell: string | undefined, list: "I" | "II", issues: ManifestQuestion["parseIssues"]): ManifestMatchEntry[] {
  if (!cell || !cell.trim()) return [];
  const field = `List ${list}`;
  const out: ManifestMatchEntry[] = [];
  for (const item of cell.split(/\s*(?:\||\r?\n)\s*/).filter(Boolean)) {
    const m = item.match(/^\(?([A-Za-z]{1,4}|\d{1,2})[.):]\s*([\s\S]*)$/);
    if (!m) {
      issues.push({ field, message: `Entry "${item.slice(0, 40)}" must start with its key, e.g. "A. …" or "I. …".` });
      continue;
    }
    const key = m[1].toUpperCase();
    let text = m[2];
    let images: ManifestImageRef[] = [];
    const at = text.indexOf("@@");
    if (at >= 0) {
      images = parseImageCell(text.slice(at + 2), "QUESTION", field, null, issues).map((r) => ({ ...r, caption: `List ${list} (${key})` }));
      text = text.slice(0, at).trim();
      if (images.length > IMAGE_LIMITS.perListEntry) issues.push({ field, message: `Entry ${key} has ${images.length} images (max ${IMAGE_LIMITS.perListEntry}).` });
    }
    if (out.some((e) => e.key === key)) issues.push({ field, message: `Key "${key}" appears twice in List ${list}.` });
    if (!text && images.length === 0) issues.push({ field, message: `Entry ${key} is empty.` });
    out.push({ key, text, images });
  }
  return out;
}

export function toManifestQuestion(d: BulkImportRow): ManifestQuestion {
  const issues: ManifestQuestion["parseIssues"] = [];
  const correct = parseCorrect(d.correctAnswer);
  if (correct === null) issues.push({ field: "Correct", message: `"${d.correctAnswer}" is not a valid answer. Use one letter A–D (e.g. "B"), or several separated by commas for multiple-correct.` });
  const review = parseBoolFlag(d.reviewFlag);
  if (review === null) issues.push({ field: "Review Required", message: `"${d.reviewFlag}" is not TRUE/FALSE (or YES/NO).` });

  const optionCols: Record<OptionLabel, string | undefined> = {
    A: d.optionAImageFilename,
    B: d.optionBImageFilename,
    C: d.optionCImageFilename,
    D: d.optionDImageFilename,
  };
  const options = OPTION_LABELS.map((label) => ({
    label,
    text: (d[`option${label}` as keyof BulkImportRow] as string | undefined) ?? "",
    images: parseImageCell(optionCols[label], "OPTION", `Option ${label} Image`, label, issues),
  }));

  const listI = parseMatchList(d.listI, "I", issues);
  const listII = parseMatchList(d.listII, "II", issues);

  return {
    rowNumber: d.rowNumber,
    sourceCode: d.questionCode?.trim() || null,
    questionNumber: d.questionNumber?.trim() || null,
    exam: d.exam,
    year: d.examYear,
    paperCode: d.paperCode?.trim() || null,
    taxonomy: { subject: d.subject, topic: d.topic, subTopic: d.subTopic },
    questionType: parseQuestionType(d.questionType),
    contentFormat: parseContentFormat(d.contentFormat),
    text: d.questionText,
    options,
    correct: correct ?? [],
    explanation: d.explanation?.trim() ? d.explanation : null,
    images: {
      question: parseImageCell(d.questionImageFilename, "QUESTION", "Question Images", null, issues),
      explanation: parseImageCell(d.explanationImages, "EXPLANATION", "Explanation Images", null, issues),
    },
    match: listI.length || listII.length ? { listI, listII } : null,
    difficulty: d.difficulty,
    source: d.source,
    requestedStatus: (d.status ?? "").trim().toUpperCase(),
    review: { required: review === true, reason: d.reviewReason?.trim() || null },
    parseIssues: issues,
    formulaCells: d.formulaCells ?? [],
  };
}

/** Every image a question needs, in the order they will be attached. */
export function allImageRefs(m: ManifestQuestion): ManifestImageRef[] {
  const listImgs = m.match ? [...m.match.listI, ...m.match.listII].flatMap((e) => e.images) : [];
  return [...m.images.question, ...listImgs, ...m.options.flatMap((o) => o.images), ...m.images.explanation];
}

/**
 * The stored question text. A Match the Following question keeps its stem and
 * gets its structured lists appended as readable lines (the Test Player and
 * Review show question text with preserved line breaks). Until a structured
 * `matchSpec` column is approved (docs/NEET-QUESTION-TYPES.md §4), this is the
 * faithful production rendering of the staged structure.
 */
export function composeQuestionText(m: ManifestQuestion): string {
  if (!m.match || (m.match.listI.length === 0 && m.match.listII.length === 0)) return m.text;
  const block = (title: string, entries: ManifestMatchEntry[]) =>
    entries.length ? `${title}\n${entries.map((e) => `${e.key}. ${e.text || "(see figure)"}`).join("\n")}` : "";
  return [m.text, block("List I", m.match.listI), block("List II", m.match.listII)].filter(Boolean).join("\n\n");
}

/** Default alt when the author gave none — meaningful enough for the media alt policy, flagged as a warning. */
export function fallbackAlt(ref: ManifestImageRef): string {
  if (ref.caption) return `${ref.caption} figure`;
  if (ref.role === "OPTION") return `Option ${ref.optionLabel} image`;
  if (ref.role === "EXPLANATION") return `Explanation figure ${ref.order + 1}`;
  return `Question figure ${ref.order + 1}`;
}

// ---------------------------------------------------------------------------
// Rich-syntax sanity (WARNINGS only — author content is never rewritten)
// ---------------------------------------------------------------------------

export interface RichLintStats {
  formulas: number;
  chemistry: number;
}

const DISABLED_COMMANDS = /\\(href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\b/;

/** Problems with RICH_V1 markup in one field: unclosed delimiters, KaTeX parse errors, disabled commands, raw HTML. */
export function lintRichSource(src: string, field: string): { warnings: string[]; stats: RichLintStats } {
  const warnings: string[] = [];
  const stats: RichLintStats = { formulas: 0, chemistry: 0 };
  if (!src) return { warnings, stats };
  const segs = parseRich(src);
  let consumedDollars = 0;
  for (const seg of segs) {
    if (seg.kind !== "math") continue;
    const isChem = /^\\(ce|pu)\{/.test(seg.value) || /\\ce\{/.test(seg.value);
    if (isChem) stats.chemistry++;
    else stats.formulas++;
    if (!/^\\(ce|pu)\{/.test(seg.value)) consumedDollars += seg.display ? 4 : 2;
    try {
      katex.renderToString(seg.value, { ...KATEX_OPTIONS, throwOnError: true, strict: "ignore", displayMode: seg.display });
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^KaTeX parse error:\s*/, "") : "unknown error";
      warnings.push(`${field}: formula "${seg.value.slice(0, 60)}" does not render (${msg.slice(0, 120)}). It will show as an error box — please check it.`);
    }
    if (DISABLED_COMMANDS.test(seg.value)) warnings.push(`${field}: formula uses a disabled command (links, external images and HTML are switched off) — it will not render.`);
  }
  // Unescaped `$` the parser had to leave as literal text = an unclosed or empty formula.
  const unescaped = (src.match(/(?<!\\)\$/g) ?? []).length;
  if (unescaped > consumedDollars) warnings.push(`${field}: an unclosed or empty $…$ / $$…$$ formula is shown as literal text. Close it, or write \\$ for a literal dollar sign.`);
  for (const seg of segs) {
    if (seg.kind === "text" && /\\(ce|pu)\{/.test(seg.value)) {
      warnings.push(`${field}: a \\ce{…} / \\pu{…} has unbalanced braces and is shown as literal text.`);
      break;
    }
  }
  if (/\\\(|\\\[/.test(src)) warnings.push(`${field}: \\( … \\) and \\[ … \\] delimiters are not supported. Use $…$ for inline and $$…$$ for display math.`);
  if (/<\s*\/?\s*[a-zA-Z][^>]*>/.test(src)) warnings.push(`${field}: looks like HTML. Tags are shown as literal text (never interpreted).`);
  return { warnings, stats };
}

/** PLAIN text that looks like formula markup — shown literally, so warn. */
export function looksRich(src: string): boolean {
  return /(?<!\\)\$[^$\n]+\$|\\ce\{|\\pu\{|\\frac\{|\\sqrt|\\vec\{/.test(src);
}
