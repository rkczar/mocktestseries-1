/**
 * Field-level results of Verify 1 / Verify 2 (pure — no I/O). Every question is judged field by field — number, text,
 * options A–D, answer, type, subject, topic, source fidelity — so the administrator sees which field has a problem,
 * what exactly is wrong, and (only when a source, a second read or a key really shows another value) a suggestion
 * with its evidence. Nothing here changes a question; a suggestion is applied only by an administrator.
 */
import type { ExtractedQuestion, FieldCheck, TaxonomyVerification, VerifyFieldName, VerifyFix, VerifyProblem } from "@/lib/ai-import/types";
import type { MemoryFinding } from "@/lib/ai-import/paper-memory";

type Field = VerifyFieldName;

/** The field each finding code is about (option-specific codes take the option named in their detail). */
const CODE_FIELD: Record<string, Field> = {
  NUMBER_CONFLICT: "number",
  NUMBERING_GAP: "number",
  DUPLICATE_NUMBER: "number",
  QUESTION_TEXT_SUSPECT: "text",
  STATEMENTS_MERGED: "text",
  ANSWER_IN_OPTION: "options",
  OPTIONS_INCOMPLETE: "options",
  EXTRACTION_UNCERTAIN: "source",
  UNREADABLE_TEXT: "source",
  FORMULA_ISSUE: "source",
  IMAGE_MISSING: "source",
  IMAGE_MAPPING_UNCERTAIN: "source",
  IMAGE_REFERENCE_UNCERTAIN: "source",
  REFERENCE_CONFLICT: "source",
  FORMAT_DEVIATION: "source",
  ANSWER_MISMATCH: "answer",
  ANSWER_AMBIGUOUS: "answer",
  ANSWER_MISSING: "answer",
  ANSWER_KEY_PAPER_MISMATCH: "answer",
  POSSIBLE_WITHDRAWN: "answer",
  AI_OPINION_DIFFERS: "answer",
  ANSWER_TYPE_CONFLICT: "type",
  UNSUPPORTED_TYPE: "type",
  SUBJECT_UNKNOWN: "subject",
  SUBJECT_MISMATCH: "subject",
  CLASSIFICATION_FAILED: "subject",
  SECTION_SUBJECT_DIFFERS: "subject",
  TAXONOMY_DISAGREES: "subject",
  TOPIC_UNCERTAIN: "topic",
};

function fieldOf(code: string, detail: string): Field | null {
  const base = CODE_FIELD[code];
  if (!base) return null;
  if (base === "options" || base === "source") {
    const m = /\boption ([A-D])\b/i.exec(detail);
    if (m && code !== "OPTIONS_INCOMPLETE") return `option ${m[1].toUpperCase()}` as Field;
    if (code === "ANSWER_IN_OPTION" && /question text/i.test(detail)) return "text";
  }
  return base;
}

export interface AnswerFacts {
  final: string[];
  official: string[];
  status: string;
  /** An administrator chose the answer by hand. */
  adminConfirmed: boolean;
}

function answerCheck(a: AnswerFacts, by: "V1" | "V2", printed: string[]): FieldCheck {
  if (a.status === "WITHDRAWN") return { field: "answer", status: "OK", evidence: "the official key drops this item (no answer is stored)", by };
  if (!a.final.length) return { field: "answer", status: "PROBLEM", problem: "no answer is set", suggestion: a.official.length ? a.official.join(", ") : null, evidence: a.official.length ? "the official answer key" : null, by };
  if (a.status === "OFFICIAL_MATCHED") return { field: "answer", status: "OK", evidence: `matches the official answer key (${a.official.join(", ")})`, by };
  if (a.official.length && [...a.official].sort().join() !== [...a.final].sort().join()) return { field: "answer", status: "PROBLEM", problem: `answer ${a.final.join(", ")} differs from the official key (${a.official.join(", ")})`, suggestion: a.official.join(", "), evidence: "the official answer key (an administrator decides)", by };
  if (a.adminConfirmed) return { field: "answer", status: "OK", evidence: `set by an administrator (${a.final.join(", ")})`, by };
  return { field: "answer", status: "NOT_CHECKED", problem: `no official key entry is matched — the answer ${a.final.join(", ")} comes from ${printed.length && [...printed].sort().join() === [...a.final].sort().join() ? "a mark printed in the paper" : "the import, not a key"}; it is not verified`, by };
}

