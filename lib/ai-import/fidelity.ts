import { labelFromPrinted } from "@/lib/ai-import/prompts";
import type { ExtractedOption } from "@/lib/ai-import/types";

/**
 * Deterministic fidelity checks of extracted content (client-safe, no I/O). They never change a
 * character: every finding is a reason to flag the question for a human, worded for the admin.
 */

// ---- Numbers, signs, exponents and symbols ----------------------------------------------------------

const MINUS = /[−–—]/g;

/** "10^{-3}", "x_{2}", "6.02 × 10²³" → comparable tokens ("10", "^-3", "_2", "×", "\\alpha" …). */
export function formulaTokens(s: string): string[] {
  const sup: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+" };
  const sub: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
  let t = s
    .replace(MINUS, "-")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (m) => `^${[...m].map((c) => sup[c]).join("")}`)
    .replace(/[₀₁₂₃₄₅₆₇₈₉]+/g, (m) => `_${[...m].map((c) => sub[c]).join("")}`)
    .replace(/\\times|\\cdot|×|·/g, " × ")
    .replace(/\\le(q)?\b|≤/g, " ≤ ")
    .replace(/\\ge(q)?\b|≥/g, " ≥ ")
    .replace(/\\pm|±/g, " ± ")
    .replace(/\\neq|≠/g, " ≠ ")
    .replace(/\\(ce|pu|mathrm|text|rm|left|right|,|;|!|quad)\b/g, " ")
    .replace(/\$/g, " ")
    .replace(/[{}]/g, "");
  // \ce{H2SO4}: digits after an element symbol are subscripts in chemistry notation.
  t = t.replace(/([A-Z][a-z]?)(\d+)/g, "$1_$2");
  const out: string[] = [];
  for (const m of t.matchAll(/([\^_]?)\s*([+-]?)\s*(\d+(?:\.\d+)?)|(\\[a-zA-Z]+)|([<>=≤≥±≠×√∞°%])/g)) {
    if (m[3] !== undefined) {
      // A minus is kept when it is part of an exponent / subscript or a sign (not "a − 3").
      const prev = t.slice(0, m.index).trimEnd().slice(-1);
      const signed = m[2] === "-" && (m[1] !== "" || !/[\w)\]]/.test(prev));
      out.push(`${m[1]}${signed ? "-" : ""}${m[3]}`);
    } else out.push(m[4] ?? m[5]);
  }
  return out;
}

/** Differences between the numbers / signs / exponents / symbols of two reads of the same text. */
export function formulaDiff(a: string, b: string): string | null {
  const ta = formulaTokens(a);
  const tb = formulaTokens(b);
  const count = (l: string[]) => l.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ca = count(ta);
  const cb = count(tb);
  const onlyA = [...ca].filter(([k, n]) => (cb.get(k) ?? 0) < n).map(([k]) => k);
  const onlyB = [...cb].filter(([k, n]) => (ca.get(k) ?? 0) < n).map(([k]) => k);
  if (!onlyA.length && !onlyB.length) return null;
  return `${onlyA.length ? onlyA.slice(0, 4).join(" ") : "—"} vs ${onlyB.length ? onlyB.slice(0, 4).join(" ") : "—"}`;
}

/**
 * Numbers in the extracted text that do not occur anywhere in the page's own text layer (a digital PDF
 * page read by the vision model because its layout was unclear). The text layer keeps every digit even
 * when it loses superscripts ("10-3" for 10⁻³), so a number missing from it was changed or invented.
 */
export function numbersMissingFromSource(texts: string[], textLayer: string | null): string[] {
  if (!textLayer || textLayer.replace(/\s+/g, "").length < 80) return [];
  const src = textLayer.replace(MINUS, "-").replace(/\s+/g, "");
  const out = new Set<string>();
  for (const t of texts) {
    // Only the digits themselves: LaTeX markup ({}, ^, _) is not in the text layer.
    for (const m of t.replace(/\\[a-zA-Z]+/g, " ").matchAll(/\d+(?:\.\d+)?/g)) if (!src.includes(m[0])) out.add(m[0]);
  }
  return [...out];
}

