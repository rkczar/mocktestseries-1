/**
 * Ranking & Leaderboard rules (Phase 1) — the pure half of lib/leaderboard.ts.
 * No prisma, no `server-only`, so every rule here is directly testable from
 * a Node script (scripts/verify-leaderboard.ts). lib/leaderboard.ts runs the
 * same rules as one PostgreSQL query; the verify script checks both agree.
 *
 * Eligibility, per student and test (Mock Test or Previous Year Paper):
 *  - A COMPETITIVE attempt is ONLINE + Standard time (durationMode FIXED) +
 *    answers after the test (answerMode EXAM).
 *  - The OFFICIAL attempt is the student's earliest-started SUBMITTED
 *    competitive attempt (startedAt, then id). Later attempts are retakes and
 *    never replace or improve it.
 *  - An attempt EXPOSES the answer key when it is not competitive and either
 *    revealed answers while running (Practice Mode, answerMode INSTANT) or was
 *    submitted (its result/review shows the key): Practice Mode, 1 min per
 *    question, Custom time, OMR entry. An ABANDONED or still-running exam-mode
 *    attempt never showed the key, so it does not count.
 *  - A student whose official attempt was started after any exposing attempt
 *    is permanently unranked for that test.
 * Nothing here (or in lib/leaderboard.ts) writes to an attempt.
 */

export type RankingTestKind = "MOCK_TEST" | "PREVIOUS_YEAR_PAPER";

export interface RankingTestRef {
  kind: RankingTestKind;
  id: string;
}

/** The stored, server-computed TestAttempt columns ranking reads. Never Answer rows. */
export interface RankableAttempt {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED" | "ABANDONED";
  entryMode: "ONLINE" | "OFFLINE_OMR_ENTRY";
  durationMode: "FIXED" | "PER_QUESTION" | "CUSTOM" | "UNLIMITED";
  answerMode: "EXAM" | "INSTANT";
  startedAt: Date;
  submittedAt: Date | null;
  score: number | null;
  correctCount: number | null;
  incorrectCount: number | null;
  timeTakenSeconds: number | null;
}

export function isCompetitiveAttempt(a: Pick<RankableAttempt, "entryMode" | "durationMode" | "answerMode">): boolean {
  return a.entryMode === "ONLINE" && a.durationMode === "FIXED" && a.answerMode === "EXAM";
}

export function exposesAnswerKey(a: Pick<RankableAttempt, "entryMode" | "durationMode" | "answerMode" | "status">): boolean {
  return !isCompetitiveAttempt(a) && (a.answerMode === "INSTANT" || a.status === "SUBMITTED");
}

function startedBefore(a: Pick<RankableAttempt, "startedAt" | "id">, b: Pick<RankableAttempt, "startedAt" | "id">): boolean {
  const d = a.startedAt.getTime() - b.startedAt.getTime();
  return d !== 0 ? d < 0 : a.id < b.id;
}

/** Correct / (correct + incorrect); 0 when nothing was attempted. */
export function accuracyOf(correct: number | null, incorrect: number | null): number {
  const c = correct ?? 0;
  const attempted = c + (incorrect ?? 0);
  return attempted > 0 ? c / attempted : 0;
}

export type StudentStanding =
  | { kind: "RANKED"; officialAttemptId: string }
  | { kind: "PRIOR_PRACTICE"; officialAttemptId: string }
  | { kind: "NO_COMPETITIVE_ATTEMPT" };

/** One student's standing on one test, from all of their attempts of that test. */
export function studentStanding(attempts: RankableAttempt[]): StudentStanding {
  let official: RankableAttempt | null = null;
  for (const a of attempts) {
    if (a.status === "SUBMITTED" && isCompetitiveAttempt(a) && (!official || startedBefore(a, official))) official = a;
  }
  if (!official) return { kind: "NO_COMPETITIVE_ATTEMPT" };
  const exposedBefore = attempts.some((p) => exposesAnswerKey(p) && startedBefore(p, official));
  return exposedBefore ? { kind: "PRIOR_PRACTICE", officialAttemptId: official.id } : { kind: "RANKED", officialAttemptId: official.id };
}

/**
 * Why THIS attempt does or doesn't carry the student's rank. Neutral labels
 * for the result page — never an error, never shaming.
 */
export type AttemptRankingStatus =
  | "OFFICIAL" // this attempt is the student's ranked attempt
  | "RETAKE" // the student's ranked attempt is an earlier one
  | "PRACTICE_MODE" // answers after each question
  | "NON_STANDARD_TIME" // 1 min per question / Custom time
  | "OMR_ENTRY" // offline OMR answer entry
  | "PRACTICE_USED_BEFORE" // competitive, but practice/answer review came first
  | "NOT_SUBMITTED";

export function attemptRankingStatus(attemptId: string, studentAttempts: RankableAttempt[]): AttemptRankingStatus {
  const attempt = studentAttempts.find((a) => a.id === attemptId);
  if (!attempt || attempt.status !== "SUBMITTED") return "NOT_SUBMITTED";
  if (attempt.entryMode === "OFFLINE_OMR_ENTRY") return "OMR_ENTRY";
  if (attempt.answerMode === "INSTANT") return "PRACTICE_MODE";
  if (attempt.durationMode !== "FIXED") return "NON_STANDARD_TIME";
  const standing = studentStanding(studentAttempts);
  if (standing.kind === "NO_COMPETITIVE_ATTEMPT") return "NOT_SUBMITTED";
  if (standing.officialAttemptId !== attemptId) return standing.kind === "RANKED" ? "RETAKE" : "PRACTICE_USED_BEFORE";
  return standing.kind === "RANKED" ? "OFFICIAL" : "PRACTICE_USED_BEFORE";
}

