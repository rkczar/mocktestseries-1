/** Pure core of Verify All Answers (lib/ai-import/verify-answers.ts): no DB, exam-independent. */

export type AnswerVerdict = "MATCH" | "MISMATCH" | "UNVERIFIED" | "NO_KEY";

export const ANSWER_VERDICT_LABELS: Record<AnswerVerdict, string> = { MATCH: "Match", MISMATCH: "Mismatch", UNVERIFIED: "Unverified", NO_KEY: "No key" };

/** Same values post-processing treats as a withdrawn / bonus question (lib/ai-import/post.ts WITHDRAWN). */
const WITHDRAWN = /^(bonus|dropped|deleted|withdrawn|\*|x|×)$/i;

/** Why a key entry could not decide the answer (Verify Answers report). */
export type KeyIssue = "UNMAPPED" | "WRONG_PAPER" | "DUPLICATE" | "WITHDRAWN";

const norm = (raw: string) => raw.toUpperCase().replace(/[()\s]/g, "");

/**
 * One question's saved answer against its identified key entries. Anything that is not a clear, single key value of
 * this paper is UNVERIFIED (never a match by default); a missing saved answer against a clear key is a MISMATCH.
 */
export function compareAnswer(input: {
  saved: string[];
  /** Key entries mapped to this question; fileProblem = why their key file is not this paper's identified key (null = it is). */
  keys: { rawValue: string; fileProblem: string | null }[];
  /** Key values with this question's number that were never mapped to it. */
  unmapped: string[];
  parse: (raw: string) => { labels: string[] | null; problem: string | null };
}): { verdict: AnswerVerdict; official: string[]; reason: string; code?: KeyIssue } {
  const { saved, keys, unmapped } = input;
  if (!keys.length)
    return unmapped.length
      ? { verdict: "UNVERIFIED", official: [], reason: `The key has an entry for this number (${unmapped.join(" / ")}) but it was not mapped to this question.`, code: "UNMAPPED" }
      : { verdict: "NO_KEY", official: [], reason: "No answer-key entry for this question." };
  const bad = keys.find((k) => k.fileProblem);
  if (bad) return { verdict: "UNVERIFIED", official: [], reason: `The answer key is not identified as this paper's key (${bad.fileProblem}).`, code: "WRONG_PAPER" };
  const distinct = [...new Set(keys.map((k) => norm(k.rawValue)))];
  if (distinct.length > 1) return { verdict: "UNVERIFIED", official: [], reason: `The key lists this question ${keys.length} times with different answers (${keys.map((k) => k.rawValue).join(" / ")}).`, code: "DUPLICATE" };
  if (WITHDRAWN.test(distinct[0])) return { verdict: "UNVERIFIED", official: [], reason: `The key marks this question "${keys[0].rawValue}" (withdrawn / bonus).`, code: "WITHDRAWN" };
  const parsed = input.parse(keys[0].rawValue);
  if (!parsed.labels?.length) return { verdict: "UNVERIFIED", official: [], reason: parsed.problem ?? `The key value "${keys[0].rawValue}" could not be read as an option.` };
  const official = parsed.labels;
  if (!saved.length) return { verdict: "MISMATCH", official, reason: `No answer is saved; the key says ${official.join(", ")}.` };
  const same = saved.length === official.length && [...saved].sort().join() === [...official].sort().join();
  return same
    ? { verdict: "MATCH", official, reason: "The saved answer equals the answer key." }
    : { verdict: "MISMATCH", official, reason: `Saved ${saved.join(", ")}; the key says ${official.join(", ")}.` };
}

/** Verify Answers: one question's paper-level category (key mapping + independent AI opinion, never merged). */
export type VaCategory = "CONFIRMED" | "MISSING" | "INCORRECT_MAPPING" | "DUPLICATE" | "WITHDRAWN" | "AI_DISAGREES" | "MANUAL_REVIEW";

export const VA_CATEGORY_LABELS: Record<VaCategory, string> = {
  CONFIRMED: "Correctly mapped",
  MISSING: "Missing answer",
  INCORRECT_MAPPING: "Incorrect mapping",
  DUPLICATE: "Duplicate / conflicting key",
  WITHDRAWN: "Withdrawn / dropped",
  AI_DISAGREES: "AI disagrees with official key",
  MANUAL_REVIEW: "Manual review",
};

export interface AiOpinion { answer: string[]; confidence: number; defective: boolean; reason: string }

/**
 * A = key extraction / mapping (the official key is authoritative); B = the AI's own answer (evidence only).
 * B never changes A: an AI that disagrees with a correctly mapped key only sends the question to manual review.
 */
export function vaCategory(m: { verdict: AnswerVerdict; code?: KeyIssue; official: string[]; saved: string[] }, ai: AiOpinion | null): { category: VaCategory; confidence: number } {
  if (m.code === "WITHDRAWN") return { category: "WITHDRAWN", confidence: 1 };
  if (m.code === "DUPLICATE") return { category: "DUPLICATE", confidence: 0 };
  if (m.verdict === "NO_KEY" || (m.verdict === "MISMATCH" && !m.saved.length)) return { category: "MISSING", confidence: 0 };
  if (m.verdict === "MISMATCH") return { category: "INCORRECT_MAPPING", confidence: 0 };
  if (m.verdict !== "MATCH") return { category: "MANUAL_REVIEW", confidence: 0 };
  if (!ai) return { category: "CONFIRMED", confidence: 0.9 }; // key mapping only, no independent check
  const agree = !ai.defective && [...ai.answer].sort().join() === [...m.official].sort().join();
  return agree ? { category: "CONFIRMED", confidence: Math.min(0.99, 0.9 + ai.confidence * 0.09) } : { category: "AI_DISAGREES", confidence: Math.max(0, 0.9 - ai.confidence) };
}
