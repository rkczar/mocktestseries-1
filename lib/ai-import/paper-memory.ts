/**
 * Paper-format memory of the AI Question Importer — the pure part (no I/O, testable directly).
 *
 * A rule records one fact about how an exam's papers are printed: numbering, option labels, section headings, how an
 * answer is marked, how reliable those marks are against the official key, the key's layout and dropped-item marker,
 * the question formats used, the subjects a paper covers, and OCR confusions an administrator corrected.
 *
 * Rules are learned ONLY from deterministic evidence: the source document's own text (local parse), an official key that
 * was read completely and matched to admin-approved questions, the subjects of admin-approved questions, and admin
 * corrections. AI readings, AI answers and AI classifications are never evidence, and no rule ever holds an answer.
 *
 * Every rule keeps its evidence (import, file name, SHA-256, what was measured) and a confidence = supporting / observed.
 * Rules start PROPOSED; only rules an administrator CONFIRMED are used, and only as checks (they flag, never change a
 * question). Paper-specific rules ("PAPER II") stay separate from exam rules; an exam rule is proposed only when two or
 * more different papers show the same fact.
 */
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { ANNOTATION_TAIL, candidateInstruction, mergedAnswerIn, mergedStatements, questionFormats, type QuestionFormat } from "@/lib/ai-import/local-parse";

export const PAPER_RULE_KINDS = {
  NUMBERING: "Question numbering",
  OPTION_LABELS: "Option labels",
  SECTION_HEADINGS: "Section headings",
  ANSWER_MARK: "How the answer is printed in the paper",
  ANNOTATION_RELIABILITY: "Printed answer marks vs the official key",
  ANSWER_KEY_LAYOUT: "Answer-key layout",
  DROPPED_MARKER: "Dropped-item marker",
  QUESTION_TYPES: "Question formats",
  SUBJECT_SCOPE: "Subjects the paper covers",
  OCR_CONFUSION: "OCR confusion (admin-corrected)",
  EXTRACTION_ERROR: "Extraction error (admin-corrected)",
} as const;
export type PaperRuleKind = keyof typeof PAPER_RULE_KINDS;

/** Kinds that become an exam-level proposal when two or more papers show the same value. */
const GENERALIZABLE = new Set<PaperRuleKind>(["NUMBERING", "OPTION_LABELS", "DROPPED_MARKER", "ANSWER_KEY_LAYOUT", "OCR_CONFUSION", "EXTRACTION_ERROR"]);

export type PaperRuleSource = "SOURCE_DOCUMENT" | "OFFICIAL_KEY" | "ADMIN_CONFIRMED";

export interface PaperRuleEvidence {
  jobId: string;
  jobTitle: string;
  fileName: string;
  fileSha256: string | null;
  source: PaperRuleSource;
  detail: string;
  supporting: number;
  observed: number;
  at: string;
}

export interface PaperRule {
  id: string;
  scope: "EXAM" | "PAPER";
  /** Paper identity ("PAPER II") for PAPER rules; null for EXAM rules. */
  paper: string | null;
  kind: PaperRuleKind;
  /** Stable identity of the fact (kind + value): the same fact learned again adds evidence, never a duplicate. */
  key: string;
  statement: string;
  value: Record<string, unknown>;
  supporting: number;
  observed: number;
  confidence: number;
  evidence: PaperRuleEvidence[];
  status: "PROPOSED" | "CONFIRMED" | "REJECTED";
  /** Set when newer evidence for the same kind and paper shows a different value: a confirmed rule goes back to review. */
  contradictedBy: string | null;
  learnedAt: string;
  updatedAt: string;
  decidedById: string | null;
  decidedAt: string | null;
  note: string | null;
}

export type PaperRuleProposal = Pick<PaperRule, "scope" | "paper" | "kind" | "key" | "statement" | "value"> & { evidence: PaperRuleEvidence };

/** "UPSC CMS PAPER 2" / "Paper-II" / "paper 1" → "PAPER II" / "PAPER I"; null when the title names no paper. */
export function paperOf(title: string | null | undefined): string | null {
  const m = /\bpaper[\s\-–_]*(?:no\.?\s*)?(I{1,3}|IV|V|[1-5])\b/i.exec(title ?? "");
  if (!m) return null;
  const roman = ["", "I", "II", "III", "IV", "V"];
  return `PAPER ${/\d/.test(m[1]) ? roman[Number(m[1])] : m[1].toUpperCase()}`;
}

