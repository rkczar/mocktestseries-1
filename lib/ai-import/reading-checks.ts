import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Near-empty / incomplete page readings — pure functions (no server imports), tested in
 * scripts/verify-ai-import-reading-checks.ts.
 *
 * 2026-11-11 (FSO real-paper run): 7 of 64 scanned pages came back "successful" with ~70 output tokens — one question,
 * one option, the model's own thinking in the option label ("(1 Supplementary ? No, wait: (1))", "(1b?)" → "Wait").
 * Nothing caught it; 31 question numbers were missing until the pages were read again. Such a reading is never
 * accepted: the page is read again (bounded), and sent to review if it stays incomplete.
 */

/** A printed option label: (1) 1. A) (a) i) … — short, no words, no question marks. */
const LABEL = /^[([]?\s*(?:[0-9]{1,2}|[A-Ea-e]|[ivx]{1,4})\s*[)\].:]?$/;
const PLACEHOLDER = /^[\s.…?_\-–]*$/;
/** Words of a model "thinking aloud" inside a JSON value. */
const THINKING = /\b(wait|let me|let's|actually|hmm|no,|i think|format options|in image|->)\b|->/i;

/** Why one question of a reading is degenerate, or null. Continuations across pages may legitimately be partial. */
export function degenerateQuestion(q: Pick<ExtractedQuestion, "number" | "stem" | "options" | "continuedFromPreviousPage" | "continuesOnNextPage">): string | null {
  if (q.continuedFromPreviousPage || q.continuesOnNextPage) return null;
  const opts = q.options ?? [];
  const bad = opts.filter((o) => {
    const label = (o.printed ?? o.label ?? "").trim();
    return (label && (!LABEL.test(label) || THINKING.test(label))) || PLACEHOLDER.test(o.text ?? "") || THINKING.test(o.text ?? "");
  });
  if (opts.length === 1 && bad.length) return `Q${q.number ?? "?"}: one option only, and it is not a printed option ("${(opts[0].printed ?? opts[0].label ?? "").slice(0, 40)}" = "${(opts[0].text ?? "").slice(0, 30)}")`;
  if (opts.length >= 1 && bad.length === opts.length && opts.every((o) => PLACEHOLDER.test(o.text ?? ""))) return `Q${q.number ?? "?"}: every option is empty`;
  if (THINKING.test(q.stem ?? "") && /\bwait\b/i.test(q.stem ?? "")) return `Q${q.number ?? "?"}: the question text contains the model's own notes`;
  return null;
}

/** The reading of one page is incomplete (not to be accepted as processed) — the reasons, or [] when it is fine. */
export function incompleteReading(questions: Parameters<typeof degenerateQuestion>[0][]): string[] {
  return questions.map(degenerateQuestion).filter((x): x is string => !!x);
}

/**
 * Question numbers missing between pages after every page of a file was read: for each missing number, the page(s)
 * where it must be printed (between the page of the nearest lower and the nearest higher number found). Pages are
 * returned with the numbers they should hold. `expected` bounds the trailing range (null = only inner gaps).
 */
export function gapPages(found: { number: number; pages: number[] }[], expected: number | null, pageCount: number): Map<number, number[]> {
  const pagesOf = new Map<number, number[]>();
  for (const f of found) pagesOf.set(f.number, [...(pagesOf.get(f.number) ?? []), ...f.pages]);
  const nums = [...pagesOf.keys()].sort((a, b) => a - b);
  if (!nums.length) return new Map();
  const last = expected ?? nums[nums.length - 1];
  const out = new Map<number, number[]>();
  for (let n = 1; n <= last; n++) {
    if (pagesOf.has(n)) continue;
    const lower = nums.filter((x) => x < n).pop();
    const higher = nums.find((x) => x > n);
    const from = lower !== undefined ? Math.max(...pagesOf.get(lower)!) : 1;
    const to = Math.min(higher !== undefined ? Math.min(...pagesOf.get(higher)!) : pageCount, pageCount);
    // Pages strictly between hold nothing found yet: the number is there. Otherwise it is at the end of `from` or the
    // start of `to`: the one of the two with fewer questions read (both on a tie) — a full page is not read again.
    const between = Array.from({ length: Math.max(0, to - from - 1) }, (_, k) => from + k + 1);
    const count = (p: number) => found.filter((f) => f.pages.includes(p)).length;
    const pick = between.length ? between : from === to ? [from] : count(from) < count(to) ? [from] : count(to) < count(from) ? [to] : [from, to];
    for (const p of pick) out.set(p, [...(out.get(p) ?? []), n]);
  }
  return out;
}
