/**
 * Local (no-AI) Markdown question parser. Pure: no I/O, no server imports, so the regression suite can run it directly.
 *
 * It never invents content and never flattens the source: stems and options keep their Markdown exactly as written
 * (paragraphs, lists, tables, emphasis, symbols). A question it cannot read completely is returned with what was found,
 * a low confidence and a note, so it reaches review — never silently skipped.
 *
 * Structure it reads:
 * - Questions as headings ("### Q12 (p4) | High", "## Question 12", "#### 12.") or, when the document has no question
 *   headings, numbered lines ("Q12.", "**12.**", "12)"). A plain "12." line starts a question only when it is the next
 *   number and the current question already has its options, so numbered statements (1. 2. 3.) stay inside the stem.
 * - Options "A. x", "(a) x", "a) x", "**B.** x", "- C) x".
 * - Inline "Answer: B" / "Ans: (b)" / "Correct answer: C", "Explanation: …", "Subject: …", "Topic: …" lines.
 * - Answer-key sections (a heading containing "answer key" / "answers" / "key"): table rows "| 12 | B |" and lines
 *   "12. B", "12 - B", "Q12: B". "X" / "Dropped" / "Withdrawn" / "Bonus" are kept as printed (→ WITHDRAWN downstream).
 * - Paper boundaries: a heading naming a paper ("# UPSC CMS 2022 – Paper II", "## Paper 1"). Each paper becomes its own
 *   section with its own numbering and its own key; keys are matched within their paper only.
 */
import type { ExtractedOption, ExtractedQuestion } from "@/lib/ai-import/types";

export interface MdKeyEntry {
  number: number;
  raw: string;
}

export interface MdPaper {
  /** "" for a single-paper document; else "Paper I", "Paper II" … (the importer's section — keeps numbering and keys apart). */
  section: string;
  title: string | null;
  exam: string | null;
  year: number | null;
  paper: string | null;
  questions: ExtractedQuestion[];
  key: MdKeyEntry[];
  /** Key entries that disagree with each other or name no question in this paper — never applied. */
  keyProblems: string[];
}

export interface MdParse {
  papers: MdPaper[];
  warnings: string[];
}

const ROMAN: Record<string, string> = { i: "I", ii: "II", iii: "III", iv: "IV", "1": "I", "2": "II", "3": "III", "4": "IV", one: "I", two: "II", three: "III", four: "IV" };
const PAPER_RE = /\bpaper\s*[-–—:]?\s*(iv|iii|ii|i|[1-4]|one|two|three|four)\b(?:\s*\(\s*(?:one|two|three|four)\s*\))?/i;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const Q_PREFIX_HEAD_RE = /^(?:\*\*)?Q(?:uestion|n)?\.?\s*(?:No\.?\s*)?\d{1,3}\b/i;
const Q_HEADING_RE = /^(?:\*\*)?(?:Q(?:uestion|n)?\.?\s*(?:No\.?\s*)?)?(\d{1,3})(?:\*\*)?(?:[.):\s]|$)/i;
const Q_LINE_PREFIXED_RE = /^(?:\*\*)?Q(?:uestion|n)?\.?\s*(?:No\.?\s*)?(\d{1,3})(?:\*\*)?\s*[.):-]?\s*(?:\*\*)?\s*(.*)$/i;
const Q_LINE_PLAIN_RE = /^(?:\*\*)?(\d{1,3})(?:\*\*)?\s*[.)]\s*(?:\*\*)?\s*(\S.*)$/;
const OPT_RE = /^(?:[-*+]\s+)?(?:\*\*)?(\(?([A-Da-d])[.)](?:\*\*)?|\(([A-Da-d])\)(?:\*\*)?)\s*(?:\*\*)?\s*(.*)$/;
const ANSWER_RE = /^(?:\*\*)?(?:correct\s+)?(?:answer|ans)(?:\*\*)?\s*[:.-]\s*(?:\*\*)?\s*\(?([A-Da-d](?:\s*[,&/]\s*[A-Da-d])*)\)?(?:\*\*)?\s*\.?\s*$/i;
const META_RE = /^(?:\*\*)?(explanation|solution|subject|topic|difficulty)(?:\*\*)?\s*[:-]\s*(?:\*\*)?\s*(.*)$/i;
const KEY_HEAD_RE = /\b(answer\s*key|answers|key)\b/i;
const KEY_VALUE = String.raw`([A-Da-d](?:\s*[,&/]\s*[A-Da-d]){0,3}|X|×|\*|bonus|dropped|deleted|withdrawn)`;
const KEY_ROW_RE = new RegExp(String.raw`^\|\s*(?:Q\s*)?(\d{1,3})\s*\|\s*${KEY_VALUE}\b[^|]*\|`, "i");
const KEY_LINE_RE = new RegExp(String.raw`^(?:Q\s*)?(\d{1,3})\s*[.):=-]?\s*\(?${KEY_VALUE}\)?\s*$`, "i");
const YEAR_RE = /\b(19[5-9]\d|20\d{2})\b/;

