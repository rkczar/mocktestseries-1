/**
 * What a text field is made of, for language checks (pure; no I/O). Formula markup is NOT prose: LaTeX command names
 * (\text, \underset, \ce …), math between $…$, chemical formulas (H2SO4, CH3, NaCl) and single-letter symbols (K, x)
 * never count as English letters, so a Hindi field with a formula is judged by its Hindi words only.
 */

const ELEMENTS = new Set(
  "H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og".split(" "),
);
const DEV = /[ऀ-ॿ]/g;

/** True for a chemical formula written as plain letters: element symbols with optional counts (H2SO4, CH3, NaCl, OH). */
export function isChemicalToken(t: string): boolean {
  const parts = t.match(/[A-Z][a-z]?\d*/g);
  return !!parts && parts.join("") === t && parts.every((p) => ELEMENTS.has(p.replace(/\d+$/, "")));
}

/** Math regions, LaTeX command names and braces removed; the TEXT inside \text{…} etc. inside math is kept. */
function outsideMarkup(text: string): { prose: string; mathText: string } {
  const mathText: string[] = [];
  const prose = text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, (m) => {
    // Words a person reads inside a formula: \text{सांद्र} keeps सांद्र; \ce{H2SO4} is a formula.
    for (const t of m.matchAll(/\\(?:text|mathrm|textrm|mbox)\{([^{}]*)\}/g)) mathText.push(t[1]);
    return " ";
  });
  return { prose: prose.replace(/\\(?:ce|pu)\{[^{}]*\}/g, " ").replace(/\\[A-Za-z]+/g, " ").replace(/[{}_^]/g, " "), mathText: mathText.join(" ") };
}

export interface ScriptCounts {
  /** Devanagari characters (anywhere, formulas included). */
  dev: number;
  /** Latin letters of English WORDS only (no markup, formulas or single-letter symbols). */
  latin: number;
  /** The English words counted in `latin`. */
  latinWords: string[];
}

export function scriptCounts(text: string): ScriptCounts {
  const { prose, mathText } = outsideMarkup(text);
  const dev = (prose.match(DEV)?.length ?? 0) + (mathText.match(DEV)?.length ?? 0);
  const latinWords: string[] = [];
  // Word-level Latin runs; a Latin run glued to Devanagari still counts (it is a reading error, not a formula).
  for (const m of prose.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
    const w = m[0];
    if (w.replace(/\d/g, "").length < 2) continue; // single-letter symbols and variables (K, x, M2)
    if (isChemicalToken(w) || /^[A-Za-z]{1,3}\d+$/.test(w)) continue; // H2SO4, CH3, NaCl, x2, cm3
    latinWords.push(w);
  }
  return { dev, latin: latinWords.reduce((n, w) => n + w.replace(/[^A-Za-z]/g, "").length, 0), latinWords };
}

/** Share of Devanagari among the counted letters (0..1); null when the text has no language at all (formula, number). */
export function devanagariShareOf(text: string): number | null {
  const c = scriptCounts(text);
  return c.dev + c.latin === 0 ? null : c.dev / (c.dev + c.latin);
}

/** Formula / number / symbol content only (no words in any language). */
export function isNonLinguistic(text: string): boolean {
  return devanagariShareOf(text) === null;
}

/** A readable plain version of a LaTeX / \ce formula for alt text ("H3C–C(CH3)2–C(CH3)(OH)–CH3"-like, best effort). */
export function formulaPlain(text: string): string {
  return text
    .replace(/\$\$?|\\\(|\\\)|\\\[|\\\]/g, "")
    .replace(/\\(?:text|mathrm|textrm|mbox|ce|pu)\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:underset|overset)\b/g, " ")
    .replace(/\\(?:parallel|mid)\b|\|/g, " ")
    .replace(/\\[A-Za-z]+/g, " ")
    .replace(/[{}_^]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Atom counts of a formula text (C, H, O, N, halogens …); empty when no element symbol is found. */
export function atomCounts(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const plain = formulaPlain(text).replace(/Chemical structure:?/i, "");
  for (const m of plain.matchAll(/([A-Z][a-z]?)(\d*)/g)) {
    if (!ELEMENTS.has(m[1])) continue;
    out.set(m[1], (out.get(m[1]) ?? 0) + (m[2] ? Number(m[2]) : 1));
  }
  return out;
}

/** Different atom counts between two formula readings (e.g. an option's LaTeX and its image description), or null. */
export function atomCountDiff(a: string, b: string): string | null {
  // Only formula-to-formula: a description in words ("Diagram for option B", "Image of iodine") is never read as atoms.
  const formulaOnly = (t: string) => t.replace(/^[^:]{0,40}:/, "");
  if (scriptCounts(formulaOnly(a)).latin || scriptCounts(formulaOnly(b)).latin) return null;
  const x = atomCounts(formulaOnly(a));
  const y = atomCounts(formulaOnly(b));
  if (!x.size || !y.size) return null;
  const keys = [...new Set([...x.keys(), ...y.keys()])].sort();
  const diff = keys.filter((k) => (x.get(k) ?? 0) !== (y.get(k) ?? 0));
  return diff.length ? diff.map((k) => `${k}: ${x.get(k) ?? 0} vs ${y.get(k) ?? 0}`).join(", ") : null;
}

/** Option text that only transcribes a chemical structure / formula (no words, at least one element symbol or chem markup). */
export function structureOnlyText(text: string): boolean {
  return !!text.trim() && isNonLinguistic(text) && (atomCounts(text).size > 0 || /\\(?:underset|overset|ce|chemfig)\b/.test(text));
}
