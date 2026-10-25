/**
 * Read-only interpretation of difficulty values (pure), used by Instagram
 * Studio to EXPLAIN a Question Bank review note in its checks. Canonical
 * values are the QuestionDifficulty enum: EASY, MEDIUM, HARD. Only legacy
 * codes with an unambiguous meaning are recognised; anything else (numbers,
 * "L", "HIGH" …) is UNKNOWN. Nothing here writes or changes Question Bank
 * data, and the importers do not use it.
 */

export const CANONICAL_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type CanonicalDifficulty = (typeof CANONICAL_DIFFICULTIES)[number];

/** Known legacy spellings → canonical value (keys upper-case, without spaces/dots). */
export const LEGACY_DIFFICULTY_CODES: Readonly<Record<string, CanonicalDifficulty>> = {
  E: "EASY",
  EASY: "EASY",
  M: "MEDIUM",
  MED: "MEDIUM",
  MEDIUM: "MEDIUM",
  MODERATE: "MEDIUM",
  H: "HARD",
  HARD: "HARD",
  DIFFICULT: "HARD",
  TOUGH: "HARD",
};

export type ParsedDifficulty =
  | { kind: "canonical"; value: CanonicalDifficulty }
  | { kind: "legacy"; value: CanonicalDifficulty; original: string }
  | { kind: "missing" }
  | { kind: "unknown"; original: string };

export function parseDifficulty(raw: string | null | undefined): ParsedDifficulty {
  const original = (raw ?? "").trim();
  if (!original) return { kind: "missing" };
  const key = original.toUpperCase().replace(/[\s.]/g, "");
  if ((CANONICAL_DIFFICULTIES as readonly string[]).includes(key)) return { kind: "canonical", value: key as CanonicalDifficulty };
  const mapped = LEGACY_DIFFICULTY_CODES[key];
  return mapped ? { kind: "legacy", value: mapped, original } : { kind: "unknown", original };
}

/**
 * The review note older imports wrote for codes they did not know yet
 * (`Difficulty "E" not recognized, will default to MEDIUM`). Several notes
 * may be joined with "; " in reviewReason.
 */
const LEGACY_NOTE = /Difficulty "([^"]*)" not recognized, will default to MEDIUM/;

export interface LegacyDifficultyNote {
  /** The code as written in the import file. */
  original: string;
  /** Canonical value it maps to (null = still unknown — needs an admin decision). */
  mapped: CanonicalDifficulty | null;
  /** reviewReason with this note removed ("" = nothing else to review). */
  remainingReason: string;
}

export function legacyDifficultyNote(reviewReason: string | null | undefined): LegacyDifficultyNote | null {
  const reason = reviewReason ?? "";
  const m = LEGACY_NOTE.exec(reason);
  if (!m) return null;
  const p = parseDifficulty(m[1]);
  const remainingReason = reason
    .replace(m[0], "")
    .split(/\s*;\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join("; ");
  return { original: m[1], mapped: p.kind === "canonical" || p.kind === "legacy" ? p.value : null, remainingReason };
}

export const DIFFICULTY_LABELS: Record<CanonicalDifficulty, string> = { EASY: "Easy", MEDIUM: "Medium", HARD: "Hard" };