/** Plain text that most likely lost a superscript ("3 × 108 m/s", "10-3 mol"): shown wrong to students. */
export function lostSuperscript(text: string): string | null {
  const t = text.replace(MINUS, "-");
  // "3 × 108" / "2.5 x 10-4", or a bare "10-3" directly followed by an SI unit ("10-12 years" is a range).
  const m = t.match(/\d(?:\.\d+)?\s*[x×]\s*10\s?[-]?\d{1,2}\b/) ?? t.match(/(?<![\d.^{])\b10-\d{1,2}\s?(?:mol|kg|cm|mm|nm|µm|m|s|g|J|N|C|M|L|Pa|W|V|A|K|Hz)\b/);
  return m ? m[0] : null;
}

// ---- Options -----------------------------------------------------------------------------------------

const ROMAN = ["i", "ii", "iii", "iv", "v", "vi"];

/** Position of a printed option label in its own sequence ("(c)" → 2, "3." → 2, "iv)" → 3), or null. */
export function printedIndex(printed: string): number | null {
  const v = printed.replace(/[()[\].:\s]/g, "").toLowerCase();
  if (!v) return null;
  if (/^[a-h]$/.test(v)) return v.charCodeAt(0) - 97;
  if (/^[1-8]$/.test(v)) return Number(v) - 1;
  const r = ROMAN.indexOf(v);
  return r >= 0 ? r : null;
}

/** Problems with the printed option labels and texts of one question (missing / duplicated / merged options). */
export function optionProblems(options: ExtractedOption[], number: number | null): string[] {
  const out: string[] = [];
  const idx = options.map((o) => printedIndex(o.printed));
  if (idx.every((i) => i !== null) && options.length > 1) {
    const seen = new Set<number>();
    const dup = idx.filter((i) => (seen.has(i!) ? true : (seen.add(i!), false)));
    if (dup.length) out.push(`The printed option label ${options[idx.indexOf(dup[0])].printed} appears twice — an option may belong to another question.`);
    else if (idx.some((i, k) => i !== k)) out.push(`The printed option labels run ${options.map((o) => o.printed).join(", ")} — an option may be missing or out of order.`);
  }
  if (number !== null) {
    const next = number + 1;
    for (const o of options) {
      const m = o.text.match(new RegExp(`(?:^|\\s)(?:Q\\.?\\s*)?${next}[.)]\\s+\\S`));
      if (m) {
        out.push(`Option ${o.label} seems to contain the start of Q${next} — the two questions may be merged.`);
        break;
      }
    }
  }
  const texts = options.map((o) => o.text.trim().toLowerCase()).filter(Boolean);
  if (new Set(texts).size < texts.length) out.push("Two options have the same text — an option may have been copied twice.");
  return out;
}

/** A question text that is only a placeholder, an instruction or a reference instead of the question itself. */
export function placeholderStem(stem: string, instructions: string | null | undefined, hasFigure: boolean): string | null {
  const s = stem.trim();
  if (!s) return "The question text is empty.";
  if (/^[.\s…_-]+$/.test(s) || /^\[[^\]]*\]$/.test(s)) return `The question text is only a placeholder ("${s.slice(0, 40)}").`;
  if (/^(question|q\.?)\s*\d*\s*[:.]?$/i.test(s)) return `The question text is only a label ("${s.slice(0, 40)}").`;
  if (/\b(text|question)\s+(is\s+)?(not|un)\s*(visible|readable|clear|available)\b/i.test(s)) return "The question text says it could not be read.";
  if (/^(see|refer to|look at)\s+(the\s+)?(figure|image|diagram|picture)\.?$/i.test(s) && !hasFigure) return "The question text only refers to a figure, and no figure was extracted.";
  if (instructions && s.toLowerCase() === instructions.trim().toLowerCase()) return "The question text repeats the general instructions instead of the question.";
  if (/^(choose|select|mark)\s+the\s+(correct|right|best)\s+(answer|option)\.?$/i.test(s)) return "The question text is a generic instruction, not the question.";
  return null;
}

// ---- Answer keys -------------------------------------------------------------------------------------

/**
 * One official key value → canonical labels. Accepts "B", "(3)", "A,C", "A & C", "A and C", "(a)(c)",
 * "AC" (only when every letter is a distinct option of this question). "A or C" (either accepted) and
 * anything that is not an option of this question are returned as problems, never guessed.
 */
export function parseKeyAnswer(raw: string, printedLabels: string[]): { labels: string[] | null; problem: string | null } {
  const v = raw.trim();
  if (!v) return { labels: null, problem: "The key value is empty." };
  if (/\bor\b/i.test(v)) return { labels: null, problem: `The key value "${v}" accepts alternatives ("or") — the question needs a manual decision.` };
  let parts = v
    .replace(/\)\s*\(/g, ",")
    .split(/\s*(?:[,&/;+]|\band\b)\s*|\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
  const valid = new Set(printedLabels.map((_, i) => String.fromCharCode(65 + i)));
  if (parts.length === 1 && /^[A-Ha-h]{2,5}$/.test(parts[0]) && labelFromPrinted(parts[0], printedLabels) === null) {
    const letters = [...parts[0].toUpperCase()];
    if (new Set(letters).size === letters.length && letters.every((l) => valid.has(l))) parts = letters;
  }
  const labels = parts.map((p) => labelFromPrinted(p, printedLabels));
  if (labels.some((l) => !l || !valid.has(l))) return { labels: null, problem: `The key value "${v}" is not one of this question's options.` };
  return { labels: [...new Set(labels as string[])], problem: null };
}
