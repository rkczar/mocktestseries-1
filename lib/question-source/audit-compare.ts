/**
 * Source ↔ Question Bank comparison for the CMS audit (pure, 2026-11-26). The source text is read independently of the
 * stored question (PDF text-layer words or local OCR inside the question's source crop); the stored question is what
 * students see. Findings are evidence for human review — never an automatic correction by themselves.
 */

export type Finding = { code: "STEM_DUPLICATED" | "INSTRUCTION_MISPLACED" | "SOURCE_CROP_INCOMPLETE" | "NUMBER_MISMATCH" | "NEGATION_MISMATCH" | "STEM_MISMATCH" | "OPTION_MISMATCH" | "OPTION_MISSING"; severity: "CRITICAL" | "MAJOR" | "MINOR"; detail: string };

const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** Lower-case word tokens (letters/digits), without option labels like "(a)". */
export function words(s: string): string[] {
  return strip(s)
    .toLowerCase()
    .replace(/\b([a-z])\s+(\d{1,2})\b/g, "$1$2") // "Vitamin B 12" (source layout) = "B12"
    .replace(/\(\s*[a-d]\s*\)/g, " ")
    .split(/[^a-z0-9%.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 0);
}

/** Numbers as written (12, 0.5, 120/80 → 120 and 80, 5% → 5%). Page / question numbers are the caller's to remove. */
export function numbers(s: string): string[] {
  return [...strip(s).matchAll(/\d+(?:\.\d+)?%?/g)].map((m) => m[0].replace(/^0+(?=\d)/, ""));
}

const NEG = ["not", "except", "incorrect", "false", "least", "never", "untrue", "wrong"];
const negs = (s: string) => {
  const w = words(s);
  return NEG.map((n) => [n, w.filter((x) => x === n).length] as const).filter(([, c]) => c > 0);
};

/** Share of the tokens of `a` that are present in `b` (multiset). */
export function coverage(a: string[], b: string[]): number {
  if (!a.length) return 1;
  const pool = new Map<string, number>();
  for (const t of b) pool.set(t, (pool.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of a) {
    const n = pool.get(t) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(t, n - 1);
    }
  }
  return hit / a.length;
}

/** Words of `a` missing from `b` (for the report), at most `max`. */
export function missingWords(a: string[], b: string[], max = 12): string[] {
  const pool = new Map<string, number>();
  for (const t of b) pool.set(t, (pool.get(t) ?? 0) + 1);
  const out: string[] = [];
  for (const t of a) {
    const n = pool.get(t) ?? 0;
    if (n > 0) pool.set(t, n - 1);
    else if (t.length > 1 && !out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A stem stored twice in a row ("X X", e.g. instructions that repeat the question): returns the single copy (exact text,
 * first occurrence) or null. Word-level check, so spacing / punctuation between the copies does not matter.
 */
export function duplicatedStem(stem: string): string | null {
  const w = words(stem);
  if (w.length < 6) return null;
  for (let k = 2; k <= 4; k++) {
    if (w.length % k) continue;
    const n = w.length / k;
    let same = true;
    for (let i = n; i < w.length && same; i++) if (w[i] !== w[i % n]) same = false;
    if (!same) continue;
    // Cut the original string after the first copy (the shortest prefix whose words are one copy).
    const t = stem.trim();
    const first = w.slice(0, n).join(" ");
    for (let cut = 1; cut <= t.length; cut++) if (words(t.slice(0, cut)).join(" ") === first && /[\s:?.)]$/.test(t.slice(0, cut + 1)) ) return t.slice(0, cut + 1).trim();
    return null;
  }
  return null;
}

const GENERIC = /^\s*select the correct answer using the codes? given below\s*[:.]?\s*/i;

/**
 * The stored stem as the source prints it, when the only differences are mechanical and source-proven (pure): a stem
 * stored twice → once; a generic "Select the correct answer using the code given below:" stored BEFORE a question whose
 * source does not start with it → removed (it stays where the source prints it, after the statements). Else null.
 */
export function proposedStem(stem: string, source: string): string | null {
  let t = stem.trim();
  let changed = false;
  const srcStart = strip(source).replace(/^\d{1,3}\.\s*/, "");
  if (GENERIC.test(t) && !GENERIC.test(srcStart)) {
    t = t.replace(GENERIC, "").trim();
    changed = true;
  }
  const once = duplicatedStem(t);
  if (once !== null) {
    t = once;
    changed = true;
  }
  return changed ? t : null;
}

/**
 * Compares a stored question with its source text. `source` is the text inside the question's crop (it may include the
 * printed number, page furniture and a neighbour's tail). Thresholds are deliberately tolerant of OCR noise: only clear
 * differences are reported, each with the exact words / numbers involved.
 */
export function compareToSource(q: { number: number | null; stem: string; options: { label: string; text: string }[] }, source: string): Finding[] {
  const out: Finding[] = [];
  const src = words(source);
  if (src.length < 5) return out; // nothing readable to compare with (the caller reports "source text unavailable")
  // A case scenario / passage shared by several items is printed once before them: it is not in this item's crop, so
  // only "source → stored" checks apply (nothing printed for this item may be missing from the stored text).
  const shared = /\b(directions|case scenario|following passage|read the following|answer the (?:two|three|four|five|\d+) items)\b/i.test(q.stem);
  // The crop holds the options when it shows at least two option markers; otherwise it was cut short (next column /
  // page) and option checks are skipped — reported as an incomplete source crop instead.
  const markers = (strip(source).match(/\(\s*[a-dA-D]\s*\)/g) ?? []).length;
  const optionsOnSource = markers >= 2;
  const srcStart = strip(source).replace(/^\d{1,3}\.\s*/, "");
  if (GENERIC.test(q.stem) && !GENERIC.test(srcStart)) out.push({ code: "INSTRUCTION_MISPLACED", severity: "MAJOR", detail: 'the stored question starts with "Select the correct answer using the code given below:", which the source does not print before this question' });
  const fixed = proposedStem(q.stem, source) ?? q.stem;
  const single = duplicatedStem(fixed);
  if (duplicatedStem(q.stem.replace(GENERIC, "")) !== null || duplicatedStem(q.stem) !== null) {
    out.push({ code: "STEM_DUPLICATED", severity: "CRITICAL", detail: "the question text is stored (and shown to students) twice in a row; the source prints it once" });
  }
  void single;
  const stem = words(fixed); // compared after the mechanical fixes (each reported above)
  const all = [...stem, ...q.options.flatMap((o) => words(o.text))];
  // Numbers / units / doses: every number of the stored question must be printed in the source, and vice versa
  // (except the question number, page numbers and option-list numbering "1 2 3 4" which the source also prints).
  const srcNums = numbers(source);
  const dbNums = numbers([q.stem, ...q.options.map((o) => o.text)].join(" "));
  const ignore = new Set([String(q.number ?? ""), ...["1", "2", "3", "4", "5"]]);
  const lost = [...new Set(dbNums.filter((n) => !srcNums.includes(n) && !ignore.has(n)))];
  const gained = [...new Set(srcNums.filter((n) => !dbNums.includes(n) && !ignore.has(n) && Number(n) < 2000))];
  if (lost.length && !shared && optionsOnSource) out.push({ code: "NUMBER_MISMATCH", severity: "CRITICAL", detail: `number(s) in the Question Bank but not on the source: ${lost.join(", ")}${gained.length ? `; on the source but not in the Question Bank: ${gained.slice(0, 8).join(", ")}` : ""}` });
  // Negations change the meaning.
  const sn = new Map(negs(source));
  const dn = new Map(negs([q.stem, ...q.options.map((o) => o.text)].join(" ")));
  const negDiff = [...new Set([...sn.keys(), ...dn.keys()])].filter((k) => (sn.get(k) ?? 0) !== (dn.get(k) ?? 0) && (k !== "not" || Math.abs((sn.get(k) ?? 0) - (dn.get(k) ?? 0)) > 0));
  const negLost = negDiff.filter((k) => (sn.get(k) ?? 0) > (dn.get(k) ?? 0));
  if (negLost.length) out.push({ code: "NEGATION_MISMATCH", severity: "CRITICAL", detail: `"${negLost.join('", "').toUpperCase()}" printed on the source but missing from the Question Bank text` });
  // Stem: the stored stem's words must be on the source; the source must not hold a lot of question text that is missing.
  const stemCov = coverage(stem, src);
  if (stem.length >= 4 && stemCov < 0.85 && !shared && optionsOnSource) out.push({ code: "STEM_MISMATCH", severity: stemCov < 0.6 ? "MAJOR" : "MINOR", detail: `${Math.round(stemCov * 100)}% of the stored question's words are on the source; not on the source: ${missingWords(stem, src).join(" ")}` });
  const back = coverage(src, all);
  if (src.length >= 12 && back < 0.7 && stemCov >= 0.85) out.push({ code: "STEM_MISMATCH", severity: "MINOR", detail: `source text missing from the Question Bank (${Math.round(back * 100)}% covered): ${missingWords(src, all).join(" ")}` });
  // Options: each one on the source (only when the crop shows the options).
  if (!optionsOnSource) {
    if (q.options.length) out.push({ code: "SOURCE_CROP_INCOMPLETE", severity: "MINOR", detail: "the source crop does not show this question's options (they continue in the next column / page) — options not compared" });
    return out;
  }
  for (const o of q.options) {
    const w = words(o.text);
    if (!w.length) {
      out.push({ code: "OPTION_MISSING", severity: "MAJOR", detail: `option ${o.label} is empty` });
      continue;
    }
    const c = coverage(w, src);
    if (c < 0.75) out.push({ code: "OPTION_MISMATCH", severity: c < 0.5 ? "MAJOR" : "MINOR", detail: `option ${o.label}: ${Math.round(c * 100)}% on the source; not on the source: ${missingWords(w, src).join(" ")}` });
  }
  return out;
}
