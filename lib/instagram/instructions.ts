import { CONTENT_FIELDS, MODULE_FIELDS, TEMPLATE_KEYS, type ContentField, type PostDesign, type SlideModule, type TemplateKey } from "@/lib/instagram/types";

/**
 * Routes an admin's free-text edit instruction (Hindi or English, Roman or
 * Devanagari) to the cheapest correct action:
 *  - layout requests (font size, theme/background, slide count) are applied
 *    to the design directly — no AI call, no content change;
 *  - everything else regenerates ONLY the content fields it names (or the
 *    fields of the selected slide), never the whole post.
 */

export interface LayoutChange {
  patch: Partial<PostDesign>;
  summary: string;
}

const has = (t: string, words: string[]) => words.some((w) => t.includes(w));

const BIGGER = ["increase", "bigger", "larger", "enlarge", "bada", "badha", "zyada bada", "बड़ा", "बढ़ा"];
const SMALLER = ["decrease", "smaller", "reduce", "shrink", "chhota", "chota", "kam karo", "छोटा", "घटा"];
const SIZE_WORDS = ["font", "size", "text size", "akshar", "अक्षर", "फ़ॉन्ट", "फॉन्ट", "साइज"];
const QUESTION_WORDS = ["question", "option", "prashn", "sawal", "सवाल", "प्रश्न"];
const THEME_WORDS = ["background", "theme", "template", "colour", "color", "rang", "रंग", "बैकग्राउंड", "थीम"];

const THEME_HINTS: [TemplateKey, string[]][] = [
  ["academic", ["light", "white", "academic", "safed", "सफेद"]],
  ["clinical", ["clinical", "teal", "green", "hara", "हरा"]],
  ["premium", ["premium", "gold", "golden", "sunehra"]],
  ["midnight", ["midnight", "black", "dark", "default", "website", "kala", "काला"]],
];

export function parseLayoutInstruction(instruction: string, design: PostDesign): LayoutChange | null {
  const t = instruction.toLowerCase();
  if (has(t, SIZE_WORDS) && (has(t, BIGGER) || has(t, SMALLER))) {
    const delta = has(t, BIGGER) ? 0.1 : -0.1;
    const clamp = (n: number) => Math.round(Math.min(1.25, Math.max(0.85, n + delta)) * 100) / 100;
    if (has(t, QUESTION_WORDS)) {
      return { patch: { questionScale: clamp(design.questionScale) }, summary: `Question text size ${delta > 0 ? "increased" : "reduced"}.` };
    }
    return {
      patch: { questionScale: clamp(design.questionScale), bodyScale: clamp(design.bodyScale) },
      summary: `Text size ${delta > 0 ? "increased" : "reduced"} on all slides.`,
    };
  }
  if (has(t, THEME_WORDS)) {
    for (const [key, words] of THEME_HINTS) {
      if (has(t, words) && (TEMPLATE_KEYS as readonly string[]).includes(key)) {
        return { patch: { template: key }, summary: `Template changed to ${key}. Brand header and footer are unchanged.` };
      }
    }
    // Backgrounds are limited to the four brand templates, so pick the next one.
    const order = TEMPLATE_KEYS as readonly TemplateKey[];
    const next = order[(order.indexOf(design.template) + 1) % order.length];
    return { patch: { template: next }, summary: `Background changed to the ${next} template (backgrounds are limited to the brand templates).` };
  }
  return null;
}

const FIELD_HINTS: [ContentField, string[]][] = [
  ["hooks", ["hook", "headline", "title", "heading", "attractive", "catchy", "हुक"]],
  ["memoryTrick", ["trick", "mnemonic", "yaad", "trik", "memory", "याद", "ट्रिक"]],
  ["explanation", ["explanation", "explain", "samjha", "vyakhya", "simpler", "simple", "आसान", "समझा", "व्याख्या"]],
  ["clinicalPearl", ["pearl", "clinical", "high-yield", "high yield"]],
  ["quickRevision", ["revision", "summary", "points", "रिवीजन"]],
  ["caption", ["caption", "कैप्शन"]],
  ["hashtags", ["hashtag", "tags", "#"]],
  ["finalTrick", ["final slide", "last slide", "closing line"]],
];

/** Content fields an instruction targets; falls back to the selected slide's fields, then to all. */
export function targetFields(instruction: string, selectedModule: SlideModule | null): ContentField[] {
  const t = instruction.toLowerCase();
  const hits = FIELD_HINTS.filter(([, words]) => has(t, words)).map(([f]) => f);
  if (hits.length) return [...new Set(hits)];
  if (selectedModule) return MODULE_FIELDS[selectedModule];
  return [...CONTENT_FIELDS];
}
