/**
 * A printed section heading ("■ SECTION: SURGERY", "PREVENTIVE & SOCIAL MEDICINE") → one subject of the selected
 * exam's own taxonomy. Pure (no I/O). Only this exam's subjects are candidates; a heading that does not name exactly
 * one of them is left unresolved (never guessed):
 *
 *   1. the subject's own name (same words, any order / "&" = "and"),
 *   2. an administrator-confirmed heading alias of this exam (taxonomy memory),
 *   3. the heading's words all inside exactly ONE subject name ("SURGERY" → "General Surgery").
 */

const MARKS = /^[►▶➤→•✓✔☑√■□▪●◆#*\s]+/;
const STOP = new Set(["and", "of", "the", "in", "&", "section", "part", "subject"]);

/** Comparable form of a heading or subject name: lower case, "&" → "and", marks / "Section X:" / punctuation removed. */
export function headingKey(text: string): string {
  return text
    .replace(MARKS, "")
    .replace(/^(section|part|subject)\s*(?:[A-Z0-9]{1,3}(?=\s*[:.-]))?\s*[:.-]?\s*/i, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (key: string) => new Set(key.split(" ").filter((w) => w && !STOP.has(w)));

export interface HeadingAlias {
  /** headingKey() of the printed heading. */
  heading: string;
  subjectId: string;
}

export interface HeadingResolution {
  subjectId: string;
  via: "name" | "alias" | "words";
}

export function resolveHeadingSubject(heading: string | null | undefined, subjects: { id: string; name: string }[], aliases: HeadingAlias[] = []): HeadingResolution | null {
  const key = headingKey(heading ?? "");
  if (!key) return null;
  const hw = words(key);
  const sameWords = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((w) => b.has(w));
  const byName = subjects.filter((s) => headingKey(s.name) === key || sameWords(words(headingKey(s.name)), hw));
  if (byName.length === 1) return { subjectId: byName[0].id, via: "name" };
  const alias = aliases.find((a) => a.heading === key && subjects.some((s) => s.id === a.subjectId));
  if (alias) return { subjectId: alias.subjectId, via: "alias" };
  if (!hw.size) return null;
  const inside = subjects.filter((s) => {
    const sw = words(headingKey(s.name));
    return [...hw].every((w) => sw.has(w));
  });
  return inside.length === 1 ? { subjectId: inside[0].id, via: "words" } : null;
}