export const ATTEMPT_RANKING_STATUS_LABEL: Record<Exclude<AttemptRankingStatus, "OFFICIAL">, string> = {
  RETAKE: "Retake — not ranked",
  PRACTICE_MODE: "Practice attempt — not ranked",
  NON_STANDARD_TIME: "Custom-time attempt — not ranked",
  OMR_ENTRY: "OMR entry — not ranked",
  PRACTICE_USED_BEFORE: "Practice used before competitive attempt — not ranked",
  NOT_SUBMITTED: "Not ranked",
};

/**
 * Ranking order (ties fall through in this order):
 *   1. score DESC  2. accuracy DESC  3. correctCount DESC
 *   4. timeTakenSeconds ASC  5. submittedAt ASC  6. attempt id ASC
 * Negative = a ranks above b. Mirrors the ORDER BY in lib/leaderboard.ts.
 */
export function compareForRank(a: RankableAttempt, b: RankableAttempt): number {
  const score = (b.score ?? 0) - (a.score ?? 0);
  if (score !== 0) return score;
  // Exact accuracy comparison by cross-multiplication (no float rounding);
  // nothing attempted = accuracy 0, whose numerator is 0 either way.
  const ac = a.correctCount ?? 0, ai = a.incorrectCount ?? 0, bc = b.correctCount ?? 0, bi = b.incorrectCount ?? 0;
  const accuracy = bc * Math.max(ac + ai, 1) - ac * Math.max(bc + bi, 1);
  if (accuracy !== 0) return accuracy;
  if (bc !== ac) return bc - ac;
  const time = (a.timeTakenSeconds ?? NO_TIME) - (b.timeTakenSeconds ?? NO_TIME);
  if (time !== 0) return time;
  const sub = (a.submittedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.submittedAt?.getTime() ?? Number.MAX_SAFE_INTEGER);
  if (sub !== 0) return sub;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
const NO_TIME = 2_147_483_647;

/**
 * Percentile and Top %, in tenths so the two always add up to exactly 100:
 *   percentile = 100 × (N − rank) / N        (share of participants ranked below you)
 *   top%       = 100 − percentile             (= 100 × rank / N)
 * Both rounded to one decimal; Top % never shows below 0.1 (then percentile
 * shows 99.9). Rank #24 of 386 → percentile 93.8, Top 6.2%. Rank #1 of 100 →
 * percentile 99.0, Top 1.0%. A sole participant is rank #1 → 0.0 / Top 100%.
 */
export function rankPercentiles(rank: number, total: number): { percentile: number; topPercent: number } {
  if (!Number.isInteger(rank) || !Number.isInteger(total) || total < 1 || rank < 1 || rank > total) {
    throw new RangeError(`invalid rank ${rank} of ${total}`);
  }
  let percentileTenths = Math.round((1000 * (total - rank)) / total);
  if (percentileTenths > 999) percentileTenths = 999;
  return { percentile: percentileTenths / 10, topPercent: (1000 - percentileTenths) / 10 };
}

export function formatPercent1(value: number): string {
  return value.toFixed(1);
}

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "er", "smt", "shri", "sri"]);

function tidyWord(word: string): string {
  const lettersOnly = word.replace(/[^\p{L}\p{M}'-]/gu, "");
  if (!lettersOnly) return "";
  const allOneCase = lettersOnly === lettersOnly.toLowerCase() || lettersOnly === lettersOnly.toUpperCase();
  const body = allOneCase ? lettersOnly.toLowerCase() : lettersOnly;
  return body.charAt(0).toUpperCase() + body.slice(1);
}

/**
 * Privacy-safe leaderboard name: First Name + Last Initial ("Rahul Kumar" →
 * "Rahul K."). Deleted / deletion-requested accounts are "Former Student",
 * never their old name. Tokens with digits or "@" are dropped so a phone
 * number or email typed into the name field can never surface. Empty →
 * "Student".
 */
export function leaderboardDisplayName(name: string | null | undefined, status: string): string {
  if (status === "DELETED" || status === "DELETION_REQUESTED") return "Former Student";
  const words = (name ?? "")
    .normalize("NFKC")
    .split(/\s+/)
    .filter((w) => w && !/[@\d]/.test(w))
    .map(tidyWord)
    .filter(Boolean);
  while (words.length > 1 && HONORIFICS.has(words[0].replace(/\.$/, "").toLowerCase())) words.shift();
  if (words.length === 0) return "Student";
  const first = words[0].slice(0, 20);
  if (words.length === 1) return first;
  const initial = words[words.length - 1].match(/\p{L}/u)?.[0]?.toUpperCase();
  return initial ? `${first} ${initial}.` : first;
}

/** "41m 05s" / "1h 02m" / "45s" — for leaderboard time columns. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
