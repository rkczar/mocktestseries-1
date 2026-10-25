import type { Language } from "@/lib/video-studio/types";

/**
 * Script-aware text helpers for Hindi (Devanagari), English and Hinglish.
 *
 * Never count characters with `.length` or split with `[A-Za-z]` regexes: a
 * Devanagari conjunct such as "क्ष" or "श्रृं" is several code points but ONE
 * user-perceived character (grapheme cluster), and splitting inside it breaks
 * the rendering. Everything here goes through Intl.Segmenter (grapheme / word),
 * which Node 24 and every current browser ship.
 */

const graphemeSeg = new Intl.Segmenter("hi", { granularity: "grapheme" });
const wordSeg = new Intl.Segmenter("hi", { granularity: "word" });

const DEVANAGARI = /\p{Script=Devanagari}/u;
const LATIN = /\p{Script=Latin}/u;

export function graphemes(text: string): string[] {
  return Array.from(graphemeSeg.segment(text), (s) => s.segment);
}

export function graphemeCount(text: string): number {
  return Array.from(graphemeSeg.segment(text)).length;
}

/** Word-like tokens (Devanagari words keep their matras and conjuncts intact). */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const s of wordSeg.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

export function wordCount(text: string): number {
  return words(text).length;
}

/** Which writing systems a text uses (letters only; digits and punctuation are neutral). */
export function scriptMix(text: string): "devanagari" | "latin" | "mixed" | "none" {
  let dev = 0;
  let lat = 0;
  for (const ch of text) {
    if (DEVANAGARI.test(ch)) dev++;
    else if (LATIN.test(ch)) lat++;
  }
  if (!dev && !lat) return "none";
  if (dev && lat) return dev / (dev + lat) > 0.9 || lat / (dev + lat) > 0.9 ? (dev > lat ? "devanagari" : "latin") : "mixed";
  return dev ? "devanagari" : "latin";
}

/**
 * Planning speaking rates (words per minute) used ONLY to plan scene lengths
 * before any audio exists. They are estimates; once narration audio exists
 * the measured audio duration replaces them.
 */
export const PLANNING_WPM: Record<Language, number> = { en: 150, hi: 135, hinglish: 140 };

export function estimateSpeechSec(text: string, language: Language): number {
  const n = wordCount(text);
  if (!n) return 0;
  // Sentence-final punctuation adds a short natural pause.
  const pauses = (text.match(/[.!?।॥]/g) ?? []).length * 0.25;
  return Math.round(((n / PLANNING_WPM[language]) * 60 + pauses) * 10) / 10;
}

/**
 * Splits narration into subtitle lines of at most `maxGraphemes` user-perceived
 * characters, breaking only between words (never inside a conjunct or a
 * Latin word). A single word longer than the limit stays whole on its own line.
 */
export function subtitleLines(text: string, maxGraphemes = 32): string[] {
  const lines: string[] = [];
  let line = "";
  for (const s of wordSeg.segment(text.replace(/\s+/g, " ").trim())) {
    const piece = s.segment;
    const candidate = line + piece;
    if (graphemeCount(candidate.trim()) > maxGraphemes && line.trim()) {
      lines.push(line.trim());
      line = piece.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

/**
 * Times subtitle lines across a scene, proportional to each line's word count.
 * This is planning timing: when word-level timestamps or a validated
 * alignment exist, they replace it (see the sync notes in docs).
 */
export function timeCues(lines: string[], startSec: number, durationSec: number): SubtitleCue[] {
  const weights = lines.map((l) => Math.max(1, wordCount(l)));
  const total = weights.reduce((a, b) => a + b, 0);
  const cues: SubtitleCue[] = [];
  let t = startSec;
  lines.forEach((text, i) => {
    const d = (durationSec * weights[i]) / total;
    cues.push({ startSec: Math.round(t * 1000) / 1000, endSec: Math.round((t + d) * 1000) / 1000, text });
    t += d;
  });
  return cues;
}
