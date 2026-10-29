import { finding, type LintFinding } from "@/lib/text-lint/types";

/**
 * Checks shared by captions and scripts: invisible / formatting characters, stock "AI-sounding" phrasing,
 * repeated phrases. The phrase list was written for this project (idea credited in
 * docs/ai-video-studio/THIRD-PARTY.md); edit it here.
 */

/** Characters a keyboard does not type and that survive copy-paste invisibly. */
const INVISIBLE: Record<number, string> = {
  0x00ad: "soft hyphen",
  0x061c: "Arabic letter mark",
  0x180e: "Mongolian vowel separator",
  0x200b: "zero-width space",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x2028: "line separator",
  0x2029: "paragraph separator",
  0x202a: "bidi embedding",
  0x202b: "bidi embedding",
  0x202c: "bidi pop",
  0x202d: "bidi override",
  0x202e: "bidi override",
  0x2060: "word joiner",
  0x2061: "invisible function",
  0x2062: "invisible times",
  0x2063: "invisible separator",
  0x2064: "invisible plus",
  0x2066: "bidi isolate",
  0x2067: "bidi isolate",
  0x2068: "bidi isolate",
  0x2069: "bidi isolate",
  0xfeff: "byte-order mark",
};

/**
 * Zero-width joiner / non-joiner are legitimate inside Devanagari conjuncts and emoji sequences, so they are
 * only reported between two Latin characters (or at the edges of a word).
 */
const JOINERS = new Set([0x200c, 0x200d]);

export function invisibleCharacters(text: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  const chars = [...text];
  chars.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    if (INVISIBLE[cp]) out.push({ name: INVISIBLE[cp], index: i });
    else if (cp >= 0xe0000 && cp <= 0xe007f) out.push({ name: "Unicode tag character", index: i });
    else if (JOINERS.has(cp)) {
      const prev = chars[i - 1] ?? " ";
      const next = chars[i + 1] ?? " ";
      if (/[A-Za-z0-9\s]/.test(prev) && /[A-Za-z0-9\s]/.test(next)) out.push({ name: cp === 0x200d ? "zero-width joiner" : "zero-width non-joiner", index: i });
    }
  });
  return out;
}

export function stripInvisible(text: string): string {
  const drop = new Set(invisibleCharacters(text).map((x) => x.index));
  return [...text].filter((_, i) => !drop.has(i)).join("");
}

export function checkInvisible(text: string, code = "INVISIBLE_CHARACTERS"): LintFinding[] {
  const found = invisibleCharacters(text);
  if (!found.length) return [];
  const names = [...new Set(found.map((f) => f.name))];
  return [finding(code, "warning", `${found.length} invisible character(s): ${names.join(", ")}. They are not typed by a keyboard and can break search, captions or line breaks.`, { suggestion: "Remove them (the text looks the same without them).", excerpt: names.join(", ") })];
}

/**
 * Stock phrasing that reads as generic or machine-written in short social and narration copy. Each entry: the
 * pattern, and what to do instead. Matching is case-insensitive on word boundaries.
 */
export const STOCK_PHRASES: { re: RegExp; label: string; instead: string }[] = [
  { re: /\bdelve(s|d)? (into|deeper)\b/i, label: "delve into", instead: "look at / cover" },
  { re: /\bin today'?s (fast[- ]paced|digital|competitive) world\b/i, label: "in today's … world", instead: "cut it; start with the point" },
  { re: /\b(unlock|unleash) (the|your) (full )?(potential|power|secrets?)\b/i, label: "unlock your potential", instead: "say what the reader gets" },
  { re: /\b(game[- ]changer|game[- ]changing)\b/i, label: "game-changer", instead: "say what changes, with a number" },
  { re: /\bembark on (a|this|your) journey\b/i, label: "embark on a journey", instead: "start" },
  { re: /\b(navigat(e|ing)) the (complex|ever[- ]changing|intricate)\b/i, label: "navigate the complex…", instead: "name the actual problem" },
  { re: /\bit'?s (important|worth|crucial) (to note|noting|to remember) that\b/i, label: "it's important to note that", instead: "state the fact directly" },
  { re: /\b(in conclusion|to sum it up|in summary),?/i, label: "in conclusion", instead: "end on the point itself" },
  { re: /\b(seamless(ly)?|robust|cutting[- ]edge|state[- ]of[- ]the[- ]art|revolutioni[sz]e)\b/i, label: "marketing adjective", instead: "a concrete detail" },
  { re: /\b(a testament to|plays a (crucial|pivotal|vital) role)\b/i, label: "a testament to / plays a pivotal role", instead: "say what it does" },
  { re: /\b(tapestry|realm|landscape) of\b/i, label: "tapestry / realm / landscape of", instead: "name the thing" },
  { re: /\blet'?s dive (in|into|right in)\b/i, label: "let's dive in", instead: "cut it" },
  { re: /\bwhether you'?re a (beginner|student|pro)\b/i, label: "whether you're a beginner or…", instead: "talk to one reader" },
  { re: /\bnot (just|only) (a|an|about)\b[^.!?\n]{0,60}\b(it'?s|but)\b/i, label: "not just X, it's Y", instead: "say Y" },
  { re: /\b(stop scrolling|don'?t scroll)\b/i, label: "stop scrolling", instead: "open with the claim instead" },
  { re: /\b(follow for more|smash (that|the) like|tag (a friend|someone) who)\b/i, label: "reflex follow / tag bait", instead: "one specific ask" },
  { re: /\b(in this (video|reel|post),? (i|we)('ll| will| am going to| are going to))\b/i, label: "in this video I will…", instead: "start at the first real sentence" },
  { re: /\b(hello|hi|hey) (everyone|guys|friends|doctors)\b/i, label: "greeting", instead: "start with the hook" },
];

export function checkStockPhrases(text: string, opts: { scene?: number } = {}): LintFinding[] {
  const out: LintFinding[] = [];
  for (const p of STOCK_PHRASES) {
    const m = p.re.exec(text);
    if (m) out.push(finding("STOCK_PHRASE", "info", `Generic phrasing: "${m[0]}".`, { suggestion: p.instead, excerpt: m[0], ...(opts.scene ? { scene: opts.scene } : {}) }));
  }
  return out;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are", "for", "with", "this", "that", "it", "you", "your", "be", "as", "at", "by", "from", "ka", "ki", "ke", "hai", "aur", "se", "me", "mein", "ko"]);

export function wordsOf(text: string): string[] {
  return (text.match(WORD) ?? []).map((w) => w.toLowerCase());
}

/** Phrases of `n` words (not all stop words) that occur more than once. */
export function repeatedPhrases(text: string, n = 3): string[] {
  const w = wordsOf(text);
  const seen = new Map<string, number>();
  for (let i = 0; i + n <= w.length; i++) {
    const gram = w.slice(i, i + n);
    if (gram.every((x) => STOP.has(x) || /^\d+$/.test(x))) continue;
    const k = gram.join(" ");
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const reps = [...seen.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  // Keep the longest distinct ones (a 4-word repeat also yields two 3-word repeats).
  return reps.filter((r) => !reps.some((o) => o !== r && o.includes(r))).slice(0, 5);
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?।])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
