/**
 * Review Exceptions filters (pure — no Prisma): every URL value, its label and the predicate behind it.
 * Old values (status / verify / problem / issue) keep their exact meaning; new ones are added only.
 * Self-check: scripts/verify-review-filters.ts.
 */
import { ISSUE_DEFS, QUESTION_STATUS_LABELS } from "@/lib/ai-import/config";

// shortcut: copies of paper-verify.ts STRUCTURE_CODES / TAXONOMY_CODES (that module loads Prisma); the self-check fails if they drift.
export const STRUCTURE_CODES = ["ANSWER_IN_OPTION", "STATEMENTS_MERGED", "QUESTION_TEXT_SUSPECT", "OPTIONS_INCOMPLETE", "NUMBER_CONFLICT", "STEM_HAS_OPTIONS", "STATEMENT_COUNT_MISMATCH"];
export const TAXONOMY_CODES = ["SUBJECT_UNKNOWN", "CLASSIFICATION_FAILED", "SUBJECT_MISMATCH", "TOPIC_UNCERTAIN", "TAXONOMY_DISAGREES", "TAXONOMY_CHECK_FAILED"];
export const EXCEPTION_STATUSES = ["NEEDS_CORRECTION", "NOT_IMPORTABLE", "DUPLICATE", "IMPORT_FAILED", "EXTRACTED"] as const;
export const FORMULA_CODES = ["FORMULA_ISSUE", "FORMULA_TEXT_CORRUPT", "FORMULA_NEEDS_MANUAL_VERIFICATION", "OPTION_FORMULA_IMAGE_DIFFERS"];
export const IMAGE_CODES = ["IMAGE_MISSING", "IMAGE_MAPPING_UNCERTAIN", "IMAGE_REFERENCE_UNCERTAIN"];
export const DUPLICATE_CODES = ["DUPLICATE_EXISTING", "DUPLICATE_NEAR", "DUPLICATE_IN_BATCH"];
const ANSWER = ["ANSWER_MISSING", "ANSWER_MISMATCH", "ANSWER_AMBIGUOUS", "ANSWER_KEY_PAPER_MISMATCH", "ANSWER_TYPE_CONFLICT", "POSSIBLE_WITHDRAWN", "UNSUPPORTED_TYPE"];
const ANSWER_UNVERIFIED = ["ANSWER_UNVERIFIED", "AI_OPINION_DIFFERS"];
const BILINGUAL = ["BILINGUAL_HINDI_MISSING", "BILINGUAL_MISMATCH", "BILINGUAL_HINDI_UNCERTAIN"];

type Def = { label: string; hint: string };

/** Status values. `exceptions` = no `status` param (the default list); `all` = no status filter. */
export const STATUS_MAIN: Record<string, Def> = {
  all: { label: "All", hint: "Every question of the paper, including rejected ones." },
  exceptions: { label: "Needs review", hint: "Needs correction, not importable, duplicate, import failed or still being read." },
  approval: { label: "Awaiting approval", hint: "Ready, not approved yet, not in the Question Bank." },
  READY: { label: "Ready", hint: "Passed every mandatory check (approved or not)." },
  imported: { label: "Imported", hint: "Saved in the Question Bank (draft or published)." },
  REJECTED: { label: "Rejected", hint: "Rejected by an administrator; never enters the Question Bank." },
  withdrawn: { label: "Withdrawn", hint: "Marked withdrawn by the answer key, or flagged as possibly withdrawn." },
};
export const STATUS_ADVANCED: Record<string, Def> = {
  unresolved: { label: "Unresolved", hint: "Not in the Question Bank and not approved-and-ready: still needs a decision." },
  ...Object.fromEntries(Object.entries(QUESTION_STATUS_LABELS).filter(([k]) => !(k in STATUS_MAIN)).map(([k, v]) => [k, { label: v, hint: `Question status is exactly “${v}”.` }])),
};

export const VERIFY_MAIN: Record<string, Def> = {
  unverified: { label: "Not verified", hint: "Not both Verify 1 passed and Verify 2 verified on the current text." },
  verified: { label: "Verified", hint: "Verify 1 passed and Verify 2 verified, both on the current text." },
  "v2-disagree": { label: "Disagreements", hint: "Verify 2 disagrees or did not find the question." },
  notrun: { label: "Not run / out of date", hint: "Verify 1 or Verify 2 never ran, or ran before the question changed." },
};
export const VERIFY_ADVANCED: Record<string, Def> = {
  memory: { label: "Paper-memory findings", hint: "A confirmed paper rule found a problem." },
  "field-problems": { label: "Field problems (any check)", hint: "Any current field check reports a problem." },
  eligible: { label: "Eligible to publish", hint: "Passes the server's publish rule." },
  "v1-problems": { label: "Verify 1 findings", hint: "Verify 1 reported problems." },
  "v2-noresult": { label: "Verify 2 failed / unavailable", hint: "The Verify 2 model call failed or was unavailable." },
  "v2-notrun": { label: "Verify 2 not run / out of date", hint: "Verify 2 never ran or ran on older text." },
};

