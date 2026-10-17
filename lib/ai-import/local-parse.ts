/**
 * Local (no-AI) question parser for documents with a reliable text layer
 * (digital PDFs, DOCX). Pure functions: no I/O, no server imports, so the
 * regression suite can exercise every rule directly.
 *
 * It never invents content: a question whose options cannot be found
 * completely is returned with what was found and a low confidence, and the
 * page is marked unreliable (→ AI extraction when enabled, else review).
 */
import type { ExtractedOption, ExtractedQuestion, ExtractedType, MatchEntry, NBox } from "@/lib/ai-import/types";

export interface Seg {
  text: string;
  box?: NBox;
}

export interface Line {
  text: string;
  /** Normalized top (0..1) — PDF only. */
  y?: number;
  h?: number;
  x?: number;
  column?: number;
  segs?: Seg[];
}

export interface Block {
  /** Latest heading line before this question ("PHYSIOLOGY", "Section B: Anatomy") — a subject hint, matched by exact name only. */
  heading?: string | null;
  section: string;
  number: number;
  label: string;
  lines: Line[];
  /** Text of the whole block (lines joined by "\n"). */
  text: string;
}

const Q_START = /^\s*(?:Q(?:uestion|ue|n)?\s*[.:]?\s*(?:No\.?\s*)?)?(\d{1,3})\s*[.):]\s*(\S.*)?$/i;
const Q_START_PREFIXED = /^\s*Q(?:uestion|ue|n)?\s*[.:]?\s*(?:No\.?\s*)?(\d{1,3})\b\s*[.):-]?\s*(.*)$/i;

/** Numbering state carried from page to page of one document. */
export interface NumberingState {
  last: number;
  sectionIdx: number;
}

/**
 * Splits reading-ordered lines into numbered question blocks. Lines before
 * the first question start go to `preamble` (instructions, or the tail of a
 * question continued from the previous page). Numbering must advance by one;
 * a restart at 1 after Q5+ opens a new section ("S2", …).
 */
export function splitQuestions(lines: Line[], state: NumberingState = { last: 0, sectionIdx: 1 }): { blocks: Block[]; preamble: string[] } {
  const blocks: Block[] = [];
  const preamble: string[] = [];
  let current: Block | null = null;
  let last = state.last;
  let sectionIdx = state.sectionIdx;
  let heading: string | null = null;
  const HEADING = /^(?:(?:section|part|subject)\b[\s\w.:-]{0,40}|[A-Z][A-Z &/-]{2,38})$/;
  for (const line of lines) {
    const t = line.text.trim();
    // A heading only between questions: never inside a question whose options are not complete yet.
    const blockComplete = !current || (chooseRun(markersOf(current.lines.map((l) => l.text).join("\n")))?.length ?? 0) >= 4;
    if (blockComplete && HEADING.test(t) && !/\b(ANSWER|KEY|INSTRUCTIONS?|LIST|COLUMN)\b/.test(t)) {
      heading = t.replace(/^(section|part|subject)\s*[\w]{0,3}\s*[:.-]?\s*/i, "").trim() || t;
      continue;
    }
    const prefixed = Q_START_PREFIXED.exec(line.text);
    const m = prefixed ?? Q_START.exec(line.text);
    if (m) {
      const n = Number(m[1]);
      const next = last === 0 ? n >= 1 && n <= 400 : n === last + 1 || (prefixed !== null && n > last && n <= last + 3);
      const restart = last >= 5 && n === 1;
      if (next || restart) {
        if (restart) sectionIdx++;
        current = { heading, section: restart || sectionIdx > 1 ? `S${sectionIdx}` : "", number: n, label: String(n), lines: [{ ...line, text: (m[2] ?? "").trim() }], text: "" };
        blocks.push(current);
        last = n;
        continue;
      }
    }
    if (current) current.lines.push(line);
    else preamble.push(line.text);
  }
  for (const b of blocks) b.text = b.lines.map((l) => l.text).join("\n").trim();
  state.last = last;
  state.sectionIdx = sectionIdx;
  return { blocks, preamble };
}

