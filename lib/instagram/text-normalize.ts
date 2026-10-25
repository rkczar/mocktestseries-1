/**
 * Shared slide-text normalizer (pure — no font or file access here; the
 * caller passes which code points the slide fonts can draw, see
 * lib/instagram/glyphs.ts). Used by every slide type and both design modes:
 * the renderer, the quality gate, AI ingestion, Save and the Fix actions.
 *
 * Only characters the fonts can NOT draw are ever changed, so a real minus
 * sign (U+2212), en dash and em dash — which the fonts draw — are kept as
 * written. Two classes of replacement:
 *
 *  - "equivalent": the replacement looks and means the same (a non-breaking
 *    hyphen U+2011 becomes "-", a thin space becomes a space, a soft hyphen
 *    is dropped). Applied automatically wherever slide text is handled.
 *  - "contextual": the replacement keeps the meaning but changes how it is
 *    written (Na⁺ → Na+, 10⁻⁶ → 10^-6, ⇒ → →). Never applied silently — the
 *    Fix actions list each one in a preview the admin applies.
 *
 * Anything else the fonts can't draw (emoji, ⇌, ✓ …) has no safe automatic
 * replacement: the gate keeps blocking it and the admin rewrites it.
 */

export type ReplacementClass = "equivalent" | "contextual";

export interface TextReplacement {
  from: string;
  to: string;
  cls: ReplacementClass;
  reason: string;
}

export interface NormalizeResult {
  text: string;
  replacements: TextReplacement[];
  /** Characters still not drawable after the replacements (distinct). */
  remaining: string[];
}

/** Can the slide fonts draw this code point? */
export type Coverage = (codePoint: number) => boolean;

/** Never drawn, never a problem (whitespace / joiners / variation selectors). */
export const INVISIBLE = new Set([0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f]);

/** Equivalent replacements: same look, same meaning. "" = drop the character. */
const EQUIVALENT: Record<number, { to: string; reason: string }> = {
  0x2010: { to: "-", reason: "hyphen → ASCII hyphen" },
  0x2011: { to: "-", reason: "non-breaking hyphen → hyphen" },
  0xfe63: { to: "-", reason: "small hyphen-minus → hyphen" },
  0xff0d: { to: "-", reason: "full-width hyphen-minus → hyphen" },
  0x2012: { to: "–", reason: "figure dash → en dash" },
  0x2015: { to: "—", reason: "horizontal bar → em dash" },
  0x02d7: { to: "−", reason: "modifier minus → minus sign" },
  0x2796: { to: "−", reason: "heavy minus sign → minus sign" },
  0xff0b: { to: "+", reason: "full-width plus → plus" },
  0x2795: { to: "+", reason: "heavy plus sign → plus" },
  0x223c: { to: "~", reason: "tilde operator → tilde" },
  0x2044: { to: "/", reason: "fraction slash → slash" },
  0x2215: { to: "/", reason: "division slash → slash" },
  0xfb01: { to: "fi", reason: "ligature → letters" },
  0xfb02: { to: "fl", reason: "ligature → letters" },
  0x00ad: { to: "", reason: "soft hyphen (invisible) removed" },
  0x2060: { to: "", reason: "word joiner (invisible) removed" },
  0xfeff: { to: "", reason: "zero-width no-break space removed" },
  0x2002: { to: " ", reason: "en space → space" },
  0x2003: { to: " ", reason: "em space → space" },
  0x2004: { to: " ", reason: "special space → space" },
  0x2005: { to: " ", reason: "special space → space" },
  0x2006: { to: " ", reason: "special space → space" },
  0x2007: { to: " ", reason: "figure space → space" },
  0x2008: { to: " ", reason: "punctuation space → space" },
  0x2009: { to: " ", reason: "thin space → space" },
  0x200a: { to: " ", reason: "hair space → space" },
  0x202f: { to: " ", reason: "narrow no-break space → space" },
  0x205f: { to: " ", reason: "math space → space" },
  0x3000: { to: " ", reason: "ideographic space → space" },
  0x2028: { to: " ", reason: "line separator → space" },
};

/** Contextual single-character replacements (meaning kept, notation changes). */
const CONTEXTUAL: Record<number, { to: string; reason: string }> = {
  0x21d2: { to: "→", reason: "double arrow (implies) → arrow" },
  0x27f6: { to: "→", reason: "long arrow → arrow" },
  0x2794: { to: "→", reason: "heavy arrow → arrow" },
  0x27a1: { to: "→", reason: "arrow symbol → arrow" },
  0x21d0: { to: "←", reason: "double arrow → arrow" },
  0x21d4: { to: "↔", reason: "double arrow (if and only if) → two-way arrow" },
};

const SUPERSCRIPT: Record<number, string> = {
  0x2070: "0", 0x00b9: "1", 0x00b2: "2", 0x00b3: "3", 0x2074: "4", 0x2075: "5", 0x2076: "6", 0x2077: "7", 0x2078: "8", 0x2079: "9",
  0x207a: "+", 0x207b: "-", 0x207c: "=", 0x207d: "(", 0x207e: ")", 0x207f: "n", 0x2071: "i",
};
const SUBSCRIPT: Record<number, string> = {
  0x2080: "0", 0x2081: "1", 0x2082: "2", 0x2083: "3", 0x2084: "4", 0x2085: "5", 0x2086: "6", 0x2087: "7", 0x2088: "8", 0x2089: "9",
  0x208a: "+", 0x208b: "-", 0x208c: "=", 0x208d: "(", 0x208e: ")",
};