/** Problem groups: question has any of the codes (DUPLICATES also matches status DUPLICATE). */
export const PROBLEM_CODES: Record<string, string[]> = {
  text: ["OCR_UNCERTAIN", "SOURCE_TEXT_MISMATCH", "UNREADABLE_TEXT", "EXTRACTION_UNCERTAIN", "QUESTION_TEXT_SUSPECT", "STATEMENTS_MERGED", "NUMBER_CONFLICT", ...BILINGUAL],
  formula: FORMULA_CODES,
  options: ["OPTIONS_INCOMPLETE", "STEM_HAS_OPTIONS", "ANSWER_IN_OPTION", "STATEMENT_COUNT_MISMATCH"],
  "answer-key": [...ANSWER, ...ANSWER_UNVERIFIED],
  taxonomy: TAXONOMY_CODES,
  images: IMAGE_CODES,
  duplicates: DUPLICATE_CODES,
  // Advanced (old groups keep their exact code lists).
  "model-failure": ["TAXONOMY_CHECK_FAILED", "VERIFY2_FAILED", "CLASSIFICATION_FAILED"],
  "classifier-failed": ["CLASSIFICATION_FAILED"],
  "subject-mismatch": ["SUBJECT_MISMATCH"],
  "taxonomy-disagree": ["TAXONOMY_DISAGREES"],
  rescan: ["RESCAN_PENDING", "VERIFY2_DISAGREES", "VERIFY_DISAGREES"],
  structure: STRUCTURE_CODES,
  answer: ANSWER,
  "answer-unverified": ANSWER_UNVERIFIED,
  reference: ["REFERENCE_CONFLICT"],
  ocr: ["OCR_UNCERTAIN"],
  "source-mismatch": ["SOURCE_TEXT_MISMATCH"],
  "stem-options": ["STEM_HAS_OPTIONS"],
  bilingual: BILINGUAL,
};
export const PROBLEM_MAIN: Record<string, Def> = {
  text: { label: "Text / OCR", hint: "Text unreadable, OCR unsure, differs from the page, merged statements, Hindi/English pair." },
  formula: { label: "Formula", hint: "Formula corrupt, needs manual check, or differs from the image." },
  options: { label: "Options", hint: "Options incomplete, repeated in the question, or containing the answer." },
  "answer-key": { label: "Answer key", hint: "Answer missing, mismatched, ambiguous, unverified or possibly withdrawn." },
  taxonomy: { label: "Subject / Topic", hint: "Subject or topic unknown, uncertain, mismatched or check failed." },
  images: { label: "Images", hint: "Image missing or its placement is not confirmed." },
  duplicates: { label: "Duplicates", hint: "Duplicate status, or a possible duplicate in this paper or the Question Bank." },
};
export const PROBLEM_ADVANCED: Record<string, Def> = {
  "model-failure": { label: "Model failures (error, timeout, cut off)", hint: "" },
  "classifier-failed": { label: "Classifier failed (no answer)", hint: "" },
  "subject-mismatch": { label: "Subject mismatch", hint: "" },
  "taxonomy-disagree": { label: "Subject / topic check disagrees (Verify 1 / 2)", hint: "" },
  rescan: { label: "Re-scan candidates", hint: "A re-scan is pending, or Verify / Verify 2 disagreed with the read." },
  structure: { label: "Structure errors (stem / option / answer boundaries)", hint: "" },
  answer: { label: "Answer-key / type", hint: "" },
  "answer-unverified": { label: "Answer unverified / AI disagrees", hint: "" },
  reference: { label: "Reference differences", hint: "" },
  ocr: { label: "OCR unsure of text", hint: "" },
  "source-mismatch": { label: "Text differs from the page", hint: "" },
  "stem-options": { label: "Options repeated in question text", hint: "" },
  bilingual: { label: "Hindi / English pair problems", hint: "" },
};

export interface Filters {
  /** "exceptions" when the param is absent, null for `all`. */
  status: string | null;
  verify?: string;
  problem?: string;
  issue?: string;
}

/** Parses URL params; unknown values fall back exactly as before (status → exceptions, others → none). */
export function parseFilters(sp: Record<string, string | undefined>): Filters {
  const s = sp.status;
  return {
    status: s === "all" ? null : s && s !== "exceptions" && (s in STATUS_MAIN || s in STATUS_ADVANCED) ? s : "exceptions",
    verify: sp.verify && (sp.verify in VERIFY_MAIN || sp.verify in VERIFY_ADVANCED) ? sp.verify : undefined,
    problem: sp.problem && sp.problem in PROBLEM_CODES ? sp.problem : undefined,
    issue: sp.issue && sp.issue in ISSUE_DEFS ? sp.issue : undefined,
  };
}

export interface FilterRow {
  status: string;
  answerStatus: string;
  issueCodes: string[];
  approved: boolean;
  /** In the Question Bank: has a questionId and status IMPORTED / PUBLISHED. */
  stored: boolean;
  /** importBlocker(row, settings, { ignoreApproval: true }) — null when importable once approved. */
  importBlocker: string | null;
  v1: string;
  v2: string;
  eligible: boolean;
  fieldProblem: boolean;
  memoryProblem: boolean;
}

