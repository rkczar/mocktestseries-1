/**
 * The separate checks an imported question's Ready status depends on (owner decision 7, 2026-11-05). Pure and
 * client-safe: post-processing computes them, the review screens show them.
 *
 *  content     — V1 scope: wording, statement structure, options, figures and source fidelity (deterministic).
 *  answer      — the official answer key or an administrator's confirmation. An AI opinion never passes it; an AI
 *                opinion that differs from a verified official key is a warning (the key is the source of truth).
 *  taxonomy    — subject / topic of the selected exam's syllabus, including every Verify 2 classification result: a
 *                failed classification is never hidden by a passed wording check.
 *  independent — Verify 2's second reading. NOT_RUN until requested; required once it ran. A re-read of the same Word /
 *                sheet text confirms the transcription only and never counts as independent verification.
 *
 * A model failure (MODEL_ERROR / TIMEOUT / OUTPUT_TRUNCATED) is never a DISAGREEMENT, and neither is ever PASSED.
 */
import type { AiImportAnswerStatus } from "@prisma/client";
import { failureCheckStatus } from "@/lib/ai-import/failure";
import type { CheckResult, CheckStatus, PaperVerification, QuestionChecks, TaxonomyVerification } from "@/lib/ai-import/types";

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  NOT_RUN: "Not run",
  PASSED: "Passed",
  FAILED: "Failed",
  DISAGREEMENT: "Disagreement",
  MODEL_ERROR: "Model error",
  TIMEOUT: "Timed out",
  OUTPUT_TRUNCATED: "Output cut off",
  NEEDS_REVIEW: "Needs review",
};

export const CHECK_NAMES: Record<keyof Omit<QuestionChecks, "at">, string> = {
  content: "Wording & structure",
  answer: "Answer",
  taxonomy: "Subject / topic",
  independent: "Verify 2",
};

/** Issue codes of each check (a code that fails the check outright, and one that needs a person's decision). */
const CONTENT_FAIL = ["STATEMENTS_MERGED", "ANSWER_IN_OPTION", "OPTIONS_INCOMPLETE", "STEM_HAS_OPTIONS", "QUESTION_TEXT_SUSPECT", "NUMBER_CONFLICT", "SOURCE_TEXT_MISMATCH", "IMAGE_MISSING", "UNSUPPORTED_TYPE", "BILINGUAL_HINDI_MISSING", "BILINGUAL_MISMATCH"];
const CONTENT_REVIEW = ["STATEMENT_COUNT_MISMATCH", "EXTRACTION_UNCERTAIN", "UNREADABLE_TEXT", "OCR_UNCERTAIN", "FORMULA_ISSUE", "IMAGE_MAPPING_UNCERTAIN", "IMAGE_REFERENCE_UNCERTAIN", "VERIFY_DISAGREES", "RESCAN_PENDING", "FORMAT_DEVIATION", "REFERENCE_CONFLICT", "BILINGUAL_HINDI_UNCERTAIN", "OPTION_FORMULA_IMAGE_DIFFERS"];
const ANSWER_FAIL = ["ANSWER_MISMATCH", "ANSWER_AMBIGUOUS", "ANSWER_KEY_PAPER_MISMATCH", "ANSWER_TYPE_CONFLICT"];
const TAXONOMY_REVIEW = ["SUBJECT_UNKNOWN", "CLASSIFICATION_FAILED", "TOPIC_UNCERTAIN"];
const TAXONOMY_DISAGREE = ["TAXONOMY_DISAGREES", "SUBJECT_MISMATCH"];

/** Which check an issue code belongs to (filters on the review screens); null = none of the four. */
export function checkOfIssue(code: string): keyof Omit<QuestionChecks, "at"> | null {
  if (CONTENT_FAIL.includes(code) || CONTENT_REVIEW.includes(code)) return "content";
  if (ANSWER_FAIL.includes(code) || ["ANSWER_UNVERIFIED", "ANSWER_MISSING", "POSSIBLE_WITHDRAWN", "AI_OPINION_DIFFERS"].includes(code)) return "answer";
  if (TAXONOMY_REVIEW.includes(code) || TAXONOMY_DISAGREE.includes(code) || code === "TAXONOMY_CHECK_FAILED") return "taxonomy";
  if (code === "VERIFY2_DISAGREES" || code === "VERIFY2_FAILED") return "independent";
  return null;
}

/**
 * What a Verify 2 result was read from: SOURCE = the original page images; SAME_TEXT = the same Word / sheet text the
 * question was extracted from. Results stored before this field existed are recognised by their part label
 * ("… part 3 of 15" is a document text part).
 */
export function v2Independence(v2: { independence?: "SOURCE" | "SAME_TEXT"; part?: string | null }): "SOURCE" | "SAME_TEXT" {
  return v2.independence ?? (/\bpart \d+ of \d+$/.test(v2.part ?? "") ? "SAME_TEXT" : "SOURCE");
}

/** Ready requires every REQUIRED check to have PASSED; a question without a check record (older data) is not blocked here. */
export function checksAllowReady(c: QuestionChecks | null | undefined): boolean {
  if (!c) return true;
  return [c.content, c.answer, c.taxonomy, c.independent].every((x) => !x.required || x.status === "PASSED");
}