/** Whole-file UTF-8 check (the upload check samples only the head). Throws a readable error on invalid bytes. */
export function decodeMarkdown(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error("The Markdown file contains binary data.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The Markdown file is not valid UTF-8 text.");
  }
}

/**
 * The paper of a multi-paper document that a job's Previous Year Paper names ("UPSC CMS PAPER 2" → "Paper II"), or
 * null (no paper named / no such paper in the document → every paper is kept as its own section).
 */
export function pickPaper(parse: MdParse, pyqTitle: string | null | undefined): MdPaper | null {
  if (parse.papers.length < 2 || !pyqTitle) return null;
  const want = paperName(pyqTitle);
  return (want && parse.papers.find((p) => p.paper === want)) || null;
}

/** UTF-8 BOM, Windows / old-Mac line endings. */
export function normalizeMarkdown(src: string): string {
  return src.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function paperName(text: string): string | null {
  const m = PAPER_RE.exec(text);
  return m ? `Paper ${ROMAN[m[1].toLowerCase()]}` : null;
}

function keyValue(raw: string): string {
  const v = raw.trim();
  return /^[A-Da-d](?:\s*[,&/]\s*[A-Da-d])*$/.test(v) ? v.toUpperCase().replace(/\s+/g, "") : v;
}

interface Draft {
  number: number;
  label: string;
  heading: string | null;
  stem: string[];
  options: ExtractedOption[];
  /** Lines after the options that are no option / answer / meta line (kept, flagged). */
  trailing: string[];
  answers: string[];
  answerRaw: string | null;
  hints: { subject?: string | null; topic?: string | null; difficulty?: string | null; explanation?: string | null };
  notes: string[];
  /** Index of the line that started this question (the exact source block is kept for the review screen). */
  from: number;
  to?: number;
}

function newPaper(section: string, title: string | null): MdPaper {
  return { section, title, exam: null, year: title ? Number(YEAR_RE.exec(title)?.[1]) || null : null, paper: section || null, questions: [], key: [], keyProblems: [] };
}

function trimBlock(lines: string[]): string {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join("\n");
}

/** A GitHub-style pipe table: a `| … |` row directly followed by a `|---|` separator (lib/rich-content.ts renders it). */
export function hasPipeTable(text: string): boolean {
  const l = text.split("\n");
  return l.some((x, i) => /^\s*\|.*\|\s*$/.test(x) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l[i + 1] ?? ""));
}

