import { checkInvisible, checkStockPhrases, repeatedPhrases, wordsOf } from "@/lib/text-lint/common";
import { finding, type LintFinding } from "@/lib/text-lint/types";
import { ASKS } from "@/lib/text-lint/caption";

/**
 * Video-script lint — the checks lib/video-studio/quality.ts checkScript does NOT already make
 * (that one owns: duration vs target, scene length, on-screen overflow, glyphs, language/script mix, hook score).
 * Here: introductory filler, repeated wording, call-to-action placement, absolute/guarantee claims,
 * pronunciation-sensitive terms, numbers/doses/units that are not in the source material, and on-screen text
 * that the narration never says. Heuristics only — never proof of factual accuracy.
 */

export interface ScriptLintScene {
  narration: string;
  onScreenText?: string;
}

export interface ScriptLintOptions {
  /** Trusted material the script was written from (question, options, explanation, PDF text, topic brief). */
  sourceText?: string;
}

const FILLER = [
  /^\s*(hello|hi|hey|namaste|namaskar)\b/i,
  /^\s*(welcome (back )?to|in (this|today'?s) (video|reel|lecture|session))\b/i,
  /^\s*(so,? )?(today|aaj) (we|hum)\b/i,
  /^\s*(before (we|i) (start|begin)|don'?t forget to (like|subscribe))\b/i,
  /^\s*(namaste|hello) (doston|friends|doctors|everyone)\b/i,
];
const ABSOLUTE = [
  { re: /\b(guaranteed?|100\s?%\s*(sure|cure|effective|success)|sure[- ]?shot|never fails|always works|definitely (comes|asked))\b/i, why: "guarantee" },
  { re: /\b(cures?|cured) (all|every|completely)\b/i, why: "absolute cure claim" },
  { re: /\b(the only|the best) (drug|treatment|cure|test|way)\b/i, why: "absolute superlative" },
];
/** Numbers with an optional clinical unit (dose, rate, percentage, interval). */
const NUMBER = /(\d+(?:[.,]\d+)?)\s*(mg\/kg|mcg|µg|mg|g\/dl|g|ml|mL|l|IU|units?|mmhg|mm\s?hg|bpm|%|mmol\/l|mEq\/l|kg|hours?|hrs?|days?|weeks?|years?|times?)?/gi;
/** Abbreviations / formulae a voice may read letter by letter or wrongly. */
const PRONOUNCE = /\b([A-Z]{2,6}\d?|[A-Z][a-z]?\d+[A-Za-z]*|\d+[a-z]+\/[a-z]+|mg\/kg|mcg|µg|i\.v\.|i\.m\.|s\.c\.|b\.i\.d\.|t\.i\.d\.|q\.i\.d\.)\b/g;
const PRONOUNCE_IGNORE = new Set(["MCQ", "NEET", "PG", "FMGE", "INI", "CET", "AIIMS", "RUHS", "MO", "UPSC", "CMS", "MBBS", "OK", "TV", "AI"]);

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NUMBER)) {
    const n = m[1].replace(",", ".");
    out.add(`${n}${(m[2] ?? "").toLowerCase().replace(/\s/g, "")}`);
    out.add(n);
  }
  return out;
}

export function lintScript(scenes: ScriptLintScene[], opts: ScriptLintOptions = {}): LintFinding[] {
  const out: LintFinding[] = [];
  if (!scenes.length) return out;
  const all = scenes.map((s) => s.narration).join("\n");

  // Filler at the very start.
  const opening = scenes[0].narration;
  if (FILLER.some((re) => re.test(opening))) out.push(finding("SCRIPT_INTRO_FILLER", "warning", "The video opens with a greeting or announcement instead of the point.", { suggestion: "Start with the claim, the question or the case.", excerpt: opening.slice(0, 60), scene: 1 }));

  // Repetition across the script.
  const reps = repeatedPhrases(all, 4);
  if (reps.length) out.push(finding("SCRIPT_REPEATED_PHRASE", "info", `Repeated wording across scenes: "${reps.join('", "')}".`, { suggestion: "Say it once, or vary it on purpose." }));

  // Call to action placement.
  const askScenes = scenes.map((s, i) => (ASKS.some((a) => a.re.test(s.narration)) ? i : -1)).filter((i) => i >= 0);
  if (askScenes.length && askScenes[0] < Math.max(1, scenes.length - 2)) {
    out.push(finding("SCRIPT_EARLY_CTA", "warning", `A call to action appears in scene ${askScenes[0] + 1} of ${scenes.length} — before the content has been delivered.`, { suggestion: "Move the ask to the final scene.", scene: askScenes[0] + 1 }));
  }
  if (askScenes.length > 2) out.push(finding("SCRIPT_MANY_CTAS", "info", `${askScenes.length} scenes contain an ask.`, { suggestion: "One ask, at the end." }));

  scenes.forEach((s, i) => {
    const scene = i + 1;
    for (const a of ABSOLUTE) {
      const m = a.re.exec(s.narration);
      if (m) out.push(finding("SCRIPT_ABSOLUTE_CLAIM", "warning", `Scene ${scene}: ${a.why} ("${m[0]}") — needs evidence or softer wording.`, { scene, excerpt: m[0] }));
    }
    const terms = [...new Set([...s.narration.matchAll(PRONOUNCE)].map((m) => m[1]).filter((t) => !PRONOUNCE_IGNORE.has(t)))];
    if (terms.length) out.push(finding("SCRIPT_PRONUNCIATION", "info", `Scene ${scene}: check how the voice reads ${terms.slice(0, 6).join(", ")}.`, { suggestion: "Spell out abbreviations or units the way they should be spoken (e.g. 'milligrams per kilogram').", scene, excerpt: terms.join(", ") }));
    if (s.onScreenText?.trim()) {
      const said = new Set(wordsOf(s.narration));
      const shown = wordsOf(s.onScreenText).filter((w) => w.length > 3 && !/^\d/.test(w));
      const unsaid = shown.filter((w) => !said.has(w));
      if (shown.length >= 2 && unsaid.length / shown.length > 0.75) {
        out.push(finding("SCRIPT_SCREEN_MISMATCH", "info", `Scene ${scene}: the on-screen text is not what the narration says.`, { suggestion: "Show a key word from the narration so eyes and ears agree.", scene, excerpt: s.onScreenText.slice(0, 60) }));
      }
    }
    out.push(...checkInvisible(`${s.narration} ${s.onScreenText ?? ""}`, "SCRIPT_INVISIBLE_CHARACTERS").map((f) => ({ ...f, scene })));
    out.push(...checkStockPhrases(s.narration, { scene }));
  });

  // Numbers, doses and units that the source never mentions (possible changed or invented values).
  if (opts.sourceText?.trim()) {
    const known = numbersIn(opts.sourceText);
    scenes.forEach((s, i) => {
      const novel = [...s.narration.matchAll(NUMBER)]
        .filter((m) => m[2] || Number(m[1].replace(",", ".")) > 10)
        .map((m) => `${m[1].replace(",", ".")}${(m[2] ?? "").toLowerCase().replace(/\s/g, "")}`)
        .filter((n) => !known.has(n));
      if (novel.length) {
        out.push(finding("SCRIPT_NUMBER_NOT_IN_SOURCE", "warning", `Scene ${i + 1}: ${[...new Set(novel)].slice(0, 5).join(", ")} does not appear in the source material — check the value, dose or unit.`, { scene: i + 1, excerpt: novel.join(", ") }));
      }
    });
  }
  return out;
}