function taxonomyChecks(c: TaxonomyVerification | null | undefined, name: (id: string | null | undefined) => string | null, by: "V1" | "V2"): FieldCheck[] {
  if (!c) return [
    { field: "subject", status: "NOT_CHECKED", problem: "not checked", by },
    { field: "topic", status: "NOT_CHECKED", problem: "not checked", by },
  ];
  const ev = c.findings.join(" · ").slice(0, 300) || null;
  if (c.status === "AGREED") return [
    { field: "subject", status: "OK", evidence: ev, by },
    { field: "topic", status: c.stored.topicId ? "OK" : "NOT_CHECKED", problem: c.stored.topicId ? null : "no topic is stored", evidence: ev, by },
  ];
  if (c.status === "NOT_VERIFIED" || c.status === "VERIFICATION_FAILED") return [
    { field: "subject", status: "NOT_CHECKED", problem: ev ?? c.status.toLowerCase().replace(/_/g, " "), by },
    { field: "topic", status: "NOT_CHECKED", problem: ev ?? c.status.toLowerCase().replace(/_/g, " "), by },
  ];
  const subjectDiffers = !!c.found?.subjectId && c.found.subjectId !== c.stored.subjectId;
  const topicDiffers = !!c.found?.topicId && c.found.topicId !== c.stored.topicId;
  return [
    subjectDiffers || !c.stored.subjectId
      ? { field: "subject", status: "PROBLEM", problem: c.stored.subjectId ? `stored ${name(c.stored.subjectId) ?? "subject"} is not confirmed` : "no subject is stored", suggestion: name(c.found?.subjectId), evidence: ev, by }
      : { field: "subject", status: "OK", evidence: ev, by },
    topicDiffers || (!c.stored.topicId && !subjectDiffers)
      ? { field: "topic", status: "PROBLEM", problem: c.stored.topicId ? `stored ${name(c.stored.topicId) ?? "topic"} is not confirmed` : "no topic is stored", suggestion: name(c.found?.topicId), evidence: ev, by }
      : { field: "topic", status: subjectDiffers ? "NOT_CHECKED" : "OK", problem: subjectDiffers ? "depends on the subject" : null, evidence: ev, by },
  ];
}

/** Merges findings into one check per field (a problem outranks not-checked, which outranks OK). */
function merge(list: FieldCheck[]): FieldCheck[] {
  const rank = { PROBLEM: 2, NOT_CHECKED: 1, OK: 0 } as const;
  const out = new Map<Field, FieldCheck>();
  for (const c of list) {
    const cur = out.get(c.field);
    if (!cur || rank[c.status] > rank[cur.status]) out.set(c.field, { ...c });
    else if (rank[c.status] === rank[cur.status] && c.status === "PROBLEM") {
      cur.problem = [cur.problem, c.problem].filter(Boolean).join(" · ").slice(0, 900);
      cur.suggestion ??= c.suggestion ?? null;
      cur.evidence = [cur.evidence, c.evidence].filter(Boolean).join(" · ").slice(0, 600) || null;
    }
  }
  return [...out.values()];
}

/** Verify 1 (deterministic): its findings, its source corrections, the question's flags and confirmed-memory findings, per field. */
export function v1FieldChecks(i: { e: ExtractedQuestion; problems: VerifyProblem[]; fixes: VerifyFix[]; issueCodes: string[]; issueLabel: (code: string) => string; memory: MemoryFinding[]; answer: AnswerFacts; classification: TaxonomyVerification | null | undefined; name: (id: string | null | undefined) => string | null; documentText: boolean }): FieldCheck[] {
  const list: FieldCheck[] = [];
  const e = i.e;
  list.push({ field: "number", status: e.number === null ? "PROBLEM" : "OK", problem: e.number === null ? "no question number was read" : null, evidence: e.number === null ? null : `Q${e.number}${e.section ? ` (${e.section})` : ""}`, by: "V1" });
  list.push({ field: "text", status: e.stem.trim() ? "OK" : "PROBLEM", problem: e.stem.trim() ? null : "the question text is empty", by: "V1" });
  for (const l of ["A", "B", "C", "D"]) {
    const o = e.options.find((x) => x.label === l);
    list.push({ field: `option ${l}` as Field, status: o?.text.trim() ? "OK" : "PROBLEM", problem: o ? (o.text.trim() ? null : `option ${l} has no text`) : `option ${l} is missing`, by: "V1" });
  }
  list.push({ field: "options", status: e.options.length === 4 ? "OK" : "PROBLEM", problem: e.options.length === 4 ? null : `${e.options.length} option(s) read; four are needed`, by: "V1" });
  list.push({ field: "type", status: "OK", evidence: e.type.toLowerCase().replace(/_/g, " "), by: "V1" });
  list.push({ field: "source", status: i.documentText ? "OK" : "NOT_CHECKED", evidence: i.documentText ? "read from the document's own text" : null, problem: i.documentText ? null : "a page image read by AI — Verify 2 compares it with an independent read", by: "V1" });
  list.push(answerCheck(i.answer, "V1", e.printedAnswer));
  list.push(...taxonomyChecks(i.classification, i.name, "V1"));
  const seen = new Set<string>();
  for (const p of i.problems) {
    if (p.detail.startsWith("Paper memory")) continue; // listed below with their own field
    const f = fieldOf(p.code, p.detail);
    if (!f) continue;
    seen.add(p.code);
    list.push({ field: f, status: "PROBLEM", problem: p.detail.slice(0, 600), by: "V1" });
  }
  for (const code of i.issueCodes) {
    if (seen.has(code) || code === "VERIFY2_DISAGREES" || code === "VERIFY_DISAGREES") continue;
    const f = fieldOf(code, "");
    if (f && f !== "source") list.push({ field: f, status: "PROBLEM", problem: i.issueLabel(code), by: "V1" });
  }
  // Paper-memory findings stay their own entries (one per field), so each note keeps its source.
  const checks = [...merge(list), ...merge(i.memory.map((m): FieldCheck => ({ field: m.field, status: "PROBLEM", problem: m.detail.slice(0, 600), by: "MEMORY" })))];
  // Corrections Verify 1 already made from the source are recorded as the evidence of the corrected field.
  for (const f of i.fixes) {
    const field = (f.field === "question text" ? "text" : /^option [A-D]$/.test(f.field) ? f.field : f.field === "printed answer" ? "answer" : null) as Field | null;
    const c = field && checks.find((x) => x.field === field && x.by === "V1");
    if (c) c.evidence = [c.evidence, `corrected by Verify 1 from the source (${f.evidence})`].filter(Boolean).join(" · ").slice(0, 600);
  }
  return order(checks);
}