function finish(d: Draft, section: string): ExtractedQuestion {
  const stem = trimBlock(d.stem);
  const notes = [...d.notes];
  const labels = d.options.map((o) => o.label);
  const complete = labels.join("") === "ABCD" && d.options.every((o) => o.text.trim());
  if (!stem) notes.push(`Q${d.label}: no question text was found in the Markdown.`);
  if (!d.options.length) notes.push(`Q${d.label}: no options (A–D) were found in the Markdown.`);
  else if (!complete) notes.push(`Q${d.label}: options read as ${labels.join(", ") || "none"}${d.options.some((o) => !o.text.trim()) ? " (some empty)" : ""} — expected exactly A, B, C, D.`);
  const texts = d.options.map((o) => o.text.trim()).filter(Boolean);
  if (new Set(texts).size < texts.length) notes.push(`Q${d.label}: two or more options have identical text — check the source.`);
  if (d.trailing.length) notes.push(`Q${d.label}: text after the options was kept here for review: “${d.trailing.join(" ").slice(0, 200)}”.`);
  // A pipe table (header + |---| line) is stored in the rich format, which shows it as a table; `$` is escaped so
  // the text is never read as a formula. Any other `|` line stays plain text, flagged.
  const table = hasPipeTable(stem);
  if (table) notes.push(`Q${d.label}: contains a table — kept row for row and shown as a table; check it against the source.`);
  else if (/^\s*\|.*\|\s*$/m.test(stem)) notes.push(`Q${d.label}: has lines with “|” that are not a complete table — kept exactly as written.`);
  const rich = (t: string) => (table ? t.replace(/(?<!\\)\$/g, "\\$") : t);
  return {
    section,
    number: d.number,
    label: d.label,
    pages: [1],
    type: d.options.length > 4 ? "FIVE_OPTIONS" : d.answers.length > 1 ? "MULTIPLE_CORRECT" : "SINGLE_CORRECT",
    stem: rich(stem),
    options: d.options.map((o) => ({ ...o, text: rich(o.text.trim()) })),
    printedAnswer: d.answers,
    printedAnswerRaw: d.answerRaw,
    contentFormat: table ? "RICH_V1" : "PLAIN",
    confidence: stem && complete && !d.trailing.length ? 0.98 : 0.4,
    unreadable: [],
    figures: [],
    method: "MARKDOWN",
    hints: d.hints,
    notes,
  };
}