// ---- Options --------------------------------------------------------------------------------

export interface Marker {
  family: string;
  index: number;
  start: number;
  end: number;
  printed: string;
}

const MARKER = /(^|[\s\n])(\(([A-Ea-e1-5])\)|([A-E])[.)](?=\s)|([a-e])\)(?=\s)|\[([A-Ea-e1-5])\])/g;

export function markersOf(text: string): Marker[] {
  const out: Marker[] = [];
  for (const m of text.matchAll(MARKER)) {
    const lead = m[1].length;
    const start = (m.index ?? 0) + lead;
    const printed = m[2];
    let family: string;
    let ch: string;
    if (m[3]) {
      ch = m[3];
      family = /\d/.test(ch) ? "(1)" : ch === ch.toUpperCase() ? "(A)" : "(a)";
    } else if (m[4]) {
      ch = m[4];
      family = `A${printed.slice(-1)}`;
    } else if (m[5]) {
      ch = m[5];
      family = "a)";
    } else {
      ch = m[6];
      family = /\d/.test(ch) ? "[1]" : "[A]";
    }
    const index = /\d/.test(ch) ? Number(ch) - 1 : ch.toUpperCase().charCodeAt(0) - 65;
    out.push({ family, index, start, end: start + printed.length, printed });
  }
  return out;
}

/** The last complete A–D (or 1–4) run in one marker family; a following 5th marker is kept. */
function chooseRun(markers: Marker[]): Marker[] | null {
  let best: Marker[] | null = null;
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].index !== 0) continue;
    const fam = markers[i].family;
    const run = [markers[i]];
    for (let j = i + 1; j < markers.length && run.length < 5; j++) {
      if (markers[j].family !== fam) continue;
      if (markers[j].index === run.length) run.push(markers[j]);
      else if (markers[j].index === 0) break;
    }
    if (run.length >= 4 && (!best || best.length < 4 || run[0].start >= best[0].start)) best = run;
    // No complete run yet: keep the longest partial one (it is reported as incomplete, never padded).
    else if (run.length >= 2 && (!best || (best.length < 4 && run.length >= best.length))) best = run;
  }
  return best;
}

export interface OptionSplit {
  stem: string;
  options: ExtractedOption[];
  /** Character offsets of each option's text in the block text (for image tokens / positions). */
  spans: { label: string; start: number; end: number; markerStart: number }[];
  stemEnd: number;
  family: string | null;
}

export function splitOptions(text: string): OptionSplit {
  const run = chooseRun(markersOf(text));
  if (!run) return { stem: text.trim(), options: [], spans: [], stemEnd: text.length, family: null };
  const options: ExtractedOption[] = [];
  const spans: OptionSplit["spans"] = [];
  for (let i = 0; i < run.length; i++) {
    const end = i + 1 < run.length ? run[i + 1].start : text.length;
    const label = String.fromCharCode(65 + run[i].index);
    options.push({ label, printed: run[i].printed, text: tidy(text.slice(run[i].end, end)) });
    spans.push({ label, start: run[i].end, end, markerStart: run[i].start });
  }
  return { stem: tidy(text.slice(0, run[0].start)), options, spans, stemEnd: run[0].start, family: run[0].family };
}

function tidy(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, a) => l !== "" || (i > 0 && a[i - 1] !== ""))
    .join("\n")
    .trim();
}

// ---- Printed answers, types -------------------------------------------------------------------

const ANSWER_LINE = /(?:^|\n)\s*(?:Ans(?:wer)?|Correct\s+(?:answer|option)|Key)\s*[:.\-–]?\s*((?:\(?[A-Da-d1-4]\)?\s*(?:,|&|and)?\s*){1,4})\s*(?=\n|$)/i;

