/**
 * Output language for question-level AI (Ask AI explanation, explanation styles, AI Question Variants).
 * Decided from the question's own content, never from the exam name:
 * - the stored text itself is Hindi (Devanagari) → "hi" (a Hindi-only question is never explained in English);
 * - a bilingual question (has `textHi`) viewed in Hindi → "hi";
 * - everything else → "en" (RUHS MO and every English question: unchanged behaviour).
 * The client may only ASK for Hindi; this function is the server-side decision.
 */
export type AiLang = "en" | "hi";

const LETTER = /\p{L}/gu;
const DEVANAGARI_LETTER = /^\p{Script=Devanagari}$/u;

/**
 * True when Devanagari makes up at least 40% of the letters (Hindi text with English technical terms still counts).
 * Vowel signs are marks, not letters, so they are left out of both sides of the ratio.
 */
export function isMostlyHindi(text: string | null | undefined): boolean {
  const letters = text?.match(LETTER) ?? [];
  if (letters.length === 0) return false;
  return letters.filter((c) => DEVANAGARI_LETTER.test(c)).length / letters.length >= 0.4;
}

export function resolveAiLanguage(q: { text: string; textHi?: string | null }, requested: unknown): AiLang {
  if (isMostlyHindi(q.text)) return "hi";
  if (requested === "hi" && typeof q.textHi === "string" && q.textHi.trim().length > 0) return "hi";
  return "en";
}

/** Cache key of a Hindi row in AIExplanationVariant; English keys stay exactly as before (no rewrite of existing rows). */
export const hindiVariantKey = (variantId: string) => `${variantId}@hi`;

/** Appended to a prompt only for Hindi output, so every English prompt stays byte-identical. */
export const HINDI_OUTPUT_INSTRUCTION = `
LANGUAGE: Write EVERY text value in the JSON in standard Hindi (Devanagari script). Keep accepted English scientific, medical and legal technical terms where Hindi-medium exam papers use them (you may add the English term in brackets, e.g. "प्रोटीन (protein)"). Keep the JSON keys and option labels (A, B, C, D) in English exactly as specified. Do not translate or alter numbers, units, chemical formulas or proper nouns. Do not add facts that are not needed to explain the question.`;
