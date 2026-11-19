/**
 * Candidate corrections for review (pure, never applied automatically): page footers left in the text, OCR character
 * confusions and line-break hyphens that an independent second read resolves, and an option that swallowed the next
 * option's label. Every suggestion names its evidence; the administrator decides (2026-11-19 CMS 2023 audit: Q37/Q50
 * "|P.T.O.", Q44 "HbAlc").
 */
import { STRONG_FOOTER } from "@/lib/ai-import/ocr-layout";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

export interface Suggestion {
  field: string;
  from: string;
  to: string;
  kind: "FOOTER" | "OCR_CHAR" | "LINE_HYPHEN" | "OPTION_BOUNDARY";
  reason: string;
}

// OCR confusions, compared after mapping both sides to one canonical form.
const canon = (w: string) => w.replace(/rn/g, "m").replace(/cl/g, "d").replace(/[lI|]/g, "1").replace(/O/g, "0");
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function againstSecond(field: string, from: string, second: string | undefined): Suggestion[] {
  if (!second || from === second) return [];
  // Line-break hyphen: "symp-\ntoms" where the second read has "symptoms".
  const joined = from.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2");
  if (joined !== from && flat(joined) === flat(second)) return [{ field, from, to: joined, kind: "LINE_HYPHEN", reason: "a word broken across lines; the independent second read has it joined" }];
  // OCR character confusion: same token count, every other token equal, differing tokens equal after canon().
  const a = words(from);
  const b = words(second);
  if (a.length !== b.length) return [];
  const diff = a.map((w, i) => [w, b[i]] as const).filter(([x, y]) => x !== y);
  if (!diff.length || !diff.every(([x, y]) => x !== y && canon(x) === canon(y))) return [];
  let to = from;
  for (const [x, y] of diff) to = to.replace(x, y);
  return [{ field, from, to, kind: "OCR_CHAR", reason: `OCR character confusion (${diff.map(([x, y]) => `${x} → ${y}`).join(", ")}); the independent second read has the corrected word` }];
}

export function suggestCorrections(stored: Pick<ExtractedQuestion, "stem" | "options">, second?: { stem?: string; options?: string[] } | null): Suggestion[] {
  const out: Suggestion[] = [];
  const fields: [string, string, string | undefined][] = [["stem", stored.stem, second?.stem], ...stored.options.map((o, i): [string, string, string | undefined] => [`option ${o.label}`, o.text, second?.options?.[i]])];
  for (const [field, text, other] of fields) {
    const lines = text.split("\n");
    const kept = lines.filter((l) => !STRONG_FOOTER(l.trim()) || !l.trim());
    if (kept.length !== lines.length) {
      out.push({ field, from: text, to: kept.join("\n").trim(), kind: "FOOTER", reason: `page header/footer line read into the text (${lines.filter((l) => l.trim() && STRONG_FOOTER(l.trim())).join(", ")})` });
      continue;
    }
    out.push(...againstSecond(field, text, other));
    // An option that contains the next option's printed label mid-text: two options merged (report only).
    if (field.startsWith("option ")) {
      const m = /\s\(?([b-d])\)\s+\S/i.exec(text);
      if (m && text.indexOf(m[0]) > 0) out.push({ field, from: text, to: `${text.slice(0, m.index).trim()} | ${text.slice(m.index).trim()}`, kind: "OPTION_BOUNDARY", reason: `the option contains the label “${m[1]})” of another option — two options may be merged; split it by hand` });
    }
  }
  return out;
}
