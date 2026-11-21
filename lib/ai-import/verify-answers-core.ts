/** Pure core of Verify All Answers (lib/ai-import/verify-answers.ts): no DB, exam-independent. */

export type AnswerVerdict = "MATCH" | "MISMATCH" | "UNVERIFIED" | "NO_KEY";

export const ANSWER_VERDICT_LABELS: Record<AnswerVerdict, string> = { MATCH: "Match", MISMATCH: "Mismatch", UNVERIFIED: "Unverified", NO_KEY: "No key" };

/** Same values post-processing treats as a withdrawn / bonus question (lib/ai-import/post.ts WITHDRAWN). */
const WITHDRAWN = /^(bonus|dropped|deleted|withdrawn|\*|x|×)$/i;

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
}): { verdict: AnswerVerdict; official: string[]; reason: string } {
  const { saved, keys, unmapped } = input;
  if (!keys.length)
    return unmapped.length
      ? { verdict: "UNVERIFIED", official: [], reason: `The key has an entry for this number (${unmapped.join(" / ")}) but it was not mapped to this question.` }
      : { verdict: "NO_KEY", official: [], reason: "No answer-key entry for this question." };
  const bad = keys.find((k) => k.fileProblem);
  if (bad) return { verdict: "UNVERIFIED", official: [], reason: `The answer key is not identified as this paper's key (${bad.fileProblem}).` };
  const distinct = [...new Set(keys.map((k) => norm(k.rawValue)))];
  if (distinct.length > 1) return { verdict: "UNVERIFIED", official: [], reason: `The key lists this question ${keys.length} times with different answers (${keys.map((k) => k.rawValue).join(" / ")}).` };
  if (WITHDRAWN.test(distinct[0])) return { verdict: "UNVERIFIED", official: [], reason: `The key marks this question "${keys[0].rawValue}" (withdrawn / bonus).` };
  const parsed = input.parse(keys[0].rawValue);
  if (!parsed.labels?.length) return { verdict: "UNVERIFIED", official: [], reason: parsed.problem ?? `The key value "${keys[0].rawValue}" could not be read as an option.` };
  const official = parsed.labels;
  if (!saved.length) return { verdict: "MISMATCH", official, reason: `No answer is saved; the key says ${official.join(", ")}.` };
  const same = saved.length === official.length && [...saved].sort().join() === [...official].sort().join();
  return same
    ? { verdict: "MATCH", official, reason: "The saved answer equals the answer key." }
    : { verdict: "MISMATCH", official, reason: `Saved ${saved.join(", ")}; the key says ${official.join(", ")}.` };
}