export function takePrintedAnswer(text: string): { text: string; answer: string[] } {
  const m = ANSWER_LINE.exec(text);
  if (!m) return { text, answer: [] };
  const labels = [...m[1].matchAll(/[A-Da-d1-4]/g)].map((x) => (/\d/.test(x[0]) ? String.fromCharCode(64 + Number(x[0])) : x[0].toUpperCase()));
  return { text: (text.slice(0, m.index) + text.slice((m.index ?? 0) + m[0].length)).trim(), answer: [...new Set(labels)] };
}

export function detectType(stem: string, optionCount: number, hasFifth: boolean): ExtractedType {
  if (hasFifth) return "FIVE_OPTIONS";
  if (/\bAssertion\b[\s\S]*\bReason\b/i.test(stem)) return "ASSERTION_REASON";
  if (/\b(List|Column)[\s-]*(I|1)\b[\s\S]*\b(List|Column)[\s-]*(II|2)\b|match the following/i.test(stem)) return "MATCH_THE_FOLLOWING";
  if (/\b(one or more|more than one|all (the )?correct|select all)\b/i.test(stem)) return "MULTIPLE_CORRECT";
  if (optionCount === 0) return /\b(integer|numerical value|nearest (whole|integer)|correct to \d+ decimal)\b/i.test(stem) ? "NUMERICAL" : "OTHER";
  return "SINGLE_CORRECT";
}

