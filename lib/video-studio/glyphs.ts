import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cmapCodePoints } from "@/lib/instagram/glyphs";
import { FONT_FILES } from "@/lib/video-studio/template";
import { graphemes } from "@/lib/video-studio/text";

/**
 * Which characters the bundled video fonts can draw, read from the fonts' own
 * cmap tables (same approach as the Instagram slide renderer). A character
 * no bundled font covers would fall back to whatever font the render
 * container has — or a blank box — so the script check refuses it instead.
 * Coverage = Geist ∪ Noto Sans Devanagari ∪ Liberation Sans (each at both weights).
 */

const FONT_DIR = path.join(process.cwd(), "public/video-studio/fonts");
const INVISIBLE = new Set([0x09, 0x0a, 0x0d, 0x20, 0xa0, 0x200b, 0x200c, 0x200d, 0xfe0e, 0xfe0f]);

let coverage: Set<number> | null = null;

function covered(): Set<number> {
  if (coverage) return coverage;
  const both = (a: string, b: string) => {
    const x = cmapCodePoints(readFileSync(path.join(FONT_DIR, a)));
    const y = cmapCodePoints(readFileSync(path.join(FONT_DIR, b)));
    return [...x].filter((c) => y.has(c));
  };
  coverage = new Set([
    ...both(FONT_FILES.latinMedium, FONT_FILES.latinBold),
    ...both(FONT_FILES.devRegular, FONT_FILES.devBold),
    ...both(FONT_FILES.fallbackRegular, FONT_FILES.fallbackBold),
  ]);
  return coverage;
}

/** Distinct graphemes containing a character no bundled video font can draw (emoji, rare symbols…). */
export function unsupportedVideoChars(text: string): string[] {
  const cov = covered();
  const bad = new Set<string>();
  for (const g of graphemes(text)) {
    for (const ch of g) {
      const cp = ch.codePointAt(0)!;
      if (!INVISIBLE.has(cp) && !cov.has(cp)) {
        bad.add(g);
        break;
      }
    }
  }
  return [...bad];
}
