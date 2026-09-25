/**
 * Pure (DB-free, provider-free) validation + duplicate detection for AI
 * Question Variants. Kept separate from lib/ai-variant.ts so
 * scripts/verify-ai-variants.ts can exercise the exact rules with known
 * good/bad/duplicate payloads without a live provider call.
 */

export const VARIANT_OPTION_LABELS = ["A", "B", "C", "D"] as const;

export interface GeneratedVariant {
  text: string;
  options: { label: string; text: string; isCorrect: boolean }[];
  /** Concise "why the correct option is right". Optional so an otherwise-valid question isn't thrown away over a missing explanation. */
  explanation: string;
  /** Per-incorrect-option reasons, keyed by label. */
  optionAnalysis: Record<string, string>;
}

/** Minimal shape duplicate detection compares against — the source question, stored siblings, and candidates accepted earlier in the same run. */
export interface ComparableQuestion {
  text: string;
  options: { text: string; isCorrect: boolean }[];
}

/** Case, accents, punctuation, option formatting ("A)", "(b)") and whitespace all normalized away. */
export function normalizeForDuplicateCheck(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^\s*\(?[a-e][.)]\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "is", "are", "was", "were", "be", "by", "with", "and", "or",
  "which", "what", "following", "most", "likely", "this", "that", "these", "those", "as", "from", "it", "its", "his", "her",
]);

function tokens(text: string): Set<string> {
  return new Set(normalizeForDuplicateCheck(text).split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function optionSet(q: ComparableQuestion): Set<string> {
  return new Set(q.options.map((o) => normalizeForDuplicateCheck(o.text)));
}

function correctText(q: ComparableQuestion): string {
  return normalizeForDuplicateCheck(q.options.find((o) => o.isCorrect)?.text ?? "");
}

/**
 * True if `candidate` is effectively the same question as `other`:
 *  - identical stem after normalization (same stem repeated, whatever the options), or
 *  - the same option set (options merely reordered) with a broadly similar stem, or
 *  - a near-identical stem (superficial rewording) with the same correct answer, or
 *  - a very similar stem with mostly the same options.
 * A genuine "changed numbers" variant passes: its stem is similar but the
 * correct answer and most options change with the numbers.
 */
export function isNearDuplicate(candidate: ComparableQuestion, other: ComparableQuestion): boolean {
  const stemA = normalizeForDuplicateCheck(candidate.text);
  const stemB = normalizeForDuplicateCheck(other.text);
  if (stemA === stemB) return true;

  const stemSim = jaccard(tokens(candidate.text), tokens(other.text));
  const optSim = jaccard(optionSet(candidate), optionSet(other));
  const sameCorrect = correctText(candidate) !== "" && correctText(candidate) === correctText(other);

  if (optSim === 1 && stemSim >= 0.5) return true;
  if (stemSim >= 0.9 && sameCorrect) return true;
  if (stemSim >= 0.8 && optSim >= 0.5) return true;
  return false;
}

/** Validates one parsed candidate object. Returns null for anything that must not enter the Question Bank. */
export function validateCandidate(value: unknown): GeneratedVariant | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as { text?: unknown; options?: unknown; explanation?: unknown; optionAnalysis?: unknown };
  if (typeof obj.text !== "string" || obj.text.trim().length === 0) return null;
  if (!Array.isArray(obj.options) || obj.options.length !== VARIANT_OPTION_LABELS.length) return null;

  const labels = new Set<string>();
  const texts = new Set<string>();
  let correctCount = 0;
  const options: GeneratedVariant["options"] = [];
  for (const raw of obj.options) {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as { label?: unknown; text?: unknown; isCorrect?: unknown };
    if (typeof o.label !== "string" || !(VARIANT_OPTION_LABELS as readonly string[]).includes(o.label)) return null;
    if (typeof o.text !== "string" || o.text.trim().length === 0) return null;
    if (typeof o.isCorrect !== "boolean") return null;
    if (labels.has(o.label)) return null;
    const normalizedText = normalizeForDuplicateCheck(o.text);
    if (normalizedText === "" || texts.has(normalizedText)) return null; // two identical option texts
    labels.add(o.label);
    texts.add(normalizedText);
    if (o.isCorrect) correctCount += 1;
    options.push({ label: o.label, text: o.text.trim(), isCorrect: o.isCorrect });
  }
  if (correctCount !== 1) return null; // MCQ_SINGLE: exactly one canonical correct answer
  options.sort((a, b) => a.label.localeCompare(b.label));

  const optionAnalysis: Record<string, string> = {};
  if (obj.optionAnalysis && typeof obj.optionAnalysis === "object") {
    for (const [label, reason] of Object.entries(obj.optionAnalysis as Record<string, unknown>)) {
      if (labels.has(label) && typeof reason === "string" && reason.trim()) optionAnalysis[label] = reason.trim();
    }
  }

  return {
    text: obj.text.trim(),
    options,
    explanation: typeof obj.explanation === "string" ? obj.explanation.trim() : "",
    optionAnalysis,
  };
}

/** Single-object validator (kept for compatibility with the original one-variant-per-call response shape). */
export function validateGenerated(raw: string): GeneratedVariant | null {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return validateCandidate(JSON.parse(match[0]));
  } catch {
    return null;
  }
}

/**
 * Parses a batch response — `{"variants": [...]}`, a bare array, or a single
 * object — into raw candidate objects. Malformed JSON yields [] (every
 * candidate rejected), never a throw.
 */
export function parseCandidateBatch(raw: string): unknown[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const attempts = [trimmed, trimmed.match(/\{[\s\S]*\}/)?.[0], trimmed.match(/\[[\s\S]*\]/)?.[0]];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        const variants = (parsed as { variants?: unknown }).variants;
        if (Array.isArray(variants)) return variants;
        return [parsed];
      }
    } catch {
      // try the next extraction
    }
  }
  return [];
}

export interface CandidateScreening {
  accepted: GeneratedVariant[];
  rejectedInvalid: number;
  rejectedDuplicate: number;
}

/**
 * Validates + dedupes a batch against the source, every stored sibling, and
 * each other, keeping at most `limit`. Duplicates are dropped — never padded
 * back in to reach a count.
 */
export function screenCandidates(rawCandidates: unknown[], compareAgainst: ComparableQuestion[], limit: number): CandidateScreening {
  const accepted: GeneratedVariant[] = [];
  let rejectedInvalid = 0;
  let rejectedDuplicate = 0;
  for (const raw of rawCandidates) {
    if (accepted.length >= limit) break;
    const candidate = validateCandidate(raw);
    if (!candidate) {
      rejectedInvalid += 1;
      continue;
    }
    if ([...compareAgainst, ...accepted].some((other) => isNearDuplicate(candidate, other))) {
      rejectedDuplicate += 1;
      continue;
    }
    accepted.push(candidate);
  }
  return { accepted, rejectedInvalid, rejectedDuplicate };
}
