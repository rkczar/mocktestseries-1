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

/**
 * Options a reader put inside the question text (or one "option" holding the whole list) — 2026-11-15, CMS 2026 Paper II:
 * gemma-3-4b returned "(a) 1, 2 and 3" as the only option of Q35/Q39/Q81 and the page failed three times. The labelled
 * options are taken from the text only when the boundaries are unambiguous: markers (a)…(d) (or (a)…(e)), each once, in
 * order, each at a line start or after a space. OCR's "(α)" for "(a)" is accepted as the first marker. Otherwise null:
 * nothing is guessed.
 */
export function optionsFromText(text: string): { stem: string; options: { label: string; printed: string; text: string }[] } | null {
  const re = /(^|\s)\(\s*([a-eα])\s*\)\s*/gm;
  const marks = [...text.matchAll(re)].map((m) => ({ at: m.index! + m[1].length, end: m.index! + m[0].length, label: m[2] === "α" ? "a" : m[2] }));
  const start = marks.findIndex((m, i) => m.label === "a" && marks.slice(i, i + 4).map((x) => x.label).join("") === "abcd");
  if (start < 0) return null;
  const run = marks.slice(start);
  // Exactly one a–d (or a–e) run after the first (a): a repeated or out-of-order marker is ambiguous.
  const labels = run.map((m) => m.label).join("");
  if (labels !== "abcd" && labels !== "abcde") return null;
  const options = run.map((m, i) => ({ label: m.label.toUpperCase(), printed: `(${m.label})`, text: text.slice(m.end, i + 1 < run.length ? run[i + 1].at : undefined).trim() }));
  if (options.some((o) => !o.text || o.text.length > 400)) return null;
  return { stem: text.slice(0, run[0].at).trim(), options };
}

/**
 * Repairs the questions of one reading whose options are degenerate (one option only / all empty): from the question's
 * own text first, else from the page's local OCR reading of the same question number (`ocrText`). A question that cannot
 * be repaired is returned unchanged (still degenerate). Never adds an option that is not printed in the text.
 */
export function repairDegenerateOptions<T extends Pick<ExtractedQuestion, "number" | "stem" | "options" | "continuedFromPreviousPage" | "continuesOnNextPage"> & { notes?: string[]; confidence?: number }>(questions: T[], ocrText: (n: number | null) => string | null): T[] {
  return questions.map((q) => {
    if (!degenerateQuestion(q) || /own notes/.test(degenerateQuestion(q)!)) return q;
    const inline = [q.stem, ...q.options.map((o) => `${o.printed ?? o.label ?? ""} ${o.text ?? ""}`)].join("\n");
    const own = optionsFromText(q.stem ?? "") ?? optionsFromText(inline);
    const ocr = own ? null : ocrText(q.number);
    const fromOcr = ocr ? optionsFromText(ocr.replace(/^\s*\d{1,3}\s*[.)]\s*/, "")) : null;
    const got = own ?? fromOcr;
    if (!got) return q;
    const how = own ? "the question text of the same reading" : "the page's local OCR reading";
    return { ...q, stem: own ? got.stem : q.stem, options: got.options, confidence: Math.min(q.confidence ?? 0.5, 0.5), notes: [...(q.notes ?? []), `Options recovered from ${how} (the reader returned ${q.options.length} option(s)); check them.`] };
  });
}

/** The reasons of an incomplete reading that concern options only (a page with other good questions is then kept). */
export function optionOnlyReasons(reasons: string[]): boolean {
  return reasons.every((r) => /one option only|every option is empty/.test(r));
}

// ---- Layout of statement / match questions (CMS 2026 Q4 / Q5, 2026-11-16) --------------------------------------------

const LIST_KEY = /^(?:[A-H]|[1-9]|10|I{1,3}|IV|VI{0,3}|IX|X)$/;
const STATEMENT_OPTION = /^\s*\(?([1-9])[.)]\s+\S/;
/** A Match-the-Following code row: "1 2 3", "A-1, B-3, C-2", "4 3 2 1" — label tokens and separators only. */
const CODE_ROW = /^[\s,;:\-–→]*(?:\(?(?:[A-H]|[1-9]|I{1,3}|IV|V)\)?[\s,;:\-–→]*){2,}$/;
const COMBINATION = /\b(?:and|only)\b/i;
const squash = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();

/** Second / Verify 2 reads: structural repair only — never the page OCR the first read used (that would hide real differences). */
export const NO_OCR = (): string | null => null;

type LayoutQ = Pick<ExtractedQuestion, "number" | "stem" | "options" | "type" | "listI" | "listII">;

/** Every option is a numbered statement 1, 2, 3 … in order — the statements were read as options (CMS 2026 Q4). */
export function statementsAsOptions(q: Pick<ExtractedQuestion, "options">): boolean {
  return q.options.length >= 2 && q.options.every((o, i) => Number(STATEMENT_OPTION.exec(o.text ?? "")?.[1]) === i + 1);
}