export const isStored = (q: { questionId: string | null; status: string }) => !!q.questionId && (q.status === "IMPORTED" || q.status === "PUBLISHED");
/** The one "awaiting approval" rule (Review Exceptions filter and Quality summary). */
export const awaitingApproval = (q: Pick<FilterRow, "status" | "approved" | "stored">) => q.status === "READY" && !q.approved && !q.stored;
/** Still needs a decision: live, not in the Question Bank, and not (approved, READY and importable). */
export const unresolved = (q: Pick<FilterRow, "status" | "approved" | "stored" | "importBlocker">) => q.status !== "REJECTED" && !q.stored && !(q.approved && q.status === "READY" && !q.importBlocker);

export function matchStatus(r: FilterRow, status: string | null): boolean {
  if (status === null) return true;
  if (status === "exceptions") return (EXCEPTION_STATUSES as readonly string[]).includes(r.status);
  if (status === "approval") return awaitingApproval(r);
  if (status === "imported") return r.status === "IMPORTED" || r.status === "PUBLISHED";
  if (status === "withdrawn") return r.answerStatus === "WITHDRAWN" || r.issueCodes.includes("POSSIBLE_WITHDRAWN");
  if (status === "unresolved") return unresolved(r);
  return r.status === status;
}

export function matchVerify(r: FilterRow, verify: string | undefined): boolean {
  if (!verify) return true;
  const ok = r.v1 === "passed" && r.v2 === "verified";
  switch (verify) {
    case "verified": return ok;
    case "unverified": return !ok;
    case "eligible": return r.eligible;
    case "v1-problems": return r.v1 === "problems";
    case "v2-disagree": return r.v2 === "disagree" || r.v2 === "not_found";
    case "v2-noresult": return r.v2 === "failed" || r.v2 === "unavailable";
    case "v2-notrun": return r.v2 === "none" || r.v2 === "stale";
    case "notrun": return r.v1 === "none" || r.v1 === "stale" || r.v2 === "none" || r.v2 === "stale";
    case "field-problems": return r.fieldProblem;
    case "memory": return r.memoryProblem;
    default: return true;
  }
}

export function matchProblem(r: FilterRow, problem: string | undefined): boolean {
  if (!problem) return true;
  return r.issueCodes.some((c) => PROBLEM_CODES[problem]?.includes(c)) || (problem === "duplicates" && r.status === "DUPLICATE");
}

/** All active filters. As before, `issue` overrides `problem`. */
export function matches(r: FilterRow, f: Filters): boolean {
  return matchStatus(r, f.status) && matchVerify(r, f.verify) && (f.issue ? r.issueCodes.includes(f.issue) : matchProblem(r, f.problem));
}

/** Per-chip counts over ONE paper's rows: each chip on its own (other active filters ignored). */
export function chipCounts(rows: FilterRow[]) {
  const n = (f: (r: FilterRow) => boolean) => rows.filter(f).length;
  const status: Record<string, number> = {};
  for (const k of [...Object.keys(STATUS_MAIN), ...Object.keys(STATUS_ADVANCED)]) status[k] = n((r) => matchStatus(r, k === "all" ? null : k));
  const verify: Record<string, number> = {};
  for (const k of [...Object.keys(VERIFY_MAIN), ...Object.keys(VERIFY_ADVANCED)]) verify[k] = n((r) => matchVerify(r, k));
  const problem: Record<string, number> = {};
  for (const k of Object.keys(PROBLEM_CODES)) problem[k] = n((r) => matchProblem(r, k));
  const issue: Record<string, number> = {};
  for (const r of rows) for (const c of new Set(r.issueCodes)) issue[c] = (issue[c] ?? 0) + 1;
  return { status, verify, problem, issue };
}
export type ChipCounts = ReturnType<typeof chipCounts>;

/**
 * Coarse database filter for the all-papers list (status / problem / issue only; verification and
 * "unresolved" are applied in memory with matches()). Shape matches Prisma.AiImportQuestionWhereInput.
 */
export function dbWhere(f: Filters): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  const s = f.status;
  if (s === "exceptions") and.push({ status: { in: [...EXCEPTION_STATUSES] } });
  else if (s === "approval") and.push({ status: "READY", approvedById: null, questionId: null });
  else if (s === "imported") and.push({ status: { in: ["IMPORTED", "PUBLISHED"] } });
  else if (s === "withdrawn") and.push({ OR: [{ answerStatus: "WITHDRAWN" }, { issueCodes: { has: "POSSIBLE_WITHDRAWN" } }] });
  else if (s === "unresolved") and.push({ status: { not: "REJECTED" } });
  else if (s) and.push({ status: s });
  if (f.issue) and.push({ issueCodes: { has: f.issue } });
  else if (f.problem) and.push(f.problem === "duplicates" ? { OR: [{ issueCodes: { hasSome: PROBLEM_CODES.duplicates } }, { status: "DUPLICATE" }] } : { issueCodes: { hasSome: PROBLEM_CODES[f.problem] } });
  return and.length ? { AND: and } : {};
}