const listOf = (codes: string[], issues: Map<string, string>) => codes.map((c) => issues.get(c) ?? c).join(" · ").slice(0, 600);

export function questionChecks(input: {
  codes: string[];
  issues: Map<string, string>;
  answerStatus: AiImportAnswerStatus;
  /** An administrator confirmed the stored answer. */
  answerConfirmed: boolean;
  subjectId: string | null;
  topicId: string | null;
  adminTaxonomy: boolean;
  /** The current (not out-of-date) Verify 2 result, if any. */
  v2: NonNullable<PaperVerification["v2"]> | null;
  /** Verify 2's classification of the CURRENT subject / topic, if any. */
  v2Classification: TaxonomyVerification | null;
  v1Ran: boolean;
}): QuestionChecks {
  const { codes, issues } = input;
  const has = (list: string[]) => codes.filter((c) => list.includes(c));

  // Wording & structure (V1 scope).
  const cFail = has(CONTENT_FAIL);
  const cReview = has(CONTENT_REVIEW);
  const content: CheckResult = cFail.length
    ? { status: "FAILED", required: true, detail: listOf(cFail, issues) }
    : cReview.length
      ? { status: "NEEDS_REVIEW", required: true, detail: listOf(cReview, issues) }
      : { status: "PASSED", required: true, detail: input.v1Ran ? "Wording, statements, options and figures checked (Verify 1 ran)." : "Wording, statements, options and figures checked by the importer (full-paper Verify 1 not run yet)." };

  // Answer.
  const aFail = has(ANSWER_FAIL);
  let answer: CheckResult;
  if (input.answerConfirmed) answer = { status: "PASSED", required: true, detail: "Answer confirmed by an administrator." };
  else if (aFail.length) answer = { status: "FAILED", required: true, detail: listOf(aFail, issues) };
  // The verified official key settles the answer; a differing AI opinion is shown as a warning (never an overwrite).
  else if (input.answerStatus === "OFFICIAL_MATCHED" && !has(["ANSWER_UNVERIFIED", "ANSWER_MISSING", "POSSIBLE_WITHDRAWN"]).length) answer = { status: "PASSED", required: true, detail: codes.includes("AI_OPINION_DIFFERS") ? `Matches the official answer key. Warning: ${issues.get("AI_OPINION_DIFFERS") ?? "an AI opinion differs"}` : "Matches the official answer key." };
  else answer = { status: "NEEDS_REVIEW", required: true, detail: listOf(has(["ANSWER_UNVERIFIED", "ANSWER_MISSING", "POSSIBLE_WITHDRAWN"]), issues) || "No official answer: confirm the answer by hand, or upload the official key." };

  // Subject / topic.
  const vc = input.v2Classification;
  let taxonomy: CheckResult;
  if (codes.includes("TAXONOMY_CHECK_FAILED")) taxonomy = { status: vc?.failure ?? failureCheckStatus(vc?.findings.join(" ")), required: true, detail: issues.get("TAXONOMY_CHECK_FAILED") ?? "The subject / topic check gave no answer.", model: vc?.method ?? null };
  else if (has(TAXONOMY_DISAGREE).length) taxonomy = { status: "DISAGREEMENT", required: true, detail: listOf(has(TAXONOMY_DISAGREE), issues), model: vc?.method ?? null };
  else if (!input.subjectId || has(TAXONOMY_REVIEW).length) taxonomy = { status: "NEEDS_REVIEW", required: true, detail: listOf(has(TAXONOMY_REVIEW), issues) || "No subject." };
  else taxonomy = { status: "PASSED", required: true, detail: input.adminTaxonomy ? "Chosen by an administrator." : vc?.status === "AGREED" ? `Agrees with Verify 2 (${vc.method}).` : "Classified within this exam's syllabus." };

  // Verify 2 (independent second read): required once it ran.
  const v2 = input.v2;
  let independent: CheckResult;
  if (!v2 || v2.status === "UNAVAILABLE") independent = { status: "NOT_RUN", required: false, detail: v2 ? `Not read: ${v2.detail}`.slice(0, 400) : "Verify 2 has not been run." };
  else if (v2.status === "FAILED") independent = { status: failureCheckStatus(v2.error?.message ?? v2.detail), required: true, detail: (v2.error?.message ?? v2.detail).slice(0, 400), model: v2.model };
  else if (v2.status === "DISAGREE" || v2.status === "NOT_FOUND") independent = { status: "DISAGREEMENT", required: true, detail: v2.detail.slice(0, 400), model: v2.model };
  else if (v2Independence(v2) === "SAME_TEXT") independent = { status: "NEEDS_REVIEW", required: false, detail: `Re-read of the same Word / sheet text (${v2.model}): it confirms the transcription only, not the wording or structure against the original paper.`, model: v2.model };
  else independent = { status: "PASSED", required: true, detail: `Agrees with an independent read of the original pages (${v2.model}).`, model: v2.model };

  return { at: new Date().toISOString(), content, answer, taxonomy, independent };
}
