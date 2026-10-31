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

/** Marks printed before a heading or an answer line ("■ SECTION: SURGERY", "✓ Correct Answer: (b)", "► Official Answer"). */
const LEAD_MARK = "[►▶➤→•✓✔☑√■□▪●◆]";
const HEADING = new RegExp(String.raw`^(?:${LEAD_MARK}+\s*)?(?:(?:[Ss]ection|SECTION|[Pp]art|PART|[Ss]ubject|SUBJECT)\b[\s\w.:&/-]{0,60}|[A-Z][A-Z &/-]{2,38})$`);

/**
 * A section / subject heading line between questions ("PHYSIOLOGY", "Section B: Anatomy", "■ SECTION: GYNAECOLOGY &
 * OBSTETRICS" — seen 2026-10-26: the leading "■" hid three section headings, so the subjects were guessed and two
 * headings were stored as the previous question's explanation). Never an answer / key / instruction / list line.
 */
export function isSectionHeading(text: string): boolean {
  const t = text.trim();
  // "A B C D" is the column header of a Match-the-List code table, never a heading (seen 2026-10-31, CMS 2013 Paper I).
  return HEADING.test(t) && !/\b(ANSWER|KEY|INSTRUCTIONS?|LIST|COLUMN)\b/.test(t) && !/^(?:[A-Z][ \t]+)+[A-Z]$/.test(t);
}

/** The subject name a heading carries ("■ SECTION: SURGERY" → "SURGERY", "Section B: Anatomy" → "Anatomy"). */
export function headingName(text: string): string {
  const t = text.trim().replace(new RegExp(String.raw`^${LEAD_MARK}+\s*`), "");
  return t.replace(/^(section|part|subject)\s*(?:[A-Z0-9]{1,3}(?=\s*[:.-]))?\s*[:.-]?\s*/i, "").trim() || t;
}