export interface LearnInput {
  jobId: string;
  jobTitle: string;
  paper: string | null;
  fileName: string;
  fileSha256: string | null;
  at: string;
  /** The source document read locally (Word / text-layer PDF), as parsed now; null for a scanned paper. */
  source: {
    questions: (ExtractedQuestion & { heading?: string | null })[];
    /** Printed number style of each question line ("Q1." / "1." / "1)"). */
    numberStyles: string[];
    sectionRestarts: number;
  } | null;
  /** Official key entries matched to questions an administrator approved (number → value as printed); null if none. */
  approvedKey: { fileName: string; fileSha256: string | null; values: Map<number, string>; expected: number | null; fileKind: string; read: "text layer" | "AI vision" | "sheet" } | null;
  /** Subjects of the questions an administrator approved (subject name → count). */
  approvedSubjects: Map<string, number> | null;
  /** Word-level corrections an administrator made to AI-read text: wrong → right (count). */
  ocrCorrections: { wrong: string; right: string; count: number }[];
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const ev = (i: LearnInput, source: PaperRuleSource, detail: string, supporting: number, observed: number, file?: { name: string; sha: string | null }): PaperRuleEvidence => ({ jobId: i.jobId, jobTitle: i.jobTitle, fileName: file?.name ?? i.fileName, fileSha256: file ? file.sha : i.fileSha256, source, detail, supporting, observed, at: i.at });
const dominant = <T extends string>(xs: T[]): [T, number] | null => {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
};

/** How the paper prints a question's answer, read from what the parser took out of it. */
function answerMarkStyle(q: ExtractedQuestion): string | null {
  if (!q.printedAnswer.length || !q.printedAnswerRaw) return null;
  if ((q.notes ?? []).some((n) => n.startsWith("The printed answer is the mark"))) return `mark after the option text (“${q.printedAnswerRaw.trim()}”)`;
  // The words before the label ("✓ Correct Answer:"): a label is "(b)" or a standalone letter / digit, never the C of "Correct".
  const prefix = q.printedAnswerRaw.replace(/(?:\(\s*[A-Da-d1-4]\s*\)|\b[A-Da-d1-4]\b(?![’'][a-z]))[\s\S]*$/, "").trim();
  return `answer line after the options (“${prefix || q.printedAnswerRaw.trim().slice(0, 30)}”)`;
}

/** Facts measured on one paper → rule proposals (PAPER scope; exam rules come from generalize()). */
export function learnPaperRules(i: LearnInput): PaperRuleProposal[] {
  const out: PaperRuleProposal[] = [];
  const paperKey = i.paper ?? "UNKNOWN PAPER";
  const add = (kind: PaperRuleKind, valueKey: string, statement: string, value: Record<string, unknown>, evidence: PaperRuleEvidence) => out.push({ scope: "PAPER", paper: paperKey, kind, key: `${kind}:${valueKey}`, statement, value, evidence });
  const src = i.source;
  if (src && src.questions.length) {
    const n = src.questions.length;
    const style = dominant(src.numberStyles);
    if (style) add("NUMBERING", `${style[0]}|restarts:${src.sectionRestarts}`, `Questions are numbered “${style[0].replace("N", "1")}” … in ${src.sectionRestarts ? `${src.sectionRestarts + 1} sections that restart at 1` : "one sequence"} (${n} questions in this paper).`, { style: style[0], sectionRestarts: src.sectionRestarts, questions: n }, ev(i, "SOURCE_DOCUMENT", `${style[1]} of ${n} question lines use “${style[0]}”`, style[1], n));
    const labels = dominant(src.questions.filter((q) => q.options.length).map((q) => q.options[0].printed.replace(/[A-Ea-e]/, (c) => (c === c.toUpperCase() ? "A" : "a")).replace(/[1-5]/, "1")));
    if (labels) add("OPTION_LABELS", labels[0], `Options are labelled “${labels[0]}” … (four options per question).`, { label: labels[0] }, ev(i, "SOURCE_DOCUMENT", `${labels[1]} of ${n} questions`, labels[1], n));
    const headings = [...new Set(src.questions.map((q) => q.heading).filter((h): h is string => !!h))];
    const withHeading = src.questions.filter((q) => q.heading).length;
    add("SECTION_HEADINGS", headings.length ? headings.join("|") : "none", headings.length ? `Section headings are printed: ${headings.join(" · ")} — supporting evidence for subjects, never a rule on their own.` : "No section headings are printed — subjects come from each question's content.", { headings }, ev(i, "SOURCE_DOCUMENT", headings.length ? `${withHeading} of ${n} questions sit under a printed heading` : `0 of ${n} questions sit under a heading`, headings.length ? withHeading : n, n));
    const marks = src.questions.map(answerMarkStyle);
    const mark = dominant(marks.filter((m): m is string => !!m));
    if (mark) add("ANSWER_MARK", mark[0], `The paper prints the answer as ${/^[aeiou]/i.test(mark[0]) ? "an" : "a"} ${mark[0]} — an annotation of the source, not an official key.`, { style: mark[0] }, ev(i, "SOURCE_DOCUMENT", `${mark[1]} of ${n} questions; ${marks.filter((m) => !m).length} without a printed answer`, mark[1], n));
    else add("ANSWER_MARK", "none", "The paper prints no answers — answers come only from the official key.", { style: null }, ev(i, "SOURCE_DOCUMENT", `0 of ${n} questions print an answer`, n, n));
    const formats = new Map<QuestionFormat, number>();
    for (const q of src.questions) for (const f of questionFormats(q)) formats.set(f, (formats.get(f) ?? 0) + 1);
    const shown = [...formats.entries()].filter(([f]) => f !== "MARKED_OPTION").sort((a, b) => b[1] - a[1]);
    add("QUESTION_TYPES", `${i.jobId}`, `Question formats in this paper: ${shown.map(([f, c]) => `${f.toLowerCase().replace(/_/g, " ")} ${pct(c, n)}%`).join(", ") || "plain single-answer questions only"}.`, { formats: Object.fromEntries(formats), questions: n }, ev(i, "SOURCE_DOCUMENT", `${n} questions classified by their own text`, n, n));
    // Printed marks against an official key that an administrator approved: how far the source's own marks can be trusted.
    if (i.approvedKey) {
      let agree = 0;
      const disagree: number[] = [];
      for (const q of src.questions) {
        const k = q.number === null ? undefined : i.approvedKey.values.get(q.number);
        if (!k || !q.printedAnswer.length || /^(x|×|dropped|bonus|\*)$/i.test(k)) continue;
        if (k.toUpperCase().split(/[/,&\s]+/).includes(q.printedAnswer[0])) agree++;
        else disagree.push(q.number!);
      }
      const total = agree + disagree.length;
      if (total) add("ANNOTATION_RELIABILITY", `${(i.fileSha256 ?? i.fileName).slice(0, 16)}`, `Printed answer marks in “${i.fileName}” agree with the official key in ${agree} of ${total} questions${disagree.length ? ` (${disagree.length} contradict: ${disagree.slice(0, 12).join(", ")}${disagree.length > 12 ? " …" : ""}) — this source's marks are not answers` : ""}.`, { agree, total, disagree }, ev(i, "OFFICIAL_KEY", `compared with ${i.approvedKey.fileName}`, agree, total));
    }
  }
  if (i.approvedKey) {
    const values = [...i.approvedKey.values.values()];
    const expected = i.approvedKey.expected ?? values.length;
    add("ANSWER_KEY_LAYOUT", `${i.approvedKey.fileKind}|${i.approvedKey.read}|${expected}`, `The official key is a ${i.approvedKey.fileKind} file with ${expected} entries, read from its ${i.approvedKey.read}${values.some((v) => /[/,&]/.test(v)) ? "; it can accept two answers for one item (“A/B”)" : ""}.`, { fileKind: i.approvedKey.fileKind, read: i.approvedKey.read, expected }, ev(i, "OFFICIAL_KEY", `${values.length} of ${expected} entries matched to approved questions`, values.length, expected, { name: i.approvedKey.fileName, sha: i.approvedKey.fileSha256 }));
    const dropped = values.filter((v) => /^(x|×|dropped|deleted|withdrawn|bonus|\*)$/i.test(v.trim()));
    if (dropped.length) {
      const marker = dominant(dropped.map((d) => d.trim().toUpperCase()))![0];
      add("DROPPED_MARKER", marker, `A dropped item is printed as “${marker}” in the official key — such a question is never scored or imported with an answer.`, { marker }, ev(i, "OFFICIAL_KEY", `${dropped.length} dropped item(s)`, dropped.length, dropped.length, { name: i.approvedKey.fileName, sha: i.approvedKey.fileSha256 }));
    }
  }
  if (i.approvedSubjects && i.approvedSubjects.size) {
    const total = [...i.approvedSubjects.values()].reduce((a, b) => a + b, 0);
    const list = [...i.approvedSubjects.entries()].sort((a, b) => b[1] - a[1]);
    add("SUBJECT_SCOPE", list.map(([s]) => s).sort().join("|"), `${paperKey} covers: ${list.map(([s, c]) => `${s} (${c})`).join(", ")}.`, { subjects: Object.fromEntries(list) }, ev(i, "ADMIN_CONFIRMED", `${total} admin-approved questions`, total, total));
  }
  for (const c of i.ocrCorrections) add("OCR_CONFUSION", `${c.wrong}→${c.right}`, `OCR reads “${c.right}” as “${c.wrong}” — reported where it occurs, never replaced automatically.`, { wrong: c.wrong, right: c.right }, ev(i, "ADMIN_CONFIRMED", `${c.count} admin correction(s)`, c.count, c.count));
  return out;
}

const confidenceOf = (evidence: PaperRuleEvidence[]) => {
  const s = evidence.reduce((a, e) => a + e.supporting, 0);
  const o = evidence.reduce((a, e) => a + e.observed, 0);
  return { supporting: s, observed: o, confidence: o ? Math.round((s / o) * 1000) / 1000 : 0 };
};

/**
 * Merges proposals into the stored rules: the same fact (key) from the same import replaces its old evidence (learning a
 * paper twice changes nothing), from another import adds evidence. A different value for the same kind and paper marks
 * the stored rule as contradicted — a confirmed rule then needs review again. Exam rules are re-derived from paper rules.
 */
export function mergePaperRules(rules: PaperRule[], proposals: PaperRuleProposal[], now: string, newId: () => string): { rules: PaperRule[]; added: number; updated: number; contradicted: number } {
  const next = rules.map((r) => ({ ...r, evidence: [...r.evidence] }));
  let added = 0;
  let updated = 0;
  let contradicted = 0;
  for (const p of proposals) {
    const same = next.find((r) => r.scope === p.scope && r.paper === p.paper && r.key === p.key);
    if (same) {
      same.evidence = [...same.evidence.filter((e) => e.jobId !== p.evidence.jobId || e.source !== p.evidence.source), p.evidence];
      Object.assign(same, confidenceOf(same.evidence), { statement: p.statement, value: p.value, updatedAt: now });
      updated++;
    } else {
      next.push({ id: newId(), scope: p.scope, paper: p.paper, kind: p.kind, key: p.key, statement: p.statement, value: p.value, ...confidenceOf([p.evidence]), evidence: [p.evidence], status: "PROPOSED", contradictedBy: null, learnedAt: now, updatedAt: now, decidedById: null, decidedAt: null, note: null });
      added++;
    }
    // Per-import facts (formats, mark reliability) describe one paper each and never contradict another.
    if (p.kind === "QUESTION_TYPES" || p.kind === "ANNOTATION_RELIABILITY" || p.kind === "OCR_CONFUSION" || p.kind === "EXTRACTION_ERROR") continue;
    for (const other of next) {
      if (other.scope !== p.scope || other.paper !== p.paper || other.kind !== p.kind || other.key === p.key || other.status === "REJECTED") continue;
      if (other.contradictedBy !== p.key) contradicted++;
      other.contradictedBy = p.key;
      if (other.status === "CONFIRMED") other.status = "PROPOSED";
    }
  }
  return { rules: generalize(next, now, newId), added, updated, contradicted };
}

/** Exam-level proposals for facts that two or more different papers show (their evidence combined). */
export function generalize(rules: PaperRule[], now: string, newId: () => string): PaperRule[] {
  const out = [...rules];
  const byKey = new Map<string, PaperRule[]>();
  for (const r of rules) if (r.scope === "PAPER" && GENERALIZABLE.has(r.kind) && r.status !== "REJECTED") byKey.set(r.key, [...(byKey.get(r.key) ?? []), r]);
  for (const [key, list] of byKey) {
    const papers = new Set(list.map((r) => r.paper));
    if (papers.size < 2) continue;
    const evidence = list.flatMap((r) => r.evidence);
    const exam = out.find((r) => r.scope === "EXAM" && r.key === key);
    const statement = `${list[0].statement.replace(/\s*\(\d+ questions in this paper\)/, "")} Seen in ${[...papers].sort().join(", ")}.`;
    if (exam) Object.assign(exam, { evidence, ...confidenceOf(evidence), statement, updatedAt: now });
    else out.push({ ...list[0], id: newId(), scope: "EXAM", paper: null, statement, evidence, ...confidenceOf(evidence), status: "PROPOSED", contradictedBy: null, learnedAt: now, updatedAt: now, decidedById: null, decidedAt: null, note: null });
  }
  return out;
}

/** The confirmed rules that apply to one paper of the exam (exam rules + that paper's own). */
export function confirmedRulesFor(rules: PaperRule[], paper: string | null): PaperRule[] {
  return rules.filter((r) => r.status === "CONFIRMED" && !r.contradictedBy && (r.scope === "EXAM" || (paper !== null && r.paper === paper)));
}

/** Subjects a confirmed SUBJECT_SCOPE rule allows for this paper (null = no confirmed scope). */
export function confirmedSubjectScope(rules: PaperRule[], paper: string | null): Set<string> | null {
  const r = confirmedRulesFor(rules, paper).find((x) => x.kind === "SUBJECT_SCOPE" && x.scope === "PAPER");
  return r ? new Set(Object.keys((r.value.subjects as Record<string, number>) ?? {})) : null;
}

/** Word-level wrong → right pairs from an administrator's edit of AI-read text (single-word substitutions only). */
export function ocrPairs(before: string, after: string): { wrong: string; right: string }[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  if (a.length !== b.length || a.length > 400) return [];
  const out: { wrong: string; right: string }[] = [];
  for (let k = 0; k < a.length; k++) {
    const w = a[k].replace(/[.,;:?!()]+$/g, "");
    const r = b[k].replace(/[.,;:?!()]+$/g, "");
    if (w === r || w.length < 3 || Math.abs(w.length - r.length) > 2) continue;
    out.push({ wrong: w, right: r });
  }
  return out.length <= 5 ? out : [];
}

// ---- Use of confirmed memory: prompts, deterministic checks, learning from approved corrections ----------------------

/**
 * Extraction errors an administrator corrected, each with a deterministic detector. A confirmed EXTRACTION_ERROR rule
 * turns its detector on for that paper (exam rule: every paper) — a flag on matching questions, never a change.
 */
export const EXTRACTION_PATTERNS = {
  ANSWER_MARK_IN_TEXT: "a printed answer mark / answer line read into an option or the question text",
  OPTIONS_RUN_TOGETHER: "two options read as one (an option holds the next option's label)",
  NUMBER_MISSING: "the printed question number was not read",
  INSTRUCTION_AS_QUESTION: "an instruction to candidates read as a question",
  STATEMENTS_MERGED: "numbered statements run together in the question text",
} as const;
export type ExtractionPattern = keyof typeof EXTRACTION_PATTERNS;

type FieldName = import("@/lib/ai-import/types").VerifyFieldName;
type Q = Pick<ExtractedQuestion, "stem" | "options" | "number" | "section" | "printedAnswer">;

/** Where the pattern shows in this question (the field), or null when it does not. */
export function detectPattern(p: ExtractionPattern, e: Q): { field: FieldName; where: string } | null {
  switch (p) {
    case "ANSWER_MARK_IN_TEXT": {
      const m = mergedAnswerIn(e);
      if (m) return { field: (/^option [A-D]$/.test(m.where) ? m.where : "text") as FieldName, where: m.where };
      if (ANNOTATION_TAIL.test(e.stem)) return { field: "text", where: "question text" };
      const o = e.options.find((x) => ANNOTATION_TAIL.test(x.text));
      return o ? { field: `option ${o.label}` as FieldName, where: `option ${o.label}` } : null;
    }
    case "OPTIONS_RUN_TOGETHER": {
      if (e.options.length >= 4) return null;
      const o = e.options.find((x) => /(?:^|\s)\(?([b-eB-E])\)\s+\S/.test(x.text));
      return o ? { field: "options", where: `option ${o.label}` } : null;
    }
    case "NUMBER_MISSING":
      return e.number === null ? { field: "number", where: "question number" } : null;
    case "INSTRUCTION_AS_QUESTION":
      return candidateInstruction(e) ? { field: "text", where: "question text" } : null;
    case "STATEMENTS_MERGED":
      return mergedStatements(e.stem) ? { field: "text", where: "question text" } : null;
  }
}

/** Patterns an administrator's correction removed: present before, gone in the corrected (or rejected) question. */
export function correctionPatterns(before: Q, after: Q | null): ExtractionPattern[] {
  return (Object.keys(EXTRACTION_PATTERNS) as ExtractionPattern[]).filter((p) => {
    if (!detectPattern(p, before)) return false;
    // A rejection settles only "not a question"; every other pattern needs the corrected question to be free of it.
    if (after === null) return p === "INSTRUCTION_AS_QUESTION";
    return !detectPattern(p, after);
  });
}

export interface CorrectionItem {
  fileId: string;
  label: string;
  kind: "EDIT" | "REJECT";
  /** The question as it was before the administrator's first correction. */
  before: ExtractedQuestion;
  /** The question as approved (null for a rejection). */
  after: ExtractedQuestion | null;
  aiRead: boolean;
  /** The correction took a Verify 1 / Verify 2 suggestion that the administrator applied and then approved. */
  acceptedSuggestion: boolean;
}

/**
 * Rule proposals from the corrections an administrator CONFIRMED (approved questions with an admin edit, rejected
 * non-questions). Unapproved edits and AI suggestions nobody approved are never passed in. Every proposal is PROPOSED.
 */
export function correctionProposals(i: { jobId: string; jobTitle: string; paper: string | null; at: string; files: Map<string, { name: string; sha: string | null }>; items: CorrectionItem[] }): PaperRuleProposal[] {
  const out: PaperRuleProposal[] = [];
  const paperKey = i.paper ?? "UNKNOWN PAPER";
  const groups = new Map<ExtractionPattern, CorrectionItem[]>();
  for (const it of i.items) for (const p of correctionPatterns(it.before, it.after)) groups.set(p, [...(groups.get(p) ?? []), it]);
  const fileOf = (items: CorrectionItem[]) => {
    const ids = [...new Set(items.map((x) => x.fileId))];
    const first = i.files.get(ids[0]);
    return { name: ids.map((id) => i.files.get(id)?.name ?? id).join(", ").slice(0, 300), sha: ids.length === 1 ? (first?.sha ?? null) : null };
  };
  for (const [p, items] of groups) {
    const accepted = items.filter((x) => x.acceptedSuggestion).length;
    const sample = detectPattern(p, items[0].before)?.where ?? "";
    const evidence: PaperRuleEvidence = { jobId: i.jobId, jobTitle: i.jobTitle, fileName: fileOf(items).name, fileSha256: fileOf(items).sha, source: "ADMIN_CONFIRMED", detail: `${items.map((x) => `Q${x.label}`).slice(0, 15).join(", ")}${items.length > 15 ? " …" : ""}: ${items.length} correction(s) an administrator confirmed (${items.filter((x) => x.kind === "REJECT").length ? `${items.filter((x) => x.kind === "REJECT").length} rejected as not a question, ` : ""}${accepted ? `${accepted} from an accepted Verify suggestion, ` : ""}first in the ${sample})`.slice(0, 400), supporting: items.length, observed: items.length, at: i.at };
    out.push({ scope: "PAPER", paper: paperKey, kind: "EXTRACTION_ERROR", key: `EXTRACTION_ERROR:${p}`, statement: `Known extraction error in ${paperKey}: ${EXTRACTION_PATTERNS[p]} — corrected by an administrator in ${items.length} question(s); questions showing it again are flagged.`, value: { pattern: p }, evidence });
  }
  // OCR confusions: word substitutions an administrator made to AI-read text (approved questions only).
  const ocr = new Map<string, { wrong: string; right: string; count: number; files: Set<string> }>();
  for (const it of i.items) {
    if (!it.aiRead || it.kind !== "EDIT" || !it.after) continue;
    const pairs = [...ocrPairs(it.before.stem, it.after.stem), ...it.before.options.flatMap((o) => ocrPairs(o.text, it.after!.options.find((x) => x.label === o.label)?.text ?? o.text))];
    for (const pr of pairs) {
      const k = `${pr.wrong}→${pr.right}`;
      const cur = ocr.get(k) ?? { ...pr, count: 0, files: new Set<string>() };
      cur.count++;
      cur.files.add(it.fileId);
      ocr.set(k, cur);
    }
  }
  for (const c of ocr.values()) {
    const f = i.files.get([...c.files][0]);
    out.push({ scope: "PAPER", paper: paperKey, kind: "OCR_CONFUSION", key: `OCR_CONFUSION:${c.wrong}→${c.right}`, statement: `OCR reads “${c.right}” as “${c.wrong}” — reported where it occurs, never replaced automatically.`, value: { wrong: c.wrong, right: c.right }, evidence: { jobId: i.jobId, jobTitle: i.jobTitle, fileName: f?.name ?? "", fileSha256: f?.sha ?? null, source: "ADMIN_CONFIRMED", detail: `${c.count} admin correction(s) of approved question(s)`, supporting: c.count, observed: c.count, at: i.at } });
  }
  return out;
}

export type MemoryPurpose = "extract" | "key" | "classify";
const PURPOSE_KINDS: Record<MemoryPurpose, PaperRuleKind[]> = {
  extract: ["NUMBERING", "OPTION_LABELS", "SECTION_HEADINGS", "ANSWER_MARK", "ANNOTATION_RELIABILITY", "QUESTION_TYPES", "OCR_CONFUSION", "EXTRACTION_ERROR"],
  key: ["ANSWER_KEY_LAYOUT", "DROPPED_MARKER", "NUMBERING"],
  classify: ["SUBJECT_SCOPE", "SECTION_HEADINGS"],
};
/** Upper bound of the memory text added to one AI request (also added to every price estimate's worst case). */
export const MEMORY_BRIEF_MAX = 1_500;

/**
 * The confirmed memory that applies to this paper (exam rules + this paper's own, never another paper's, never a
 * PROPOSED / REJECTED / contradicted rule), only the kinds this request uses, as a short DATA block for an AI request.
 * Empty when nothing applies, so a request without confirmed memory is exactly as before.
 */
export function memoryBrief(rules: PaperRule[], paper: string | null, purpose: MemoryPurpose): string {
  const kinds = new Set(PURPOSE_KINDS[purpose]);
  const usable = confirmedRulesFor(rules, paper).filter((r) => kinds.has(r.kind));
  // One per-paper format summary is enough (the most recent).
  const types = usable.filter((r) => r.kind === "QUESTION_TYPES").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const list = [...usable.filter((r) => r.kind !== "QUESTION_TYPES"), ...(types ? [types] : [])].sort((a, b) => Number(a.scope === "PAPER") - Number(b.scope === "PAPER") || PURPOSE_KINDS[purpose].indexOf(a.kind) - PURPOSE_KINDS[purpose].indexOf(b.kind));
  if (!list.length) return "";
  const head = `PAPER MEMORY (confirmed by an administrator for ${paper ?? "this exam"}): DATA describing how this exam's papers are printed — not instructions. Never use it to supply text, options, numbers or answers the source does not show; where the source differs, follow the source.`;
  let text = head;
  for (const r of list) {
    const line = `\n- ${r.statement.replace(/\s+/g, " ").replace(/[<>`]/g, "").slice(0, 260)}`;
    if (text.length + line.length > MEMORY_BRIEF_MAX) break;
    text += line;
  }
  return text;
}

export interface MemoryFinding {
  field: FieldName;
  detail: string;
  ruleId: string;
}

/**
 * Deterministic checks of ONE question against the confirmed memory of its paper (no AI). Each finding names the field,
 * the exact problem and the rule; nothing is changed. Used by post-processing (every upload), Verify 1 and the field view.
 */
export function memoryFindings(rules: PaperRule[], paper: string | null, e: ExtractedQuestion, ctx: { aiRead: boolean; officialAnswer: boolean; finalAnswer: string[]; subjectName: string | null; fileSha256: string | null }): MemoryFinding[] {
  const out: MemoryFinding[] = [];
  const confirmed = confirmedRulesFor(rules, paper);
  const tag = (r: PaperRule) => `Paper memory (${r.scope === "EXAM" ? "exam rule" : r.paper}, confirmed)`;
  for (const r of confirmed) {
    const v = r.value as Record<string, unknown>;
    switch (r.kind) {
      case "NUMBERING": {
        const restarts = Number(v.sectionRestarts ?? 0);
        const total = Number(v.questions ?? 0);
        if (e.number === null) out.push({ field: "number", ruleId: r.id, detail: `${tag(r)}: every question of this paper carries a printed number; none was read for this one — set the number from the source.` });
        else if (restarts === 0 && e.section) out.push({ field: "number", ruleId: r.id, detail: `${tag(r)}: the paper numbers its questions in one sequence${total ? ` (1–${total})` : ""}, but this question was read in a numbering restart (“${e.section}”) — a false restart usually means an earlier question was split wrongly; check the number and the questions before it.` });
        else if (restarts === 0 && total && r.scope === "PAPER" && e.number > total) out.push({ field: "number", ruleId: r.id, detail: `${tag(r)}: the paper has ${total} questions; Q${e.number} is beyond them — check the number.` });
        break;
      }
      case "OPTION_LABELS":
        if (e.options.length !== 4 && !candidateInstruction(e)) out.push({ field: "options", ruleId: r.id, detail: `${tag(r)}: every question has four options labelled “${String(v.label ?? "(a)")}”; ${e.options.length} were read — check for options run together or lost.` });
        break;
      case "ANNOTATION_RELIABILITY": {
        const agree = Number(v.agree ?? 0);
        const total = Number(v.total ?? 0);
        const fromMark = !ctx.officialAnswer && e.printedAnswer.length > 0 && ctx.finalAnswer.length > 0 && [...e.printedAnswer].sort().join() === [...ctx.finalAnswer].sort().join();
        if (fromMark && total && agree < total) {
          const same = r.evidence.some((x) => x.fileSha256 && x.fileSha256 === ctx.fileSha256);
          if (same || !out.some((x) => x.field === "answer")) out.push({ field: "answer", ruleId: r.id, detail: `${tag(r)}: printed answer marks in ${same ? "this file" : "this paper's source files"} contradicted the official key in ${total - agree} of ${total} questions; this answer comes only from a printed mark — confirm it against the official key before approving.` });
        }
        break;
      }
      case "ANSWER_MARK":
        if (v.style === null && e.printedAnswer.length) out.push({ field: "answer", ruleId: r.id, detail: `${tag(r)}: this paper prints no answers, but a printed answer (${e.printedAnswer.join(", ")}) was read — check that option or question text was not taken as an answer.` });
        break;
      case "OCR_CONFUSION": {
        if (!ctx.aiRead) break;
        const wrong = String(v.wrong ?? "");
        if (!wrong) break;
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])${wrong.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "u");
        const where = re.test(e.stem) ? "text" : e.options.find((o) => re.test(o.text));
        if (where) out.push({ field: where === "text" ? "text" : (`option ${(where as { label: string }).label}` as FieldName), ruleId: r.id, detail: `${tag(r)}: OCR has read “${String(v.right)}” as “${wrong}” before; this question contains “${wrong}” — check it against the source (suggestion: “${String(v.right)}”, only if the source shows it).` });
        break;
      }
      case "EXTRACTION_ERROR": {
        const p = v.pattern as ExtractionPattern;
        if (!(p in EXTRACTION_PATTERNS)) break;
        const hit = detectPattern(p, e);
        if (hit) out.push({ field: hit.field, ruleId: r.id, detail: `${tag(r)}: known extraction error of this paper — ${EXTRACTION_PATTERNS[p]} — shows again in the ${hit.where}; check it against the source.` });
        break;
      }
      case "SUBJECT_SCOPE": {
        if (r.scope !== "PAPER" || !ctx.subjectName) break;
        const scope = Object.keys((v.subjects as Record<string, number>) ?? {});
        if (scope.length && !scope.includes(ctx.subjectName)) out.push({ field: "subject", ruleId: r.id, detail: `${tag(r)}: ${paper} covers ${scope.join(", ")}; this question's subject “${ctx.subjectName}” is outside them — check the subject.` });
        break;
      }
      default:
        break;
    }
  }
  return out;
}