/** Why the List I / List II / code structure of a match question is not trustworthy ([] = fine). CMS 2026 Q5. */
export function matchLayoutProblems(q: LayoutQ): string[] {
  const isMatch = q.type === "MATCH_THE_FOLLOWING" || !!q.listI?.length || !!q.listII?.length;
  if (!isMatch) return [];
  const out: string[] = [];
  const l1 = q.listI ?? [];
  const l2 = q.listII ?? [];
  if (l1.length < 2 || l2.length < 2) out.push(`List I has ${l1.length} row(s) and List II ${l2.length} — the two columns were not separated`);
  const badKey = [...l1, ...l2].find((e) => !LIST_KEY.test((e.key ?? "").trim()));
  if (badKey) out.push(`a list row has no printed label (key “${(badKey.key ?? "").slice(0, 30)}”)`);
  if (q.options.length > 5) out.push(`${q.options.length} options were read — the code table was read as options`);
  else if (q.options.some((o) => /^\s*\(?[A-Ea-e1-9]\)?\s*$/.test(o.text ?? "") || /^\s*\([a-e]\)/.test(o.text ?? ""))) out.push("an option holds a lone label or a code-table fragment");
  else if (q.options.filter((o) => COMBINATION.test(o.text ?? "")).length >= 3) out.push("the options are statement combinations (“1 and 2”), not code rows — they may belong to the question in the other column");
  return out;
}

/**
 * Repairs the layout of statement / match questions of one AI page reading, never inventing text:
 *  - statements read as options → moved back into the question text (wording unchanged); the combination options are
 *    taken from the page's local OCR reading of the same number only when they are unambiguous combination codes,
 *    otherwise the question keeps NO options (blocked: Options missing → Needs Correction);
 *  - a list key that only repeats its row's text (“BETA-MYOSIN…” for “Beta-myosin…”) is a missing label → the positional
 *    label, as the reader adapter does for a missing key;
 *  - a code table read as options → the OCR reading's (a)–(d) code rows when unambiguous;
 *  - anything still wrong lowers confidence below the Ready threshold with the reason (→ Needs Correction).
 */
export function repairLayout<T extends LayoutQ & { notes?: string[]; confidence?: number }>(questions: T[], ocrText: (n: number | null) => string | null): T[] {
  const ocrOptions = (n: number | null) => {
    const t = ocrText(n);
    return t ? optionsFromText(t.replace(/^\s*\d{1,3}\s*[.)]\s*/, ""))?.options ?? null : null;
  };
  return questions.map((q0) => {
    let q = q0;
    const notes = [...(q.notes ?? [])];
    let confidence = q.confidence ?? 0.5;
    if (statementsAsOptions(q)) {
      const stem = `${q.stem.trim()}\n${q.options.map((o) => o.text.trim()).join("\n")}`;
      const got = ocrOptions(q.number);
      const ok = got && got.length >= 4 && got.every((o) => o.text.length <= 40 && COMBINATION.test(o.text) && !STATEMENT_OPTION.test(o.text));
      q = { ...q, stem, options: ok ? got : [] };
      confidence = Math.min(confidence, 0.5);
      notes.push(ok ? "The numbered statements had been read as options: they are back in the question text and the options (a)–(d) were taken from the page's local OCR reading — check them." : "The numbered statements had been read as options: they are back in the question text. The printed options (a)–(d) could not be read unambiguously — enter them from the source.");
    }
    if (q.type === "MATCH_THE_FOLLOWING" || q.listI?.length || q.listII?.length) {
      const relabel = (l: T["listI"], first: (k: number) => string) => l?.map((e, k) => (!LIST_KEY.test(e.key) && squash(e.key).length > 3 && squash(e.text).startsWith(squash(e.key).slice(0, Math.min(12, squash(e.key).length))) ? { ...e, key: first(k) } : e)) ?? l;
      const listI = relabel(q.listI, (k) => String.fromCharCode(65 + k));
      const listII = relabel(q.listII, (k) => String(k + 1));
      if (JSON.stringify(listI) !== JSON.stringify(q.listI) || JSON.stringify(listII) !== JSON.stringify(q.listII)) {
        q = { ...q, listI, listII };
        confidence = Math.min(confidence, 0.6);
        notes.push("Some List I / List II rows were read without their printed label; positional labels (A, B, C… / 1, 2, 3…) were used — check them against the source.");
      }
      if (matchLayoutProblems(q).some((p) => /options|code-table|combinations/.test(p))) {
        const got = ocrOptions(q.number);
        if (got && got.length >= 4 && got.length <= 5 && got.every((o) => CODE_ROW.test(o.text))) {
          q = { ...q, options: got };
          notes.push("The code-table options (a)–(d) were taken from the page's local OCR reading — check them.");
        }
      }
      const left = matchLayoutProblems(q);
      if (left.length) {
        confidence = Math.min(confidence, 0.4);
        notes.push(`Match-the-Following structure needs correction: ${left.join("; ")}. Correct List I, List II and the code options from the source.`);
      }
    }
    return q === q0 && confidence === (q0.confidence ?? 0.5) ? q0 : { ...q, confidence, notes };
  });
}