const nrm = (s: string) => s.toLowerCase().replace(/\$|\\[a-z]+|[\s.,;:()[\]{}'"`]/g, "");

/**
 * Verify 2: the stored question against the independent second read, per field. A suggestion is the second read's own
 * value for that field (never anything else); its evidence says whether the source text itself contains it.
 */
export function v2FieldChecks(i: { e: ExtractedQuestion; twin: ExtractedQuestion | null; model: string; part: string | null; sourceText: string | null; fields: string[]; resolvedBySource: boolean; answer: AnswerFacts; typeDiffers: boolean; missingNumbers: string[]; memoryUsed: boolean; unreliableMarks: boolean }): FieldCheck[] {
  const e = i.e;
  const where = `${i.model}${i.part ? `, ${i.part}` : ""}${i.memoryUsed ? ", with confirmed paper memory" : ""}`;
  if (!i.twin) return order([{ field: "number", status: "PROBLEM", problem: `the independent read (${where}) did not find Q${e.number ?? "?"}${e.section ? ` (${e.section})` : ""} in the source — check the number and whether the question exists`, by: "V2" }]);
  const twin = i.twin;
  const src = i.sourceText ? nrm(i.sourceText) : null;
  const inSource = (t: string) => (src === null ? null : !!t.trim() && src.includes(nrm(t)));
  const evidenceFor = (stored: string, second: string) => {
    const s1 = inSource(stored);
    const s2 = inSource(second);
    if (s1 === null) return `independent read (${where}); scanned page — compare with the page image`;
    return `independent read (${where}); the source text ${s2 ? "contains the suggested wording" : "does not contain the suggested wording exactly"}${s1 ? " and contains the stored wording" : ", nor the stored wording"}`;
  };
  const list: FieldCheck[] = [{ field: "number", status: "OK", evidence: `found as Q${twin.number ?? "?"} by ${where}`, by: "V2" }];
  const textDiff = i.fields.includes("question text") || i.fields.includes("question text numbers");
  if (!textDiff) list.push({ field: "text", status: "OK", evidence: `agrees with ${where}`, by: "V2" });
  else if (i.resolvedBySource) list.push({ field: "text", status: "OK", evidence: "the reads differ, but the source text contains the stored wording exactly", by: "V2" });
  else list.push({ field: "text", status: "PROBLEM", problem: `the question text differs from the independent read${i.fields.includes("question text numbers") ? " (numbers / symbols differ)" : ""}`, suggestion: twin.stem.slice(0, 4000), evidence: evidenceFor(e.stem, twin.stem), by: "V2" });
  if (i.fields.includes("options count")) list.push({ field: "options", status: "PROBLEM", problem: `${e.options.length} option(s) stored, ${twin.options.length} in the independent read`, evidence: `independent read (${where})`, by: "V2" });
  else list.push({ field: "options", status: "OK", evidence: `${twin.options.length} options in both reads`, by: "V2" });
  for (const o of e.options) {
    const f = `option ${o.label}` as Field;
    const other = twin.options[e.options.indexOf(o)];
    const diff = i.fields.includes(f) || i.fields.includes(`${f} numbers`);
    if (!diff || !other) list.push({ field: f, status: other ? "OK" : "NOT_CHECKED", problem: other ? null : "not in the independent read", evidence: other ? `agrees with ${where}` : null, by: "V2" });
    else if (i.resolvedBySource) list.push({ field: f, status: "OK", evidence: "the reads differ, but the source text contains the stored option exactly", by: "V2" });
    else list.push({ field: f, status: "PROBLEM", problem: `option ${o.label} differs from the independent read${i.fields.includes(`${f} numbers`) ? " (numbers / symbols differ)" : ""}`, suggestion: other.text.slice(0, 2000), evidence: evidenceFor(o.text, other.text), by: "V2" });
  }
  const a = answerCheck(i.answer, "V2", e.printedAnswer);
  if (a.status === "NOT_CHECKED" && twin.printedAnswer.length && [...twin.printedAnswer].sort().join() !== [...i.answer.final].sort().join())
    list.push({ field: "answer", status: "PROBLEM", problem: `no official key entry; the stored answer ${i.answer.final.join(", ")} differs from the printed answer ${twin.printedAnswer.join(", ")} in the independent read${i.unreliableMarks ? " — and this paper's printed marks are known to contradict the official key, so neither is an answer until the key is checked" : ""}`, evidence: `independent read (${where})`, by: "V2" });
  else list.push(a);
  list.push(i.typeDiffers ? { field: "type", status: "PROBLEM", problem: `stored as ${e.type.toLowerCase().replace(/_/g, " ")}, read as ${twin.type.toLowerCase().replace(/_/g, " ")}`, suggestion: twin.type, evidence: `independent read (${where})`, by: "V2" } : { field: "type", status: "OK", evidence: e.type.toLowerCase().replace(/_/g, " "), by: "V2" });
  list.push(
    i.missingNumbers.length
      ? { field: "source", status: "PROBLEM", problem: `number(s) ${i.missingNumbers.slice(0, 8).join(", ")} of the stored question are not in the source text — an OCR / transcription change`, evidence: "the source text of this part", by: "V2" }
      : i.fields.includes("figures") || i.fields.includes("figure placement")
        ? { field: "source", status: "PROBLEM", problem: "the figures differ from the independent read", evidence: `independent read (${where})`, by: "V2" }
        : { field: "source", status: src === null ? "NOT_CHECKED" : "OK", problem: src === null ? "scanned page — no text layer to compare characters with" : null, evidence: src === null ? null : "stored numbers / symbols all occur in the source text", by: "V2" },
  );
  return order(merge(list));
}

/** Display order of the fields. */
function order(list: FieldCheck[]): FieldCheck[] {
  const at = (f: Field) => ["number", "text", "options", "option A", "option B", "option C", "option D", "answer", "type", "subject", "topic", "source"].indexOf(f);
  return [...list].sort((a, b) => at(a.field) - at(b.field));
}

export interface FieldBoardRow {
  field: Field;
  status: "OK" | "PROBLEM" | "NOT_CHECKED";
  notes: { by: FieldCheck["by"]; problem: string | null; suggestion: string | null; evidence: string | null; status: FieldCheck["status"] }[];
}

/**
 * One row per field from the CURRENT Verify 1 and Verify 2 results (an out-of-date result is left out by the caller) and
 * the Verify 2 classification: worst status wins; every note is kept with who found it.
 */
export function fieldBoard(v1: FieldCheck[] | null | undefined, v2: FieldCheck[] | null | undefined, v2Taxonomy: FieldCheck[] | null = null): FieldBoardRow[] {
  const rows = new Map<Field, FieldBoardRow>();
  for (const c of [...(v1 ?? []), ...(v2 ?? []), ...(v2Taxonomy ?? [])]) {
    const r = rows.get(c.field) ?? { field: c.field, status: "NOT_CHECKED" as FieldBoardRow["status"], notes: [] };
    r.notes.push({ by: c.by, problem: c.problem ?? null, suggestion: c.suggestion ?? null, evidence: c.evidence ?? null, status: c.status });
    // A problem from any check stays a problem; otherwise one check that verified the field makes it OK.
    r.status = r.notes.some((n) => n.status === "PROBLEM") ? "PROBLEM" : r.notes.some((n) => n.status === "OK") ? "OK" : "NOT_CHECKED";
    rows.set(c.field, r);
  }
  const at = (f: Field) => ["number", "text", "options", "option A", "option B", "option C", "option D", "answer", "type", "subject", "topic", "source"].indexOf(f);
  return [...rows.values()].sort((a, b) => at(a.field) - at(b.field));
}

/** The Verify 2 subject / topic classification as field checks (for the board). */
export function v2TaxonomyChecks(c: TaxonomyVerification | null | undefined, name: (id: string | null | undefined) => string | null): FieldCheck[] | null {
  return c ? taxonomyChecks(c, name, "V2") : null;
}