/** Explanation text that is really a heading (or headings) printed after the answer: never kept as an explanation. */
export function explanationIsHeading(text: string | null | undefined): boolean {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every(isSectionHeading);
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
  let headingSinceQuestion = false;
  for (const line of lines) {
    const t = line.text.trim();
    // A heading only between questions: never inside a question whose options are not complete yet.
    const blockComplete: boolean = !current || (chooseRun(markersOf(current.lines.map((l) => l.text).join("\n")))?.length ?? 0) >= 4;
    if (blockComplete && isSectionHeading(t)) {
      heading = headingName(t);
      headingSinceQuestion = true;
      continue;
    }
    const prefixed = Q_START_PREFIXED.exec(line.text);
    const m = prefixed ?? Q_START.exec(line.text);
    if (m) {
      const n = Number(m[1]);
      const next = last === 0 ? n >= 1 && n <= 400 : n === last + 1 || (prefixed !== null && n > last && n <= last + 3);
      // A restart at 1 opens a new section only once the open question has its options (or a heading was printed
      // since it): "14. … urinalysis … is\n1. Granular casts\n2. Red cell casts" is a statement list (seen 2026-10-31,
      // CMS 2013: a false restart there lost 105 of 120 questions, because numbering never got back to 15).
      const restart: boolean = last >= 5 && n === 1 && (blockComplete || headingSinceQuestion || prefixed !== null);
      if ((next || restart) && !prefixed && current && (isStatementLine(current, n) || insideSecondList(current))) {
        current.lines.push(line);
        continue;
      }
      if (next || restart) {
        if (restart) sectionIdx++;
        current = { heading, section: restart || sectionIdx > 1 ? `S${sectionIdx}` : "", number: n, label: String(n), lines: [{ ...line, text: (m[2] ?? "").trim() }], text: "" };
        blocks.push(current);
        last = n;
        headingSinceQuestion = false;
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

/**
 * "1. …", "2. …" under "Consider the following statements" belong to the open question, not to the next one: the
 * question has no options yet, and either it already lists the previous number as a statement, or the number
 * restarts at 1 right after a statement lead-in. A "Q7." prefix always starts a question.
 */
function isStatementLine(current: Block, n: number): boolean {
  const text = current.lines.map((l) => l.text).join("\n");
  if ((chooseRun(markersOf(text))?.length ?? 0) >= 2) return false;
  if (n === 1) return /\b(statements?|assertions?|consider the following|given below)\b/i.test(text);
  return current.lines.slice(1).some((l) => new RegExp(`^\\s*\\(?${n - 1}\\s*[.)]\\s`).test(l.text));
}

/**
 * The open question has printed its second list ("List II (Appropriate Microbe)", "Column-II") and no complete option run
 * after it yet: "1. Coxiella burnetti" is a List II entry, not a question (seen 2026-10-31, CMS 2013: List I's "A.–D."
 * looked like complete options, so List II's "1." restarted the numbering).
 */
function insideSecondList(current: Block): boolean {
  const text = current.lines.map((l) => l.text).join("\n");
  const heads = [...text.matchAll(/(?:^|\n)[ \t]*(?:List|Column)[ \t]*[-–]?[ \t]*(?:II|2)\b[^\n]*/gi)];
  if (!heads.length) return false;
  const last = heads[heads.length - 1];
  const after = text.slice((last.index ?? 0) + last[0].length);
  return (chooseRun(markersOf(after))?.length ?? 0) < 4;
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

// After the answer words nothing crosses a line break: "(c) selenium ✓ Correct Answer\n(d) chromium" must never read the
// next option's label as the answer (seen 2026-10-31, CMS 2013: 59 questions lost option D and took D as their answer).
const ANSWER_LINE = /(?:^|\n)[ \t]*(?:[►▶➤→•✓✔☑√■][ \t]*)?(?:(?:Official|Final)[ \t]+)?(?:(?:The[ \t]+)?(?:Correct|Right)[ \t]+(?:answer|option|choice)(?:[ \t]+is)?|Ans(?:wer)?(?:[ \t]+is)?|Key)[ \t]*[:.\-–=]?[ \t]*(?:option[ \t]*)?((?:\(?[A-Da-d1-4]\)?[ \t]*(?:,|&|and|\/)?[ \t]*){1,4})[ \t]*\.?[ \t]*(?=\n|$)/i;

/** A printed answer that drops / withdraws the question instead of naming an option (seen 2026-10-31, CMS 2025 Paper I Q101). */
export const PRINTED_DROPPED = /\b(?:question[ \t]+)?(?:dropped|withdrawn|deleted|bonus)\b/i;
const DROPPED_LINE = /(?:^|\n)[ \t]*(?:[►▶➤→•✓✔☑√■][ \t]*)?(?:(?:Official|Final)[ \t]+)?(?:(?:Correct|Right)[ \t]+)?(?:answer|ans|key)[ \t]*[:.\-–=]?[ \t]*(?:question[ \t]+)?(?:dropped|withdrawn|deleted|bonus)\b[^\n]*(?=\n|$)/i;

/** One option label as printed in an answer ("(b)", "B", "2", "(3)"). */
const ANS_LABEL = String.raw`(?:\([ \t]*[A-Da-d1-4][ \t]*\)|[A-Da-d](?![A-Za-z0-9])|[1-4](?![\d.]))`;
const ANS_LABELS = String.raw`${ANS_LABEL}(?:[ \t]*(?:,|&|and|\/)[ \t]*${ANS_LABEL}){0,3}`;
/**
 * "Ans", "Answer", "Correct answer is", "The right option is", "Key:" (key needs a separator: "key A" is often content),
 * also behind a bullet / arrow / tick and "Official" / "Final" ("► Official Answer: Option (c) — III and IV", seen 2026-10-23;
 * "✓ Correct Answer: (b) Raynaud's syndrome", seen 2026-10-26 — the tick stayed behind as option D's last line).
 */
const ANS_MARK = String.raw`(?:[►▶➤→•✓✔☑√■]\s*)?(?:(?:official|final)\s+)?(?:(?:the\s+)?(?:correct|right)\s+(?:answer|option|choice|response)(?:\s+is)?|ans(?:wer)?(?:\s+is)?(?=[\s:.\-–=(])|key(?=\s*[:\-–=]))`;
const EXPLANATION = /(?:^|\n|\s)(?:Explanation|Solution|Sol\.|Rationale)\s*[:.\-–]\s*([\s\S]*)$/i;
/** An answer printed INSIDE the text (merged into an option, after the options, "Correct answer is (B)"), up to the end of its line. */
const ANS_INLINE = new RegExp(String.raw`(^|[\s.;,|)\]])(${ANS_MARK})[ \t]*(?:[:\-–=]|\.(?!\d))?[ \t]*(?:option[ \t]*)?(${ANS_LABELS})[ \t]*[.)]?[ \t]*([^\n]*?)[ \t]*(?=\n|$)`, "gi");
/** "Correct answer is Mitochondria" — the answer written as the option's TEXT (used only when it equals one option exactly). */
const ANS_TEXT = new RegExp(String.raw`(^|[\s.;,|)\]])(${ANS_MARK})[ \t]*[:\-–=]?[ \t]*([^\n]{1,200}?)[ \t]*\.?[ \t]*(?=\n|$)`, "gi");
/**
 * A mark printed at the END of one option's line: "(c) selenium   ✓ Correct Answer", "(b) Vagus ✓", "(d) Lysosome (Correct)".
 * The mark is an annotation of that option (its printed answer), never option text and never the next line's label.
 */
const MARK_WORDS = String.raw`\(?[ \t]*(?:(?:Correct|Right)(?:[ \t]+(?:Answer|Option|Choice))?|Answer)[ \t]*\)?`;
// A bare ✓ / ✔ / ☑ is a mark; "√" alone may be mathematics, so it counts only with its words.
const OPTION_MARK = new RegExp(String.raw`[ \t]*(?:[✓✔☑]+(?:[ \t]*${MARK_WORDS})?|√[ \t]*${MARK_WORDS}|\([ \t]*(?:Correct|Right)(?:[ \t]+(?:Answer|Option|Choice))?[ \t]*\))[ \t]*$`, "i");

/** Option lines that end with an answer mark: the mark removed, and the labels of the marked options. */
export function optionLineMarks(text: string): { text: string; labels: string[]; raw: string } | null {
  const lines = text.split("\n");
  const marked: number[] = [];
  let raw = "";
  const cleaned = lines.map((l, i) => {
    if (!/^[ \t]*(?:\([ \t]*[A-Ea-e1-5][ \t]*\)|[A-Ea-e][.)]|\[[A-Ea-e1-5]\])[ \t]+\S/.test(l)) return l;
    const m = OPTION_MARK.exec(l);
    if (!m || m.index === 0) return l;
    marked.push(i);
    raw ||= m[0].trim();
    return l.slice(0, m.index);
  });
  if (!marked.length) return null;
  const out = cleaned.join("\n");
  const run = chooseRun(markersOf(out));
  if (!run || run.length < 2) return null;
  // Line start offsets of the cleaned text: a marked line counts only when it starts one option of the run.
  const starts: number[] = [];
  let at = 0;
  for (const l of cleaned) {
    starts.push(at);
    at += l.length + 1;
  }
  const labels: string[] = [];
  for (const i of marked) {
    const opt = run.find((r) => r.start >= starts[i] && r.start < starts[i] + cleaned[i].length && out.slice(starts[i], r.start).trim() === "");
    if (!opt) return null;
    labels.push(String.fromCharCode(65 + opt.index));
  }
  return { text: out, labels: [...new Set(labels)], raw };
}

export interface PrintedAnswerTake {
  /** The text without the answer (and its explanation). */
  text: string;
  /** Canonical labels A–D. */
  answer: string[];
  /** The answer exactly as printed ("Correct answer is (b)"), or null. */
  raw: string | null;
  explanation: string | null;
  /** Why something that looks like an answer was kept in the text, or a doubt about it. */
  note: string | null;
}

const labelsOf = (v: string) => [...new Set([...v.matchAll(/[A-Da-d1-4]/g)].map((x) => (/\d/.test(x[0]) ? String.fromCharCode(64 + Number(x[0])) : x[0].toUpperCase())))];
const normOption = (s: string) => s.toLowerCase().replace(/\$|\\[a-z]+|[\s.,;:()[\]'"`]/g, "");

/**
 * The answer printed in a question's own text, removed from it (it never stays inside an option):
 * "Ans: B" on its own line, "(d) Lysosome Ans: (b)" merged into an option, "The correct answer is (2)",
 * "Correct answer: Mitochondria" (only when it equals one option's text). An explanation printed after the
 * answer ("Explanation: …") is kept separately. Text that merely contains the word "answer" is never touched.
 */
/** The answer starts after the last option marker of a complete option run (so what follows it is not an option). */
function answerAfterOptions(text: string, start: number): boolean {
  const run = chooseRun(markersOf(text));
  return !!run && run.length >= 4 && start > run[run.length - 1].start;
}

export interface Statement {
  key: string;
  text: string;
}

const STATEMENT_LINE = /^\s*\(?((?:X|IX|IV|V?I{1,3}|V|VI{1,3})|[1-9]|[A-H])[.)]\s+(\S.*)$/;

/**
 * Numbered statements of a question stem ("I. Opening snap", "2. …", "(iii) …", "A. …"), one per line, in order.
 * Lines of the same numbering family only; fewer than two is no statement list.
 */
export function statementsOf(stem: string): Statement[] {
  const rows = stem.split("\n").map((l) => STATEMENT_LINE.exec(l)).filter((m): m is RegExpExecArray => !!m);
  const family = (k: string) => (/^\d$/.test(k) ? "arabic" : /^[IVX]+$/.test(k) ? "roman" : "letter");
  const byFamily = new Map<string, Statement[]>();
  for (const m of rows) {
    const f = family(m[1]);
    byFamily.set(f, [...(byFamily.get(f) ?? []), { key: m[1], text: m[2].trim() }]);
  }
  const best = [...byFamily.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  return best.length >= 2 ? best : [];
}

/**
 * Numbered statements run together on one line ("…stethoscope?I. Opening snapII. Systolic click", a reader that lost
 * the line breaks): the markers that are glued to the previous word, or null.
 */
export function mergedStatements(stem: string): string[] | null {
  const glued = [...stem.matchAll(/[a-z?:;)](?=((?:IX|IV|V?I{1,3}|VI{1,3})\.\s+\S))/g)].map((m) => m[1].split(".")[0]);
  const arabic = [...stem.matchAll(/[?:](?=([1-9])\.\s+[A-Z])/g)].map((m) => m[1]);
  return glued.length >= 2 || arabic.length >= 1 ? [...glued, ...arabic] : null;
}

/**
 * A lone mark printed on its own line at the end of an option ("Takayasu disease\n✓"): the tick of the answer line that
 * follows the options ("✓ Correct Answer: (b) …"), left behind by a reader that took the answer but not its mark. It is
 * an annotation, never option text: content checks and fingerprints ignore it, and Verify 1 removes it when the source
 * confirms it.
 */
export const ANNOTATION_TAIL = /(?:\n[ \t]*[✓✔☑√■][ \t]*)+$/;
export function stripAnnotationTail(text: string): string {
  return text.replace(ANNOTATION_TAIL, "");
}

/** A combination option of a statement-code question: "I, II and IV", "1 and 3 only", "Only III", "II & IV". */
const CODE_TOKEN = String.raw`\(?(?:X|IX|IV|V?I{1,3}|V|VI{1,3}|[1-9]|[A-H])\)?`;
const CODE_OPTION = new RegExp(String.raw`^\s*(?:only\s+)?${CODE_TOKEN}(?:\s*(?:,|and|&|\/)\s*${CODE_TOKEN})*(?:\s+only)?\s*\.?\s*$`, "i");
const NONE_ALL = /^\s*(?:none|all|both|neither)\b.{0,40}$/i;

/**
 * "Which of the following statements are correct? I. … II. … Select the answer using the code given below:" with options
 * that are combinations of the statements: ONE option is the answer (the code), so it is single-correct even though
 * several statements are true. A reader that sees "statements are correct" may call it multiple-correct (2026-10-26:
 * 11 false Verify 2 disagreements on one paper).
 */
export function statementCodeQuestion(q: Pick<ExtractedQuestion, "stem" | "options">): boolean {
  const statements = statementsOf(q.stem).length >= 2 || !!mergedStatements(q.stem);
  if (!statements || q.options.length < 3) return false;
  const coded = q.options.filter((o) => CODE_OPTION.test(stripAnnotationTail(o.text))).length;
  const rest = q.options.filter((o) => !CODE_OPTION.test(stripAnnotationTail(o.text)) && NONE_ALL.test(stripAnnotationTail(o.text))).length;
  return coded >= 3 && coded + rest === q.options.length;
}

export function takePrintedAnswer(text: string): PrintedAnswerTake {
  const take = (start: number, end: number, labels: string[], raw: string, note: string | null = null): PrintedAnswerTake => {
    let rest = text.slice(end);
    let explanation: string | null = null;
    const ex = EXPLANATION.exec(rest);
    if (ex && rest.slice(0, ex.index).trim() === "") {
      explanation = ex[1].trim() || null;
      rest = "";
    } else if (rest.trim() && answerAfterOptions(text, start)) {
      // Text printed after an answer that follows the options cannot be option text: it is the explanation — unless it
      // is only a heading (the next section's title), which is never an explanation.
      if (!explanationIsHeading(rest)) {
        explanation = rest.trim();
        note = [note, "The text printed after the answer was kept as its explanation — check it."].filter(Boolean).join(" ");
      }
      rest = "";
    }
    if (explanation && explanationIsHeading(explanation)) explanation = null;
    return { text: (text.slice(0, start) + rest).replace(/[ \t]+\n/g, "\n").trim(), answer: labels, raw: raw.trim(), explanation, note };
  };
  const own = ANSWER_LINE.exec(text);
  if (own) return take(own.index, own.index + own[0].length, labelsOf(own[1]), own[0]);
  // "► Official Answer: Question Dropped (X)": an answer line without a label — never option text, no answer.
  const dropped = DROPPED_LINE.exec(text);
  if (dropped && answerAfterOptions(text, dropped.index + 1)) {
    const t = take(dropped.index, dropped.index + dropped[0].length, [], dropped[0]);
    return { ...t, note: [t.note, `The paper prints this question as dropped (“${dropped[0].trim()}”).`].filter(Boolean).join(" ") };
  }
  const marks = optionLineMarks(text);
  if (marks)
    return {
      text: marks.text.replace(/[ \t]+\n/g, "\n").trim(),
      answer: marks.labels,
      raw: marks.raw,
      explanation: null,
      note: `The printed answer is the mark “${marks.raw}” after option ${marks.labels.join(", ")} in the source (a printed annotation, not an official key)${marks.labels.length > 1 ? " — more than one option is marked" : ""}.`,
    };
  // Inside the option area only: an answer marker in the question text before the options is content.
  const run = chooseRun(markersOf(text));
  if (!run || run.length < 2) return { text, answer: [], raw: null, explanation: null, note: null };
  const from = run[0].start;
  const options = splitOptions(text).options;
  let best: { start: number; end: number; labels: string[]; raw: string; note: string | null } | null = null;
  for (const m of text.matchAll(ANS_INLINE)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start < from) continue;
    const labels = labelsOf(m[3]);
    // "Option (c) — III and IV": the option's text after a dash / colon / equals sign.
    const trailing = m[4].trim().replace(/^[-–—:=]+\s*/, "");
    if (trailing && !/^(?:explanation|solution|sol\.|rationale)/i.test(trailing)) {
      // "(b) Mitochondria": the label with its option text — accepted only when that text is the option's.
      const opt = labels.length === 1 ? options.find((o) => o.label === labels[0]) : undefined;
      if (!opt || normOption(opt.text.replace(ANS_INLINE, "")).indexOf(normOption(trailing)) !== 0) continue;
    }
    best = { start, end: (m.index ?? 0) + m[0].length - (trailing && /^(?:explanation|solution|sol\.|rationale)/i.test(trailing) ? m[4].length : 0), labels, raw: m[0].slice(m[1].length), note: null };
  }
  if (best) return take(best.start, best.end, best.labels, best.raw, best.note);
  for (const m of text.matchAll(ANS_TEXT)) {
    const start = (m.index ?? 0) + m[1].length;
    if (start < from) continue;
    const value = normOption(m[3]);
    if (!value) continue;
    const before = splitOptions(text.slice(0, start)).options;
    const hits = before.filter((o) => normOption(o.text) === value);
    if (hits.length === 1) return take(start, (m.index ?? 0) + m[0].length, [hits[0].label], m[0].slice(m[1].length), `The printed answer "${m[3].trim()}" was matched to option ${hits[0].label} by its text.`);
  }
  return { text, answer: [], raw: null, explanation: null, note: null };
}

/**
 * An answer (and explanation) left inside an EXTRACTED option or stem — e.g. a reader that kept
 * "Lysosome Ans: B" as option D. Returns the cleaned question parts and what was moved, or null when
 * nothing answer-shaped is found. Used by the full-paper verification (Verify 1), never on admin edits.
 */
export function mergedAnswerIn(q: Pick<ExtractedQuestion, "stem" | "options">): { options: ExtractedOption[]; stem: string; labels: string[]; raw: string; explanation: string | null; where: string } | null {
  const whole = `${q.stem}\n${q.options.map((o) => `(${o.label}) ${o.text}`).join("\n")}`;
  const r = takePrintedAnswer(whole);
  if (!r.raw || !r.answer.length) return null;
  const split = splitOptions(r.text);
  if (split.options.length !== q.options.length) return null;
  const changed = q.options.findIndex((o, i) => o.text.trim() !== split.options[i].text.trim());
  if (changed < 0 && split.stem.trim() === q.stem.trim()) return null;
  return {
    stem: split.stem.trim() === q.stem.trim() ? q.stem : split.stem,
    options: q.options.map((o, i) => ({ ...o, text: split.options[i].text })),
    labels: r.answer,
    raw: r.raw,
    explanation: r.explanation,
    where: changed >= 0 ? `option ${q.options[changed].label}` : "question text",
  };
}

/**
 * Formats of one question, read from its own text (deterministic; several may apply). They describe the question and
 * never change it: the Question Bank keeps four options and one stored type, so a format it cannot hold is flagged by the
 * existing checks, never converted. "MARKED_OPTION" = the source printed an answer mark; "OPTIONS_MALFORMED" = not four
 * non-empty options.
 */
export type QuestionFormat = "CLINICAL_CASE" | "IMAGE_BASED" | "STATEMENTS" | "STATEMENT_CODE" | "ASSERTION_REASON" | "MATCH_LISTS" | "PAIRS" | "SEQUENCE" | "NEGATIVE_STEM" | "TABLE" | "MARKED_OPTION" | "OPTIONS_MALFORMED";
export function questionFormats(q: Pick<ExtractedQuestion, "stem" | "options" | "type" | "figures" | "listI" | "printedAnswer"> & { printedAnswerRaw?: string | null }): QuestionFormat[] {
  const stem = q.stem;
  const opts = q.options.map((o) => stripAnnotationTail(o.text));
  const out: QuestionFormat[] = [];
  if (/\b\d{1,3}[- ]?(?:year|yr|month|day|week)s?[- ]old\b|\b(?:presents?|presented|complains?|brought|admitted|on examination|history of)\b/i.test(stem)) out.push("CLINICAL_CASE");
  if (q.figures.length || /\b(?:figure|fig\.|diagram|image|photograph|radiograph|x-ray shown|shown below|given (?:figure|image))\b/i.test(stem)) out.push("IMAGE_BASED");
  if (statementsOf(stem).length >= 2 || mergedStatements(stem)) out.push("STATEMENTS");
  if (statementCodeQuestion(q)) out.push("STATEMENT_CODE");
  if (q.type === "ASSERTION_REASON" || /\bAssertion\b[\s\S]*\bReason\b|\bStatement[ -]?I\b[\s\S]*\bStatement[ -]?II\b/i.test(stem)) out.push("ASSERTION_REASON");
  if (q.type === "MATCH_THE_FOLLOWING" || (q.listI?.length ?? 0) > 0 || /\b(?:List|Column)[\s-]*(?:I|1)\b[\s\S]*\b(?:List|Column)[\s-]*(?:II|2)\b/i.test(stem)) out.push("MATCH_LISTS");
  if (/\b(?:pairs?\b[\s\S]*correctly matched|how many of the (?:pairs|statements))/i.test(stem)) out.push("PAIRS");
  if (/\b(?:correct (?:order|sequence)|sequence of|arrange|chronological)\b/i.test(stem) || opts.filter((o) => /(?:→|->|–>)/.test(o)).length >= 3) out.push("SEQUENCE");
  if (/\b(?:EXCEPT|NOT|INCORRECT|FALSE|LEAST|WRONG)\b/.test(stem) || /\b(?:except|is not|are not|incorrect|not correct|not true|false)\b/i.test(stem)) out.push("NEGATIVE_STEM");
  if (/\|/.test(stem) || /\btable\b/i.test(stem)) out.push("TABLE");
  if (q.printedAnswer.length && /^[✓✔☑√■►▶➤→•]/.test((q.printedAnswerRaw ?? "").trim())) out.push("MARKED_OPTION");
  if (opts.length !== 4 || opts.some((o) => !o.trim())) out.push("OPTIONS_MALFORMED");
  return out;
}

/**
 * A numbered instruction to candidates read as a question ("4. This Test Booklet contains 120 items …", "(i) There are four
 * alternative responses …"): instruction wording and no real option list. Seen 2026-10-31 (CMS 2024 cover page): four
 * instructions became Q1–Q4 and the real Q1–Q4 on the next page were lost as repeated numbers.
 */
const INSTRUCTION_WORDS = /\b(test booklet|answer sheet|OMR|candidate'?s?|invigilator|roll number|examination hall|admission certificate|rough work|penalty for wrong answers?|one-third of the marks|do not open this)\b/i;
export function candidateInstruction(q: Pick<ExtractedQuestion, "stem" | "options">): boolean {
  const options = q.options.filter((o) => o.text.trim());
  const text = `${q.stem}\n${options.map((o) => o.text).join("\n")}`;
  return options.length < 2 && (text.match(new RegExp(INSTRUCTION_WORDS, "gi")) ?? []).length >= 1;
}

export function detectType(stem: string, optionCount: number, hasFifth: boolean): ExtractedType {
  if (hasFifth) return "FIVE_OPTIONS";
  if (/\bAssertion\b[\s\S]*\bReason\b/i.test(stem)) return "ASSERTION_REASON";
  if (/\b(List|Column)[\s-]*(I|1)\b[\s\S]*\b(List|Column)[\s-]*(II|2)\b|match the following/i.test(stem)) return "MATCH_THE_FOLLOWING";
  // "more than one" only about answers ("more than one correct option"), not content ("more than one route of transmission").
  if (/\b(one or more|more than one (correct )?(answers?|options?|responses?|choices?|correct)|all (the )?correct|select all)\b/i.test(stem)) return "MULTIPLE_CORRECT";
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
  if (answered.note) notes.push(answered.note);
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
    ...(b.heading || answered.explanation ? { hints: { ...(b.heading ? { subject: b.heading } : {}), ...(answered.explanation ? { explanation: answered.explanation } : {}) } } : {}),
    ...(answered.raw ? { printedAnswerRaw: answered.raw } : {}),
  };
  return { q, split, text: answered.text };
}

// ---- Printed number sequence of AI-read pages ---------------------------------------------------------

export interface NumberedRead {
  id: string;
  page: number;
  section: string;
  number: number | null;
}

/**
 * Pages of an AI (vision) reading whose printed numbers are not in sequence: a gap from the previous page, a gap or a
 * reversal inside the page, or a number already read on another page. On such a page a number may belong to another
 * question's text (seen 2026-10-31, CMS 2024: the stem of Q7 was stored as "Q9", Q21's as "Q24"), so matching the key
 * by number could attach another question's official answer. Returns the questions on those pages with the reason.
 * Reads in reading order (orderIndex); a question read without a number fills one slot of a gap (it is flagged on its own).
 */
export function numberSequenceProblems(reads: NumberedRead[]): Map<string, string> {
  const out = new Map<string, string>();
  const bySection = new Map<string, NumberedRead[]>();
  for (const r of reads) bySection.set(r.section, [...(bySection.get(r.section) ?? []), r]);
  for (const list of bySection.values()) {
    const pages = [...new Set(list.map((r) => r.page))].sort((a, b) => a - b);
    const seen = new Map<number, number>();
    let prevLast: number | null = null;
    for (const p of pages) {
      const onPage = list.filter((r) => r.page === p);
      const reasons: string[] = [];
      // A gap is explained when exactly that many questions without a number were read inside it (each kept and
      // flagged on its own, e.g. a number read twice); anything else means numbers and text may not belong together.
      let last: number | null = prevLast;
      let unnumbered = 0;
      for (const r of onPage) {
        if (r.number === null) {
          unnumbered++;
          continue;
        }
        if (last !== null && r.number <= last) reasons.push(`Q${r.number} follows Q${last}`);
        else if (last !== null && r.number - last - 1 !== unnumbered) reasons.push(last === prevLast && r === onPage.find((x) => x.number !== null) ? `it starts at Q${r.number} after Q${last} on the page before` : `Q${r.number} follows Q${last}`);
        if (seen.has(r.number) && seen.get(r.number) !== p) reasons.push(`Q${r.number} was also read on page ${seen.get(r.number)}`);
        if (!seen.has(r.number)) seen.set(r.number, p);
        last = Math.max(last ?? 0, r.number);
        unnumbered = 0;
      }
      if (reasons.length) for (const r of onPage) out.set(r.id, `The printed numbers read on page ${p} are not in sequence (${reasons.slice(0, 3).join("; ")}), so a number may belong to another question's text.`);
      if (last !== null) prevLast = last;
    }
  }
  return out;
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