/** Emoji / pictographs used as decoration at the start of a point ("✅ MRI first"). */
const LEADING_DECORATION = /^(\s*)((?:\p{Extended_Pictographic}|[✓-✘★☆▶►➤])[︎️]?)\s+/u;

const cpOf = (ch: string) => ch.codePointAt(0)!;
const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;

/** "‑" → `"‑" (U+2011)` — readable in messages even when the glyph itself isn't. */
export function describeChar(ch: string): string {
  return `"${ch}" (${hex(cpOf(ch))})`;
}

/**
 * Applies the replacements. `allowContextual` = false (render / save / AI
 * ingestion) changes only equivalent characters; true (Fix actions) also
 * rewrites super/subscripts, arrows and leading decorative emoji.
 */
export function normalizeSlideText(text: string, covered: Coverage, allowContextual = false): NormalizeResult {
  const replacements: TextReplacement[] = [];
  const note = (from: string, to: string, cls: ReplacementClass, reason: string) => {
    if (!replacements.some((r) => r.from === from && r.to === to)) replacements.push({ from, to, cls, reason });
  };
  const drawable = (cp: number) => INVISIBLE.has(cp) || covered(cp);

  let src = text;
  if (allowContextual) {
    // Decorative emoji at the start of each line ("✅ point") — dropped, the text after it is kept.
    src = src
      .split("\n")
      .map((line) => {
        const m = LEADING_DECORATION.exec(line);
        if (!m || drawable(cpOf(m[2]))) return line;
        note(m[2], "", "contextual", "decorative symbol at the start of a point removed");
        return m[1] + line.slice(m[0].length);
      })
      .join("\n");
  }

  const chars = [...src];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = cpOf(ch);
    // Invisible formatting characters are dropped even where a font maps them (Satori may draw a soft hyphen).
    if (EQUIVALENT[cp]?.to === "") {
      note(ch, "", "equivalent", EQUIVALENT[cp].reason);
      continue;
    }
    if (drawable(cp)) {
      // A drawable super/subscript inside a run that needs rewriting is handled with its run below.
      if (!(allowContextual && (cp in SUPERSCRIPT || cp in SUBSCRIPT) && runNeedsRewrite(chars, i, drawable))) {
        out += ch;
        continue;
      }
    }
    const eq = EQUIVALENT[cp];
    if (eq) {
      note(ch, eq.to, "equivalent", eq.reason);
      out += eq.to;
      continue;
    }
    if (!allowContextual) {
      out += ch;
      continue;
    }
    if (cp in SUPERSCRIPT || cp in SUBSCRIPT) {
      const table = cp in SUPERSCRIPT ? SUPERSCRIPT : SUBSCRIPT;
      let j = i;
      let run = "";
      let ascii = "";
      while (j < chars.length && cpOf(chars[j]) in table) {
        run += chars[j];
        ascii += table[cpOf(chars[j])];
        j++;
      }
      const prev = out.slice(-1);
      // 10⁻⁶ / x² / (a+b)³ → an exponent ("^"); Na⁺, Ca²⁺, H₂O → the plain ASCII form.
      const exponent = table === SUPERSCRIPT && /[0-9)\]]/.test(prev) && /[0-9n]/.test(ascii);
      const to = exponent ? `^${ascii.length > 1 && /[^0-9]/.test(ascii.replace(/^-/, "")) ? `(${ascii})` : ascii}` : ascii;
      note(run, to, "contextual", table === SUPERSCRIPT ? (exponent ? "superscript exponent → ^" : "superscript charge/label → plain text") : "subscript → plain digits");
      out += to;
      i = j - 1;
      continue;
    }
    const cx = CONTEXTUAL[cp];
    if (cx && drawable(cpOf(cx.to))) {
      note(ch, cx.to, "contextual", cx.reason);
      out += cx.to;
      continue;
    }
    out += ch;
  }
  const remaining = [...new Set([...out].filter((ch) => !drawable(cpOf(ch))))];
  return { text: out, replacements, remaining };
}

/** A super/subscript run is rewritten as a whole when any character in it can't be drawn (no mixed "C6H₁2"). */
function runNeedsRewrite(chars: string[], i: number, drawable: (cp: number) => boolean): boolean {
  const table = cpOf(chars[i]) in SUPERSCRIPT ? SUPERSCRIPT : SUBSCRIPT;
  let a = i;
  while (a > 0 && cpOf(chars[a - 1]) in table) a--;
  let b = i;
  while (b < chars.length - 1 && cpOf(chars[b + 1]) in table) b++;
  for (let k = a; k <= b; k++) if (!drawable(cpOf(chars[k]))) return true;
  return false;
}

/**
 * Equivalent-only normalization without font data (AI ingestion / Save run
 * where fonts aren't loaded). Every equivalent target is drawable by the
 * bundled fonts, and the characters it replaces are all ones the fonts lack
 * or invisible formatting, so this never changes what a slide shows.
 */
export function normalizeEquivalent(text: string): string {
  let out = "";
  for (const ch of text) {
    const eq = EQUIVALENT[cpOf(ch)];
    out += eq ? eq.to : ch;
  }
  return out;
}

export function hasEquivalentChars(text: string): boolean {
  for (const ch of text) if (EQUIVALENT[cpOf(ch)]) return true;
  return false;
}
