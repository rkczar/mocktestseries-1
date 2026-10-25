import type { Language } from "@/lib/video-studio/types";
import "server-only";
import { estimateSpeechSec, graphemeCount, scriptMix, wordCount, words } from "@/lib/video-studio/text";
import { unsupportedVideoChars } from "@/lib/video-studio/glyphs";

/**
 * Hook Scorer and Video Quality Checker — deterministic, free, run before any
 * paid step. Works on Devanagari, Latin and mixed (Hinglish) text: tokens come
 * from Intl.Segmenter (lib/video-studio/text.ts), never from Latin-only regexes.
 * Original implementation for this project (ideas, not code, from the MIT
 * instagram-agent-skill `hookscore.py` / `beats.py`).
 */

export interface HookScore {
  score: number;
  verdict: "strong" | "ok" | "weak";
  flags: string[];
}

// `\b` is ASCII-only even with /u (Devanagari letters count as \W), so word ends are explicit lookaheads.
const GREETING = /^\s*(?:hi|hello|hey|namaste|namaskar|welcome|नमस्ते|नमस्कार|हेलो|हाय|स्वागत)(?=[\s,.!?।]|$)/iu;
const META = /(in (?:this|today'?s) (?:video|reel)|is video mein|इस वीडियो में|आज के वीडियो|aaj (?:ke|hum)|आज हम|i(?:'| a)m going to|let me tell you|chaliye shuru|चलिए शुरू)/iu;
const DIRECT = /\b(?:you|your|aap|aapko|aapka|tum|tumhe|tumhara)\b|(?:आप|आपको|आपका|तुम|तुम्हें|तुम्हारा)/iu;
const DIGIT = /[0-9०-९]/u;

/** Spoken-hook limits per language: words that fit in ~3 seconds of natural speech. */
const HOOK_MAX_WORDS: Record<Language, number> = { en: 12, hi: 10, hinglish: 11 };

export function scoreHook(text: string, language: Language): HookScore {
  const flags: string[] = [];
  const t = text.trim();
  const n = wordCount(t);
  let score = 60;
  if (!n) return { score: 0, verdict: "weak", flags: ["The hook is empty."] };
  if (GREETING.test(t)) {
    score -= 30;
    flags.push("Opens with a greeting — start with the clue, fact or question instead.");
  }
  if (META.test(t)) {
    score -= 20;
    flags.push("Talks about the video ('in this video…') instead of the topic.");
  }
  const max = HOOK_MAX_WORDS[language];
  if (n > max) {
    score -= Math.min(30, (n - max) * 5);
    flags.push(`${n} words — a hook should fit in about 3 seconds (≤ ${max} words).`);
  } else if (n >= 4) score += 10;
  if (/[?？]/.test(t)) score += 10;
  if (DIGIT.test(t)) score += 10;
  if (DIRECT.test(t)) score += 10;
  const first = words(t)[0]?.toLowerCase();
  if (first === "i" || first === "मैं" || first === "main") {
    score -= 10;
    flags.push("Starts with 'I' — lead with the viewer or the fact.");
  }
  score = Math.max(0, Math.min(100, score));
  return { score, verdict: score >= 70 ? "strong" : score >= 50 ? "ok" : "weak", flags };
}

export interface CheckScene {
  narration: string;
  onScreenText: string;
  needsReview?: boolean;
}

export interface QualityReport {
  ok: boolean;
  estimatedSec: number;
  targetSec: number;
  hook: HookScore | null;
  /** Blocking problems (the job cannot continue until fixed). */
  errors: string[];
  /** Advisory problems (shown, not blocking). */
  warnings: string[];
  perScene: { index: number; estimatedSec: number; flags: string[] }[];
}

export const MAX_SCENE_SEC = 12;
export const ON_SCREEN_MAX_WORDS = 6;
/** Total length must land within ±20 % of the target (planning estimate). */
export const DURATION_TOLERANCE = 0.2;

export function checkScript(scenes: CheckScene[], language: Language, targetSec: number): QualityReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const perScene: QualityReport["perScene"] = [];
  let total = 0;
  if (!scenes.length) errors.push("The script has no scenes.");
  scenes.forEach((s, i) => {
    const flags: string[] = [];
    const sec = estimateSpeechSec(s.narration, language);
    total += Math.max(sec, 1.5);
    if (!s.narration.trim()) flags.push("No narration.");
    if (sec > MAX_SCENE_SEC) flags.push(`About ${sec}s of speech — split this scene (≤ ${MAX_SCENE_SEC}s keeps the frame changing).`);
    if (wordCount(s.onScreenText) > ON_SCREEN_MAX_WORDS) flags.push(`On-screen text has ${wordCount(s.onScreenText)} words (≤ ${ON_SCREEN_MAX_WORDS} reads at a glance).`);
    if (graphemeCount(s.onScreenText) > 60) flags.push("On-screen text is too long to read on a phone.");
    const bad = unsupportedVideoChars(`${s.narration} ${s.onScreenText}`);
    if (bad.length) errors.push(`Scene ${i + 1}: characters the video fonts cannot draw: ${bad.slice(0, 6).join(" ")}`);
    if (s.needsReview) warnings.push(`Scene ${i + 1} is flagged for medical review.`);
    if (language !== "en" && scriptMix(s.narration) === "latin" && wordCount(s.narration) > 4) flags.push("Narration is all in Latin script — Hindi should be written in Devanagari for a correct voice.");
    perScene.push({ index: i, estimatedSec: sec, flags });
    if (flags.some((f) => f === "No narration.")) errors.push(`Scene ${i + 1} has no narration.`);
  });
  const hook = scenes[0] ? scoreHook(scenes[0].narration, language) : null;
  if (hook && hook.verdict === "weak") warnings.push(`Weak hook (${hook.score}/100): ${hook.flags.join(" ")}`);
  total = Math.round(total * 10) / 10;
  if (scenes.length && Math.abs(total - targetSec) > targetSec * DURATION_TOLERANCE) {
    warnings.push(`Estimated length ${total}s vs target ${targetSec}s (more than ±${DURATION_TOLERANCE * 100}%).`);
  }
  for (const p of perScene) for (const f of p.flags) if (f !== "No narration.") warnings.push(`Scene ${p.index + 1}: ${f}`);
  return { ok: errors.length === 0, estimatedSec: total, targetSec, hook, errors, warnings, perScene };
}
