/** Shared shapes of extracted content (client-safe, no server imports). */

export interface NBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ExtractedType = "SINGLE_CORRECT" | "MULTIPLE_CORRECT" | "MATCH_THE_FOLLOWING" | "ASSERTION_REASON" | "NUMERICAL" | "SUBJECTIVE" | "FIVE_OPTIONS" | "OTHER";

export interface ExtractedOption {
  /** Canonical label A–D (E for a fifth option, which makes the question not importable). */
  label: string;
  /** The label as printed ("(1)", "a)", "C."). */
  printed: string;
  text: string;
}

export interface ExtractedFigure {
  owner: "STEM" | "OPTION" | "SHARED" | "UNASSIGNED";
  optionLabel?: string | null;
  /** Page box (0..1) for crops; null when the bytes come from the document itself. */
  box?: NBox | null;
  /** Index into the page's embedded images (PDF) — exact original bytes are used. */
  embeddedIndex?: number | null;
  /** DOCX media part name (exact bytes). */
  mediaPart?: string | null;
  description?: string | null;
  confidence: number;
  /** Questions sharing this figure carry the same group key. */
  sharedGroup?: string | null;
}

export interface MatchEntry {
  key: string;
  text: string;
}

export interface ExtractedQuestion {
  section: string;
  number: number | null;
  label: string;
  pages: number[];
  type: ExtractedType;
  instructions?: string | null;
  passage?: string | null;
  stem: string;
  options: ExtractedOption[];
  listI?: MatchEntry[] | null;
  listII?: MatchEntry[] | null;
  /** Answer printed in the question paper itself ("Ans: B"), canonical labels. */
  printedAnswer: string[];
  contentFormat: "PLAIN" | "RICH_V1";
  /** 0..1 — how sure the extractor is that stem + options are complete and exact. */
  confidence: number;
  unreadable: string[];
  figures: ExtractedFigure[];
  /** LOCAL_PDF | DOCX | SHEET | AI_VISION | AI_VISION_TEXT | ADMIN */
  method: string;
  model?: string | null;
  /** Taxonomy names given by the source itself (spreadsheet columns, section headings). */
  hints?: { subject?: string | null; topic?: string | null; difficulty?: string | null; explanation?: string | null };
  continuesOnNextPage?: boolean;
  continuedFromPreviousPage?: boolean;
  notes?: string[];
  /** Independent verification (Agent B): a different model read the same source page without seeing this result. */
  verification?: QuestionVerification | null;
}

export interface QuestionVerification {
  model: string;
  /** True only when the independent read found this question and every compared field matched. */
  agree: boolean;
  /** Fields that differ ("question text", "option B", "options count", "printed answer", "figures", "not found"). */
  fields: string[];
  detail: string;
  at: string;
}

export interface PageExtraction {
  questions: ExtractedQuestion[];
  /** True when the local result is trustworthy enough to skip AI. */
  reliable: boolean;
  reasons: string[];
  answerKey?: { number: number; section: string; raw: string }[];
}

export function sourceKeyOf(q: Pick<ExtractedQuestion, "section" | "number" | "label">): string {
  return `${q.section || ""}#${q.number ?? q.label}`;
}
