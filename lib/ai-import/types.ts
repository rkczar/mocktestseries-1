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
  /** Caption / reference printed with the figure ("Fig. 3"), as printed. */
  caption?: string | null;
  /** Why the figure is (or is not) trusted to belong to this question — deterministic, shown to the admin. */
  mappingReason?: string | null;
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
  /** The printed answer exactly as it appeared ("Correct answer is (b)"), when it was found in the question's own text. */
  printedAnswerRaw?: string | null;
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
  /** Page box (0..1) of the whole question (number, stem, options, figures) as the reader located it. */
  region?: NBox | null;
  /** Printed number kept when the number itself had to be cleared (the same number already exists on another page). */
  printedNumber?: number | null;
  notes?: string[];
  /** Independent verification (Agent B): a different model read the same source page without seeing this result. */
  verification?: QuestionVerification | null;
  /** Full-paper verification (Review Exceptions → Verify 1 / Verify 2). Kept on the extraction; stale once the content changes. */
  paperVerify?: PaperVerification | null;
  /** How the subject / topic / subtopic was chosen (or why not), written by every check run. Kept on the extraction. */
  classification?: ClassificationRecord | null;
}

/**
 * The subject / topic decision of one imported question. `kind` keeps the causes apart:
 * ok (assigned with enough confidence) · uncertain (genuinely unclear — not forced) · missing_taxonomy (the exam lacks
 * the subject / topic configuration) · engine_failure (the AI classifier failed or gave no answer — never a judgement)
 * · text_incomplete (the question text is not complete enough to classify — an extraction problem) · admin (chosen
 * by an administrator).
 */
export interface ClassificationRecord {
  at: string;
  kind: "ok" | "uncertain" | "missing_taxonomy" | "engine_failure" | "text_incomplete" | "admin";
  subjectId: string | null;
  topicId: string | null;
  subTopicId: string | null;
  confidence: number | null;
  /** selected subject · source column · local classifier · confirmed example · AI (model) · admin. */
  source: string | null;
  reason: string;
  /** The free local classifier's own result (shown next to the stored choice). */
  local: { status: string; subjectId: string | null; topicId: string | null; subTopicId: string | null; subjectConfidence: number; topicConfidence: number; method: string; reason: string; candidates: { subjectId: string; topicId: string | null; score: number }[]; evidenceQuestions: number } | null;
  /** The AI classifier's part: USED / REJECTED (its answer failed the guards) / FAILED / NO_RESULT. */
  ai: { model: string | null; status: "USED" | "REJECTED" | "FAILED" | "NO_RESULT"; detail: string } | null;
}

/**
 * Verify 1 / Verify 2 classification check. AGREED: the check supports the stored subject / topic · DISAGREEMENT: it
 * points elsewhere · NEEDS_REVIEW: nothing reliable is stored, or the evidence is too weak to confirm it ·
 * VERIFICATION_FAILED: the check itself failed (model error, timeout, truncated or missing answer) — never agreement
 * · NOT_VERIFIED: not checked (no taxonomy, text incomplete, not part of the run).
 */
export interface TaxonomyVerification {
  status: "AGREED" | "DISAGREEMENT" | "NEEDS_REVIEW" | "VERIFICATION_FAILED" | "NOT_VERIFIED";
  /** The stored ids that were checked. */
  stored: { subjectId: string | null; topicId: string | null; subTopicId: string | null };
  /** The check's own independent choice (never applied). */
  found: { subjectId: string | null; topicId: string | null; subTopicId: string | null } | null;
  confidence: number | null;
  /** local / the Verify 2 model. */
  method: string;
  findings: string[];
}

/** One finding of a full-paper verification, with the issue code it raises on the question. */
export interface VerifyProblem {
  code: string;
  detail: string;
}

/** A correction applied by Verify 1, with the evidence that supports it (the previous version is kept in the history). */
export interface VerifyFix {
  field: string;
  before: string;
  after: string;
  evidence: string;
}

export interface PaperVerification {
  /** Verify 1 — deterministic full-paper verification (no AI). */
  v1?: {
    fingerprint: string;
    at: string;
    passed: boolean;
    problems: VerifyProblem[];
    fixes: VerifyFix[];
    /** The reference paper's matching question (number) and the conflicts with it. */
    reference?: { refId: string; name: string; matched: string | null; conflicts: string[] } | null;
    /**
     * Every reference paper, each identifiable: whether it could be compared at all (a scanned reference that was
     * only stored is `compared: false` — never reported as compared), the matching question, how similar its wording
     * is (0–1) and the differences found.
     */
    references?: { refId: string; name: string; compared: boolean; matched: string | null; similarity: number | null; conflicts: string[]; note?: string | null }[];
    /** A reusable paper-format profile applied to this paper and what it found here (lib/ai-import/format-profile.ts). */
    profile?: { id: string; version: number; findings: string[] } | null;
    /** Subject / topic / subtopic check (free local classifier + exam-taxonomy validity). */
    classification?: TaxonomyVerification | null;
  };
  /** Verify 2 — independent second read by a separately selected model. */
  v2?: {
    fingerprint: string;
    at: string;
    model: string;
    /**
     * VERIFIED: every compared field agrees (or the source settles it) · DISAGREE / NOT_FOUND: manual decision needed ·
     * FAILED: the request was sent but gave no usable answer (timeout, refusal, empty, cut off, malformed) ·
     * UNAVAILABLE: nothing usable could be sent (model / route unavailable, paid AI off, budget stop). Neither of the
     * last two is ever counted as agreement.
     */
    status: "VERIFIED" | "DISAGREE" | "NOT_FOUND" | "FAILED" | "UNAVAILABLE";
    /** Why there is no result (FAILED / UNAVAILABLE): the failure kind and the provider's / importer's own message. */
    error?: { kind: string; message: string; model: string | null } | null;
    /** The source part that was read ("cms 2025.docx part 3 of 12", "page 4"). */
    part?: string | null;
    fields: string[];
    detail: string;
    /** How a disagreement was settled from the source (text layer / document text), if it was. */
    resolvedBySource?: string | null;
    /** What the second read gave for the fields that differ (shown to the administrator, never applied). */
    second?: { stem?: string; options?: string[]; printedAnswer?: string[]; topic?: string | null; subject?: string | null; subTopic?: string | null; statements?: number } | null;
    /** Independent subject / topic / subtopic classification by the Verify 2 model, compared with the stored one and Verify 1's. */
    classification?: TaxonomyVerification & { comparedWithV1: "AGREES" | "DIFFERS" | "NO_V1" } | null;
  };
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
