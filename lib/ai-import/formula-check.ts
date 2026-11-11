/**
 * Formula text damage check (pure, no I/O, client-safe). A LaTeX command read with one backslash can turn into a control
 * character (\text → TAB + "ext", \frac → form feed + "rac", \beta → backspace + "eta"); KaTeX renders TAB / line breaks as
 * plain space, so the damage is invisible in the preview (FSO 2019 Q63, Q136, Q139 were approved like that).
 * Control characters are never legitimate question content, so a finding blocks approval until the text is corrected.
 */

// eslint-disable-next-line no-control-regex
const NEVER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ESCAPE: Record<string, string> = { "\t": "t", "\n": "n", "\r": "r", "\f": "f", "\b": "b" };

/** Shows control characters visibly, e.g. "13^{⟨TAB⟩ext{th}}". */
export function showControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]|\t/g, (c) => `⟨${{ "\t": "TAB", "\f": "FF", "\b": "BS", "\r": "CR" }[c] ?? `U+${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`}⟩`);
}

/**
 * Finds damaged spots: any control character other than TAB / line break, and a TAB / line break / CR followed by a letter
 * inside $…$ or $$…$$ maths (a real line break before a word outside maths is kept). Also returns a SUGGESTED repair
 * (control character → backslash + letter), shown to the administrator only — never written automatically.
 */
export function controlCharFindings(text: string): { spots: string[]; suggestion: string | null } {
  const spots: string[] = [];
  let out = "";
  let repairable = true;
  let math: "$" | "$$" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length && !NEVER.test(text[i + 1]) && !ESCAPE[text[i + 1]]) {
      out += c + text[++i]; // an escaped character (\$, \\) never toggles maths
      continue;
    }
    if (c === "$") {
      const d = text[i + 1] === "$" ? "$$" : "$";
      if (!math) math = d;
      else if (math === d) math = null;
      out += d;
      i += d.length - 1;
      continue;
    }
    const nextIsLetter = /[A-Za-z]/.test(text[i + 1] ?? "");
    const whitespaceInMath = (c === "\t" || c === "\n" || c === "\r") && !!math && nextIsLetter;
    if (NEVER.test(c) || whitespaceInMath) {
      spots.push(showControlChars(text.slice(Math.max(0, i - 12), i + 12)));
      if (ESCAPE[c] && nextIsLetter) out += "\\" + ESCAPE[c];
      else repairable = false;
      continue;
    }
    out += c;
  }
  return { spots, suggestion: spots.length && repairable ? out : null };
}

/**
 * Chemistry with unbalanced ( ) or [ ] inside \ce{…} (FSO 2022 Q35: "Na2[Fe(CN)5NO"): mhchem renders it without any error,
 * so nothing else notices. Maths is not checked — half-open intervals like [0, 1) are legitimate there.
 */
export function unbalancedChemistry(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\\ce\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    const c = (ch: string) => m[1].split(ch).length - 1;
    if (c("(") !== c(")") || c("[") !== c("]")) out.push(m[0].slice(0, 60));
  }
  return out;
}
