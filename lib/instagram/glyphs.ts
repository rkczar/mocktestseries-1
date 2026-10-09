import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which characters the slide fonts can draw. Satori asks the network
 * (Google Fonts / an emoji CDN) for any glyph its loaded fonts lack, so the
 * renderer must never be handed such a character: the quality gate blocks
 * them (UNSUPPORTED_CHARACTERS) and the preview shows "□" in their place.
 * Coverage = Geist (brand font) + Liberation Sans (bundled OFL fallback for
 * Greek and other symbols), read from the fonts' own cmap tables.
 */

export const FONT_FILES = {
  geistBold: "lib/og/fonts/Geist-Bold.ttf",
  geistMedium: "lib/og/fonts/Geist-Medium.ttf",
  fallbackBold: "lib/instagram/fonts/LiberationSans-Bold.ttf",
  fallbackRegular: "lib/instagram/fonts/LiberationSans-Regular.ttf",
} as const;

/** Code points mapped by a TrueType font's cmap (formats 4 and 12). */
export function cmapCodePoints(font: Buffer): Set<number> {
  const out = new Set<number>();
  const numTables = font.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    if (font.toString("latin1", rec, rec + 4) === "cmap") cmap = font.readUInt32BE(rec + 8);
  }
  if (cmap < 0) return out;
  const subtables = font.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const start = cmap + font.readUInt32BE(cmap + 4 + 8 * i + 4);
    const format = font.readUInt16BE(start);
    if (format === 4) {
      const segX2 = font.readUInt16BE(start + 6);
      for (let s = 0; s < segX2 / 2; s++) {
        const end = font.readUInt16BE(start + 14 + 2 * s);
        const begin = font.readUInt16BE(start + 16 + segX2 + 2 * s);
        if (begin === 0xffff) continue;
        for (let c = begin; c <= end; c++) out.add(c);
      }
    } else if (format === 12) {
      const groups = font.readUInt32BE(start + 12);
      for (let g = 0; g < groups; g++) {
        const at = start + 16 + 12 * g;
        const begin = font.readUInt32BE(at);
        const end = font.readUInt32BE(at + 4);
        for (let c = begin; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

let coverage: Set<number> | null = null;

function covered(): Set<number> {
  if (coverage) return coverage;
  const sets = Object.values(FONT_FILES).map((f) => cmapCodePoints(readFileSync(path.join(process.cwd(), f))));
  // A character must be drawable at both weights in at least one family.
  const both = (a: Set<number>, b: Set<number>) => new Set([...a].filter((c) => b.has(c)));
  const geist = both(sets[0], sets[1]);
  const fallback = both(sets[2], sets[3]);
  coverage = new Set([...geist, ...fallback]);
  return coverage;
}

/** Whitespace / joiners that are never drawn. */
const INVISIBLE = new Set([0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f]);

/** Distinct characters in `text` that no slide font can draw (e.g. emoji, superscript ⁺). */
export function unsupportedChars(text: string): string[] {
  const cov = covered();
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!INVISIBLE.has(cp) && !cov.has(cp)) bad.add(ch);
  }
  return [...bad];
}

/** Text safe to hand to Satori: undrawable characters become "□" (the post can't be approved while they exist). */
export function renderable(text: string): string {
  const cov = covered();
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x200d) continue;
    out += INVISIBLE.has(cp) || cov.has(cp) ? ch : "□";
  }
  return out;
}