/** Signals that a text layer may have lost notation (sub/superscripts, private-use glyphs, broken encodings). */
export function notationRisk(text: string): string[] {
  const reasons: string[] = [];
  if (/[-]/.test(text)) reasons.push("private-use glyphs (font encoding lost)");
  if (/�|�/.test(text)) reasons.push("unreadable characters");
  if (/[∫∑∏√∂∆∇≤≥≠≈∝∞→⇌⟶±×÷°′″]/.test(text)) reasons.push("mathematical or scientific symbols");
  if (/\b[A-Z][a-z]?\d+[A-Z(]|\b[a-z]\d\b|\^|\b\d+\s*[a-z]\s*\d+\b/.test(text)) reasons.push("possible formulas (subscripts/superscripts)");
  return reasons;
}

/** Parses "A. text" / "(a) text" lines of a Match-the-Following list block, when unambiguous. */
export function parseMatchLists(stem: string): { listI: MatchEntry[]; listII: MatchEntry[]; rest: string } | null {
  // Headings on their own lines ("List-I" … "List-II"); a heading inside a sentence ("Match List-I with List-II") is not a list start.
  const m = /([\s\S]*?)(?:^|\n)\s*(?:List|Column)[\s-]*(?:I|1)\s*:?\s*\n([\s\S]*?)(?:^|\n)\s*(?:List|Column)[\s-]*(?:II|2)\s*:?\s*\n([\s\S]*)$/i.exec(stem);
  if (!m) return null;
  const entries = (s: string, keys: RegExp) => [...s.matchAll(keys)].map((x) => ({ key: x[1].toUpperCase(), text: x[2].trim() }));
  const listI = entries(m[2], /(?:^|\n)\s*\(?([A-Ea-e])[.)]\s*([^\n]+)/g);
  const listII = entries(m[3], /(?:^|\n)\s*\(?((?:I{1,3}|IV|V|VI{0,3}|[1-9]))[.)]\s*([^\n]+)/g);
  if (listI.length < 2 || listII.length < 2) return null;
  return { listI, listII, rest: m[1].trim() };
}

// ---- One block → one question ------------------------------------------------------------------

export function blockToQuestion(b: Block, page: number, method: string): { q: ExtractedQuestion; split: OptionSplit; text: string } {
  const answered = takePrintedAnswer(b.text);
  const split = splitOptions(answered.text);
  const hasFifth = split.options.length >= 5;
  const type = detectType(split.stem, split.options.length, hasFifth);
  const notes: string[] = [];
  let confidence = 0.95;
  if (split.options.length < 4 && type !== "NUMERICAL") {
    confidence = 0.4;
    notes.push(split.options.length === 0 ? "No answer options were found." : `Only ${split.options.length} option(s) were found.`);
  }
  if (split.options.some((o) => o.text === "")) {
    confidence = Math.min(confidence, 0.6);
    notes.push("An option has no text (it may be an image).");
  }
  const risk = notationRisk(answered.text);
  if (risk.length) {
    confidence = Math.min(confidence, 0.7);
    notes.push(`Text layer may have lost notation: ${risk.join(", ")}.`);
  }
  let listI: MatchEntry[] | null = null;
  let listII: MatchEntry[] | null = null;
  let stem = split.stem;
  if (type === "MATCH_THE_FOLLOWING") {
    const lists = parseMatchLists(split.stem);
    if (lists) {
      listI = lists.listI;
      listII = lists.listII;
      stem = lists.rest || split.stem;
    } else {
      confidence = Math.min(confidence, 0.6);
      notes.push("Match-the-Following lists could not be separated; they stay in the question text.");
    }
  }
  const q: ExtractedQuestion = {
    section: b.section,
    number: b.number,
    label: b.label,
    pages: [page],
    type,
    stem,
    options: split.options,
    listI,
    listII,
    printedAnswer: answered.answer,
    contentFormat: "PLAIN",
    confidence,
    unreadable: [],
    figures: [],
    method,
    notes,
    ...(b.heading ? { hints: { subject: b.heading } } : {}),
  };
  return { q, split, text: answered.text };
}

// ---- PDF reading order ----------------------------------------------------------------------------

/**
 * Groups positioned text segments into visual lines in reading order,
 * handling a two-column layout (left column top→bottom, then right column).
 */
export function orderSegments(segs: Seg[]): Line[] {
  const withBox = segs.filter((s): s is Seg & { box: NBox } => !!s.box);
  if (!withBox.length) return segs.map((s) => ({ text: s.text }));
  const leftOnly = withBox.filter((s) => s.box.x + s.box.w < 0.5).length;
  const rightOnly = withBox.filter((s) => s.box.x > 0.5).length;
  const spanning = withBox.filter((s) => s.box.x < 0.45 && s.box.x + s.box.w > 0.55).length;
  const twoColumns = leftOnly >= 4 && rightOnly >= 4 && spanning <= Math.max(2, withBox.length * 0.1);
  const columnOf = (s: { box: NBox }) => (twoColumns ? (s.box.x >= 0.48 ? 1 : 0) : 0);
  const sorted = [...withBox].sort((a, b) => columnOf(a) - columnOf(b) || a.box.y - b.box.y || a.box.x - b.box.x);
  const lines: Line[] = [];
  for (const s of sorted) {
    const col = columnOf(s);
    const prev = lines[lines.length - 1];
    const tol = Math.max(0.004, s.box.h * 0.5);
    if (prev && prev.column === col && Math.abs((prev.y ?? 0) - s.box.y) <= tol) {
      prev.segs!.push(s);
      prev.segs!.sort((a, b) => a.box!.x - b.box!.x);
      prev.text = prev.segs!.map((x) => x.text).join("  ");
      prev.x = Math.min(prev.x ?? 1, s.box.x);
      prev.h = Math.max(prev.h ?? 0, s.box.h);
    } else {
      lines.push({ text: s.text, y: s.box.y, h: s.box.h, x: s.box.x, column: col, segs: [s] });
    }
  }
  return lines;
}

/** Short text fragments much smaller than the body text: sub/superscripts the text layer has flattened. */
export function scriptFragments(segs: Seg[]): number {
  const hs = segs.filter((s) => s.box).map((s) => s.box!.h).sort((a, b) => a - b);
  if (hs.length < 5) return 0;
  const median = hs[Math.floor(hs.length / 2)];
  return segs.filter((s) => s.box && s.box.h < median * 0.75 && s.text.trim().length <= 4).length;
}
