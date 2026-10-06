/**
 * Advanced question types (NEET Phase 4). Pure helpers, no prisma / server-only,
 * so the player, the importer, the admin form and the regression suites all
 * share exactly one definition of "a valid answer set" and "a valid match spec".
 *
 *  - SINGLE_CORRECT is the legacy path (every pre-Phase-4 question). Nothing in
 *    here is used to save, score or reveal it: lib/test-attempt.ts keeps its
 *    original single-label code for that type.
 *  - MULTIPLE_CORRECT: QuestionOption.isCorrect marks the correct SET (>= 2).
 *    Answers are label SETS (Answer.selectedLabels), compared order-independently,
 *    all-or-nothing.
 *  - MATCH_THE_FOLLOWING: List I / List II are presentation (Question.matchSpec);
 *    the four coded options are ordinary single-correct options.
 */

export const QUESTION_TYPES = ["SINGLE_CORRECT", "MULTIPLE_CORRECT", "MATCH_THE_FOLLOWING"] as const;
export type QuestionTypeName = (typeof QUESTION_TYPES)[number];

export const QUESTION_TYPE_LABEL: Record<QuestionTypeName, string> = {
  SINGLE_CORRECT: "Single correct",
  MULTIPLE_CORRECT: "Multiple correct",
  MATCH_THE_FOLLOWING: "Match the Following",
};

/** Unknown / missing → SINGLE_CORRECT (every legacy row and every v1/v2 snapshot). */
export function toQuestionType(v: unknown): QuestionTypeName {
  return v === "MULTIPLE_CORRECT" || v === "MATCH_THE_FOLLOWING" ? v : "SINGLE_CORRECT";
}

export function isMultipleCorrect(v: unknown): boolean {
  return v === "MULTIPLE_CORRECT";
}

/** Minimum correct options per type (SINGLE / MATCH: exactly one). */
export const MIN_MULTIPLE_CORRECT = 2;

/**
 * The answer-key rule for a type, given how many options are marked correct.
 * Returns a human message for an invalid key, or null when it is valid.
 */
export function correctCountIssue(type: QuestionTypeName, correctCount: number, optionCount: number): string | null {
  if (type === "MULTIPLE_CORRECT") {
    if (correctCount < MIN_MULTIPLE_CORRECT) return `A multiple-correct question needs at least ${MIN_MULTIPLE_CORRECT} correct options.`;
    if (correctCount > optionCount) return "More correct options than options.";
    return null;
  }
  if (correctCount === 0) return "Mark the correct option.";
  if (correctCount > 1) return "A single-correct question has exactly one correct option.";
  return null;
}

// ---------------------------------------------------------------------------
// Label sets (MULTIPLE_CORRECT answers and keys)
// ---------------------------------------------------------------------------

export type LabelSetResult = { ok: true; labels: string[] } | { ok: false; reason: "NOT_A_LIST" | "UNKNOWN_LABEL" | "TOO_MANY" };

/**
 * A submitted label set → the canonical stored form: unique, in the frozen
 * options' order. Duplicates are removed; anything that is not one of the
 * question's own option labels rejects the whole set (never silently dropped).
 * `[]` is a valid set: it means "no answer".
 */
export function normalizeLabelSet(raw: unknown, optionLabels: readonly string[]): LabelSetResult {
  if (!Array.isArray(raw)) return { ok: false, reason: "NOT_A_LIST" };
  if (raw.length > Math.max(optionLabels.length * 4, 16)) return { ok: false, reason: "TOO_MANY" };
  const chosen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || !optionLabels.includes(v)) return { ok: false, reason: "UNKNOWN_LABEL" };
    chosen.add(v);
  }
  return { ok: true, labels: optionLabels.filter((l) => chosen.has(l)) };
}

/** Order-independent set equality (D,A,B equals A,B,D). */
export function sameLabelSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/**
 * ALL-OR-NOTHING grading of one multiple-correct answer.
 * null = unanswered (empty set), never "incorrect".
 */
export function gradeLabelSet(selected: readonly string[], correct: readonly string[]): boolean | null {
  if (selected.length === 0) return null;
  if (correct.length === 0) return false;
  return sameLabelSet(selected, correct);
}

/** Display form: "A, B, D". */
export function formatLabelSet(labels: readonly string[]): string {
  return labels.join(", ");
}

// ---------------------------------------------------------------------------
// Match the Following spec
// ---------------------------------------------------------------------------

export interface MatchEntry {
  /** "A" … / "I" … — unique within its list. */
  key: string;
  /** PLAIN or RICH_V1 text, following the question's contentFormat. Never HTML. */
  text: string;
}

export interface MatchSpec {
  v: 1;
  listI: MatchEntry[];
  listII: MatchEntry[];
}

export const MATCH_LIMITS = { minEntries: 2, maxEntries: 10, maxKeyLength: 4, maxTextLength: 600 } as const;
const KEY_PATTERN = /^(?:[A-Z]{1,4}|\d{1,2})$/;

/** "I:A" / "II:III" — the QuestionAsset.listKey of an entry image. */
export function matchAssetKey(list: "I" | "II", key: string): string {
  return `${list}:${key}`;
}

/**
 * Structural validation of a stored / submitted match spec. Returns every
 * problem (empty = valid). Entry text may be empty only when the entry has an
 * image (`imageKeys` holds the "I:A" keys that have one).
 */