/** Parses a Markdown document into papers → questions (+ each paper's own answer key). */
export function parseMarkdown(source: string): MdParse {
  const lines = normalizeMarkdown(source).split("\n");
  const warnings: string[] = [];
  // Question headings: "### Q12", "## Question 12" — or, only when no such heading exists, numbered headings of level 3+
  // ("### 12."), so numbered section headings ("## 1. Document Metadata") never become questions.
  const heads = lines.map((l) => HEADING_RE.exec(l.trim())).filter((h): h is RegExpExecArray => !!h);
  const qPrefixed = heads.some((h) => Q_PREFIX_HEAD_RE.test(h[2]));
  const isQuestionHeading = (h: RegExpExecArray) => (qPrefixed ? Q_PREFIX_HEAD_RE.test(h[2]) : h[1].length >= 3 && /^(?:\*\*)?\d{1,3}(?:\*\*)?[.)]?(?:\s|$)/.test(h[2]));
  const usesQuestionHeadings = heads.some(isQuestionHeading);
  const usesPrefixedLines = !usesQuestionHeadings && lines.some((l) => /^(?:\*\*)?Q(?:uestion|n)?\.?\s*\d{1,3}\b/i.test(l.trim()));

  const papers: MdPaper[] = [];
  let paper: MdPaper | null = null;
  let docTitle: string | null = null;
  let draft = null as Draft | null;
  let inKey = false;
  let inFence = false;
  const keyRaw = new Map<MdPaper, Map<number, Set<string>>>();

  const ensurePaper = () => (paper ??= (papers.push(newPaper("", docTitle)), papers[papers.length - 1]));
  const close = () => {
    if (!draft) return;
    const p = ensurePaper();
    if (p.questions.some((q) => q.number === draft!.number)) {
      draft.notes.push(`Q${draft.label} appears more than once in ${p.section || "this paper"} — both are kept; check which is right.`);
      warnings.push(`${p.section || "Document"}: question number ${draft.number} appears more than once.`);
    }
    const q = finish(draft, p.section);
    // The question's exact Markdown, line for line (trailing blank lines dropped), shown next to the extracted fields.
    q.sourceText = lines.slice(draft.from, (draft.to ?? lineNo) + 1).join("\n").replace(/\s+$/, "").slice(0, 20_000);
    p.questions.push(q);
    draft = null;
  };
  const start = (n: number, heading: string | null, first: string) => {
    // The line starting this question is not part of the previous question's source block.
    if (draft) draft.to ??= lineNo - 1;
    close();
    const p = ensurePaper();
    const last = p.questions.at(-1)?.number ?? 0;
    draft = { number: n, label: String(n), heading, stem: first ? [first] : [], options: [], trailing: [], answers: [], answerRaw: null, hints: {}, notes: [], from: lineNo };
    if (last && n !== last + 1 && n !== last) draft.notes.push(`Q${n} follows Q${last} — numbering is not continuous; check for a missing or merged question.`);
  };

  let lineNo = -1;
  for (const rawLine of lines) {
    lineNo++;
    // A heading / key section ends the current question's source block at the line before it.
    if (draft && HEADING_RE.test(rawLine.trim())) draft.to ??= lineNo - 1;
    const line = rawLine.trimEnd();
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) inFence = !inFence;
    const h = inFence ? null : HEADING_RE.exec(t);
    if (h) {
      const text = h[2];
      if (usesQuestionHeadings && isQuestionHeading(h)) {
        inKey = false;
        start(Number(Q_HEADING_RE.exec(text)![1]), text, "");
        continue;
      }
      close();
      const clean = text.replace(/[*_`]/g, "");
      if (h[1].length === 1 && !docTitle) docTitle = clean;
      const pn = paperName(text);
      const isKey = KEY_HEAD_RE.test(text) || /question[-\s]*answer\s*mapping/i.test(text);
      if (pn && isKey) {
        // "## Paper II Answer Key": that paper's key (a key-only document starts the paper itself).
        paper = papers.find((p) => p.paper === pn) ?? (papers.push(newPaper(pn, clean)), papers[papers.length - 1]);
      } else if (pn && paper?.paper !== pn) {
        if (paper && !paper.paper && !paper.questions.length && !paper.key.length) Object.assign(paper, { section: pn, paper: pn, title: clean });
        else papers.push((paper = newPaper(pn, clean)));
      }
      inKey = isKey;
      continue;
    }
    if (inKey && !inFence) {
      const m = KEY_ROW_RE.exec(t) ?? KEY_LINE_RE.exec(t);
      if (m) {
        const p = ensurePaper();
        const byNum = keyRaw.get(p) ?? new Map<number, Set<string>>();
        keyRaw.set(p, byNum);
        const set = byNum.get(Number(m[1])) ?? new Set<string>();
        set.add(keyValue(m[2]));
        byNum.set(Number(m[1]), set);
      }
      continue;
    }
    if (!draft) {
      if (inFence) continue;
      const pm = usesPrefixedLines ? Q_LINE_PREFIXED_RE.exec(t) : !usesQuestionHeadings ? Q_LINE_PLAIN_RE.exec(t) : null;
      if (pm && (usesPrefixedLines || Number(pm[1]) === (paper?.questions.at(-1)?.number ?? 0) + 1)) start(Number(pm[1]), null, pm[2] ?? "");
      continue;
    }
    if (!inFence && !usesQuestionHeadings) {
      const pm = usesPrefixedLines ? Q_LINE_PREFIXED_RE.exec(t) : Q_LINE_PLAIN_RE.exec(t);
      const next = draft.number + 1;
      if (pm && (usesPrefixedLines ? true : Number(pm[1]) === next && draft.options.length >= 2)) {
        start(Number(pm[1]), null, pm[2] ?? "");
        continue;
      }
    }
    if (inFence) {
      (draft.options.length ? draft.trailing : draft.stem).push(line);
      continue;
    }
    const ans = ANSWER_RE.exec(t);
    if (ans) {
      draft.answers = [...new Set(ans[1].toUpperCase().match(/[A-D]/g) ?? [])];
      draft.answerRaw = t;
      continue;
    }
    const meta = META_RE.exec(t);
    if (meta && (draft.options.length || meta[1].toLowerCase() !== "explanation")) {
      const k = meta[1].toLowerCase();
      const field = k === "solution" ? "explanation" : (k as "explanation" | "subject" | "topic" | "difficulty");
      draft.hints[field] = meta[2].trim() || null;
      continue;
    }
    const o = OPT_RE.exec(t);
    if (o) {
      const label = (o[2] ?? o[3]).toUpperCase();
      const expected = "ABCD"[draft.options.length];
      if (label === expected || (draft.options.length && !draft.options.some((x) => x.label === label))) {
        draft.options.push({ label, printed: o[1].replace(/\*/g, ""), text: o[4] ?? "" });
        continue;
      }
    }
    if (/^\[.*\]$/.test(t)) {
      draft.notes.push(`Source note: ${t.slice(1, -1)}`);
      continue;
    }
    if (!draft.options.length) draft.stem.push(line);
    else if (!t) continue;
    else if (draft.hints.explanation != null) draft.hints.explanation += `\n${line}`;
    else if (/^\s{2,}\S/.test(line) || /^\s*[-*+]\s/.test(line)) draft.options[draft.options.length - 1].text += `\n${t}`;
    else draft.trailing.push(t);
  }
  close();

  for (const p of papers) {
    const byNum = keyRaw.get(p);
    if (!byNum) continue;
    const numbers = new Set(p.questions.map((q) => q.number));
    for (const [n, vals] of [...byNum].sort((a, b) => a[0] - b[0])) {
      if (vals.size > 1) {
        p.keyProblems.push(`Q${n}: the answer key gives different answers (${[...vals].join(" / ")}) — not applied; check the key.`);
        continue;
      }
      if (p.questions.length && !numbers.has(n)) {
        p.keyProblems.push(`Key entry ${n} (${[...vals][0]}) names no question in ${p.section || "this paper"} — not applied.`);
        continue;
      }
      p.key.push({ number: n, raw: [...vals][0] });
    }
    for (const q of p.questions) {
      const k = p.key.find((e) => e.number === q.number);
      if (!k && !q.printedAnswer.length) q.notes = [...(q.notes ?? []), `Q${q.label}: no answer in the Markdown answer key.`];
      if (k && q.printedAnswer.length && /^[A-D,]+$/.test(k.raw) && k.raw.split(",").sort().join() !== [...q.printedAnswer].sort().join())
        q.notes = [...(q.notes ?? []), `Q${q.label}: the inline answer (${q.printedAnswer.join(",")}) differs from the answer key (${k.raw}).`];
    }
  }
  // Metadata from the document title when the paper heading itself has none.
  const exam = docTitle?.replace(YEAR_RE, "").replace(PAPER_RE, "").split(/[-–—|(]/)[0].replace(/[#*_`]/g, "").trim() || null;
  for (const p of papers) {
    p.exam ??= exam;
    p.year ??= Number(YEAR_RE.exec(`${p.title ?? ""} ${docTitle ?? ""}`)?.[1]) || null;
    p.title ??= docTitle;
  }
  // One paper: no section (the Question Bank keeps the printed numbers). More: each keeps its own section.
  if (papers.length === 1 && papers[0].section) {
    papers[0].section = "";
    for (const q of papers[0].questions) q.section = "";
  }
  if (!papers.some((p) => p.questions.length)) warnings.push("No numbered questions were found in the Markdown file.");
  return { papers: papers.filter((p) => p.questions.length || p.key.length), warnings };
}