export function matchSpecIssues(raw: unknown, imageKeys: ReadonlySet<string> = new Set()): string[] {
  if (!raw || typeof raw !== "object") return ["List I / List II are missing."];
  const spec = raw as Record<string, unknown>;
  const issues: string[] = [];
  for (const [list, name] of [["listI", "I"], ["listII", "II"]] as const) {
    const entries = spec[list];
    if (!Array.isArray(entries)) {
      issues.push(`List ${name} is missing.`);
      continue;
    }
    if (entries.length < MATCH_LIMITS.minEntries) issues.push(`List ${name} needs at least ${MATCH_LIMITS.minEntries} entries.`);
    if (entries.length > MATCH_LIMITS.maxEntries) issues.push(`List ${name} has more than ${MATCH_LIMITS.maxEntries} entries.`);
    const seen = new Set<string>();
    for (const e of entries as unknown[]) {
      const entry = (e ?? {}) as Record<string, unknown>;
      const key = typeof entry.key === "string" ? entry.key : "";
      if (!KEY_PATTERN.test(key)) {
        issues.push(`List ${name}: "${String(entry.key ?? "").slice(0, 10)}" is not a valid key (A–Z, I–X or 1–99).`);
        continue;
      }
      if (seen.has(key)) issues.push(`List ${name}: key ${key} appears twice.`);
      seen.add(key);
      const text = typeof entry.text === "string" ? entry.text : null;
      if (text === null) issues.push(`List ${name} ${key}: text is missing.`);
      else if (text.length > MATCH_LIMITS.maxTextLength) issues.push(`List ${name} ${key}: longer than ${MATCH_LIMITS.maxTextLength} characters.`);
      else if (!text.trim() && !imageKeys.has(matchAssetKey(name, key))) issues.push(`List ${name} ${key}: needs text or an image.`);
    }
  }
  return issues;
}

/** Defensive read of a stored spec (snapshot or row). Anything malformed → null, never a throw. */
export function readMatchSpec(raw: unknown): MatchSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const spec = raw as Record<string, unknown>;
  const list = (v: unknown): MatchEntry[] | null => {
    if (!Array.isArray(v)) return null;
    const out: MatchEntry[] = [];
    for (const e of v as Record<string, unknown>[]) {
      if (!e || typeof e !== "object" || typeof e.key !== "string" || !e.key) return null;
      out.push({ key: e.key, text: typeof e.text === "string" ? e.text : "" });
    }
    return out;
  };
  const listI = list(spec.listI);
  const listII = list(spec.listII);
  if (!listI || !listII || listI.length === 0 || listII.length === 0) return null;
  return { v: 1, listI, listII };
}

/**
 * Admin form / importer text → entries: one entry per line, each starting with
 * its key ("A. text", "(ii) text", "3) text"). Keys are upper-cased.
 */
export function parseMatchLines(src: string): { entries: MatchEntry[]; issues: string[] } {
  const entries: MatchEntry[] = [];
  const issues: string[] = [];
  for (const line of src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^\(?([A-Za-z]{1,4}|\d{1,2})[.):]\s*([\s\S]*)$/);
    if (!m) {
      issues.push(`"${line.slice(0, 40)}" must start with its key, e.g. "A. …" or "I. …".`);
      continue;
    }
    entries.push({ key: m[1].toUpperCase(), text: m[2].trim() });
  }
  return { entries, issues };
}

export function matchLinesFromEntries(entries: readonly MatchEntry[]): string {
  return entries.map((e) => `${e.key}. ${e.text}`).join("\n");
}

/** Plain-text lists for share messages and AI-free copies ("(image)" for image-only entries). */
export function matchSpecToPlainLines(spec: MatchSpec, toText: (s: string) => string = (s) => s): string {
  const block = (title: string, entries: MatchEntry[]) => [title, ...entries.map((e) => `${e.key}. ${toText(e.text) || "(image)"}`)].join("\n");
  return `${block("List I", spec.listI)}\n\n${block("List II", spec.listII)}`;
}

// ---------------------------------------------------------------------------
// Frozen snapshots
// ---------------------------------------------------------------------------

/** The question type a frozen snapshot was taken as. v1/v2 (no `v: 3`) are always SINGLE_CORRECT. */
export function snapshotQuestionType(s: { v?: unknown; questionType?: unknown } | null | undefined): QuestionTypeName {
  return s?.v === 3 ? toQuestionType(s.questionType) : "SINGLE_CORRECT";
}

/**
 * The frozen answer key as a set. MULTIPLE_CORRECT reads `correctLabels`;
 * every other type is its one `correctLabel`. Answer-key data: server only
 * until an authorized reveal.
 */
export function snapshotCorrectLabels(s: { v?: unknown; questionType?: unknown; correctLabel?: unknown; correctLabels?: unknown } | null | undefined): string[] {
  if (snapshotQuestionType(s) === "MULTIPLE_CORRECT") {
    return Array.isArray(s?.correctLabels) ? (s.correctLabels as unknown[]).filter((l): l is string => typeof l === "string" && l !== "") : [];
  }
  return typeof s?.correctLabel === "string" && s.correctLabel ? [s.correctLabel] : [];
}

/**
 * The advanced-type fields a share message may carry (presentation only, never
 * the answer key). Empty for SINGLE_CORRECT, so its share text is unchanged.
 */
export function snapshotShareFields(s: { v?: unknown; questionType?: unknown; matchSpec?: unknown } | null | undefined): {
  questionType?: QuestionTypeName;
  matchLists?: MatchSpec | null;
} {
  const type = snapshotQuestionType(s);
  if (type === "SINGLE_CORRECT") return {};
  return { questionType: type, ...(type === "MATCH_THE_FOLLOWING" ? { matchLists: readMatchSpec(s?.matchSpec) } : {}) };
}

/** Ask AI / AI Variants (NEET Phase 4): they model one correct option, so advanced types are guarded. */
export const AI_UNSUPPORTED_TYPE_MESSAGE = "Ask AI isn't available for multiple-correct or Match the Following questions yet.";
