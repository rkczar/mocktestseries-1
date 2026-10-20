import "server-only";
import { AiImportAnswerStatus, AiImportPaperType, AiImportQuestionStatus, type AiImportQuestion, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { taxonomyNameKey } from "@/lib/exam-taxonomy";
import { lintRichSource, looksRich } from "@/lib/rich-import/manifest";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import { importerAiCall, importerAiCallChecked, parseModelJson, ImporterAiFailure, ImporterAiUnavailable } from "@/lib/ai-import/ai";
import { failureMessage } from "@/lib/ai-import/failure";
import { keyPaperChecks } from "@/lib/ai-import/key-check";
import { logEvent } from "@/lib/ai-import/jobs";
import { CLASSIFY_SYSTEM, SOLVE_SYSTEM, classifySchema, labelFromPrinted, solveSchema, solveUserText } from "@/lib/ai-import/prompts";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { lostSuperscript, numbersMissingFromSource, optionProblems, parseKeyAnswer, placeholderStem } from "@/lib/ai-import/fidelity";
import type { StepContext } from "@/lib/ai-import/process";

/**
 * After extraction: answer keys → answer status, optional independent AI
 * opinion, taxonomy mapping (existing ids only), duplicate detection, and the
 * four verification stages, persisted per question (AiImportCheck). Then each
 * question gets its status: READY / NEEDS_CORRECTION / NOT_IMPORTABLE /
 * DUPLICATE. Re-running is safe: imported, published, rejected or
 * admin-handled answers are never overwritten.
 */

const OPEN: AiImportQuestionStatus[] = [AiImportQuestionStatus.EXTRACTED, AiImportQuestionStatus.READY, AiImportQuestionStatus.NEEDS_CORRECTION, AiImportQuestionStatus.NOT_IMPORTABLE, AiImportQuestionStatus.DUPLICATE, AiImportQuestionStatus.IMPORT_FAILED];

export function effective(q: Pick<AiImportQuestion, "data" | "editedData">): ExtractedQuestion {
  return ((q.editedData ?? q.data) as unknown) as ExtractedQuestion;
}

export const IMPORTABLE = new Set(["SINGLE_CORRECT", "MULTIPLE_CORRECT", "MATCH_THE_FOLLOWING", "ASSERTION_REASON"]);

const WITHDRAWN = /^(bonus|dropped|deleted|withdrawn|\*|x)$/i;
/** A question that refers to a figure: a figure word, not just "given below" (which usually introduces a list or code table, seen 2026-10-20). */
export const MENTIONS_FIGURE = /\b(figure|fig\.|diagram|graph|image|picture|photograph|radiograph|x-ray|circuit shown|structure shown)\b/i;

/**
 * Flags an admin's review clears. Structural problems (options, type, images, answer) must be fixed, not
 * approved — and an uncertain image placement is cleared only by confirming each figure's placement.
 */
export const REVIEWABLE = ["EXTRACTION_UNCERTAIN", "UNREADABLE_TEXT", "FORMULA_ISSUE", "DUPLICATE_NEAR", "NUMBERING_GAP", "AI_OPINION_DIFFERS", "TOPIC_UNCERTAIN", "VERIFY_DISAGREES"];

interface Check {
  stage: number;
  name: string;
  passed: boolean;
  severity: "INFO" | "WARNING" | "ERROR";
  method: string;
  model?: string | null;
  detail: string;
}

// ---- Text similarity (duplicates) -------------------------------------------------------------------

export function normalizeForDup(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\$[^$]*\$/g, (m) => m.replace(/\s+/g, ""))
    .replace(/[^\p{L}\p{N}$\\^_{}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word set + word pairs of a normalized text (pairs keep word order; the set tolerates a dropped word). */
const STOPWORDS = new Set(["the", "a", "an", "of", "and", "is", "are", "to", "in", "for", "which", "what", "following"]);

function shingles(s: string): { words: Set<string>; pairs: Set<string> } {
  const w = s.split(" ").filter((x) => x && !STOPWORDS.has(x));
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < w.length; i++) pairs.add(`${w[i]} ${w[i + 1]}`);
  return { words: new Set(w), pairs };
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Near-duplicate score 0..1: the mean of word-set and word-pair similarity. Only byte-level equality counts as "exact". */
export function similarity(a: { words: Set<string>; pairs: Set<string> }, b: { words: Set<string>; pairs: Set<string> }): number {
  return (jaccard(a.words, b.words) + jaccard(a.pairs, b.pairs)) / 2;
}

function dupText(q: Pick<ExtractedQuestion, "stem" | "options">): string {
  return normalizeForDup(`${q.stem} ${q.options.map((o) => o.text).join(" ")}`);
}

// ---- Answer keys ------------------------------------------------------------------------------------

interface KeyRow {
  id: string;
  sourceNumber: number;
  section: string;
  rawValue: string;
  page: number | null;
  paperFileId: string | null;
}

/** Assigns sections to key entries whose numbering restarts (1..n, 1..m) — the same rule as the paper. */
function sectionKeys(rows: KeyRow[]): KeyRow[] {
  const out: KeyRow[] = [];
  let last = 0;
  let idx = 1;
  for (const r of rows) {
    if (r.section) {
      out.push(r);
      continue;
    }
    if (last >= 5 && r.sourceNumber === 1) idx++;
    last = r.sourceNumber;
    out.push({ ...r, section: idx > 1 ? `S${idx}` : "" });
  }
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

// ---- Main ---------------------------------------------------------------------------------------------

/** `only`: re-check just these questions (admin edits) — everything else is read, not rewritten. */
export async function runPostProcessing(ctx: StepContext, only?: Set<string>): Promise<void> {
  const job = ctx.job;
  const settings = ctx.settings;
  const questions = await prisma.aiImportQuestion.findMany({ where: { jobId: job.id }, orderBy: [{ fileId: "asc" }, { orderIndex: "asc" }], include: { figures: true } });
  const open = questions.filter((q) => OPEN.includes(q.status));
  if (!open.length) return;

  // ---- Answer keys ----
  const keyRowsRaw = await prisma.aiImportKeyEntry.findMany({ where: { jobId: job.id }, orderBy: [{ keyFileId: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
  const byPaper = new Map<string, KeyRow[]>();
  const papers = [...new Set(questions.map((q) => q.fileId))];
  for (const r of keyRowsRaw) {
    const paper = r.paperFileId ?? (papers.length === 1 ? papers[0] : null);
    if (!paper) continue;
    const list = byPaper.get(paper) ?? [];
    list.push({ id: r.id, sourceNumber: r.sourceNumber, section: r.section, rawValue: r.rawValue, page: r.page, paperFileId: paper });
    byPaper.set(paper, list);
  }
  const keyFor = new Map<string, { rows: KeyRow[]; method: string }>();
  /** Papers whose key could not be matched by number safely (the reason is shown on each question). */
  const unsafeKeyPapers = new Map<string, string>();
  for (const paper of papers) {
    const rows = byPaper.get(paper);
    if (!rows?.length) continue;
    const qs = questions.filter((q) => q.fileId === paper).sort((a, b) => a.orderIndex - b.orderIndex);
    const paperSections = new Set(qs.map((q) => effective(q).section));
    const sectioned = sectionKeys(rows);
    const keyHasSections = new Set(sectioned.map((r) => r.section)).size > 1;
    const direct = new Map<string, KeyRow[]>();
    for (const r of sectioned) direct.set(`${r.section}#${r.sourceNumber}`, [...(direct.get(`${r.section}#${r.sourceNumber}`) ?? []), r]);
    if (paperSections.size > 1 && !keyHasSections) {
      // Paper restarts numbering per section, key numbers continuously (1…N): each section's numbers are
      // offset by the sizes of the sections before it — matched by number, never by position. Used only
      // when the section sizes add up to the key exactly; otherwise nothing is matched and it is reported.
      const order: { section: string; max: number }[] = [];
      for (const q of qs) {
        const e = effective(q);
        if (e.number === null) continue;
        const g = order.find((x) => x.section === e.section);
        if (g) g.max = Math.max(g.max, e.number);
        else order.push({ section: e.section, max: e.number });
      }
      const keyMax = Math.max(...rows.map((r) => r.sourceNumber));
      const total = order.reduce((a, g) => a + g.max, 0);
      if (total !== keyMax) unsafeKeyPapers.set(paper, `The answer key numbers its entries 1–${keyMax} continuously, but the paper restarts its numbering per section (${order.map((g) => `${g.section || "first"}: 1–${g.max}`).join(", ")} = ${total}). The key cannot be matched to these questions safely — check for missing questions or enter the answers by hand.`);
      else {
        const byNumber = new Map<number, KeyRow[]>();
        for (const r of rows) byNumber.set(r.sourceNumber, [...(byNumber.get(r.sourceNumber) ?? []), r]);
        let offset = 0;
        const offsetOf = new Map<string, number>();
        for (const g of order) {
          offsetOf.set(g.section, offset);
          offset += g.max;
        }
        for (const q of qs) {
          const e = effective(q);
          if (e.number === null || !offsetOf.has(e.section)) continue;
          const hit = byNumber.get(offsetOf.get(e.section)! + e.number);
          if (hit) keyFor.set(q.id, { rows: hit, method: `by number (key entry ${offsetOf.get(e.section)! + e.number} = ${e.section || "first section"} Q${e.number})` });
        }
      }
    } else {
      for (const q of qs) {
        const e = effective(q);
        const hit = direct.get(`${e.section}#${e.number}`);
        if (hit) keyFor.set(q.id, { rows: hit, method: "by question number" });
      }
    }
    // Record matches + unmatched / duplicate key rows.
    const matchedIds = new Set([...keyFor.values()].flatMap((v) => v.rows.map((r) => r.id)));
    await prisma.aiImportKeyEntry.updateMany({ where: { id: { in: rows.map((r) => r.id).filter((id) => !matchedIds.has(id)) } }, data: { status: "UNMATCHED" } });
  }
  const anyKey = keyRowsRaw.length > 0;
  // A key printed for another paper / series never supplies official answers to this one.
  const wrongKeyFiles = new Map((await keyPaperChecks(job.id)).filter((c) => c.state === "MISMATCH").map((c) => [c.keyFileId, c.detail]));
  const keyFileOfRow = new Map(keyRowsRaw.map((r) => [r.id, r.keyFileId]));
  const rescanWaiting = new Set((await prisma.aiImportQuestionVersion.findMany({ where: { jobId: job.id, kind: "RESCAN", status: "PENDING" }, select: { questionId: true } })).map((v) => v.questionId));

  // ---- Taxonomy ----
  const taxonomy = await getExamTaxonomy(prisma, job.examId);
  const subjectById = new Map(taxonomy.map((s) => [s.id, s]));
  const topicById = new Map(taxonomy.flatMap((s) => s.topics.map((t) => [t.id, t] as const)));
  const subjectByName = new Map(taxonomy.map((s) => [taxonomyNameKey(s.name), s]));

  // ---- Existing questions for duplicate detection (this exam only) ----
  const existing = await prisma.question.findMany({ where: { examId: job.examId, status: { not: "ARCHIVED" } }, select: { id: true, code: true, text: true, options: { select: { text: true }, orderBy: { order: "asc" } } } });
  const existingNorm = existing.map((x) => ({ id: x.id, code: x.code, norm: normalizeForDup(`${x.text} ${x.options.map((o) => o.text).join(" ")}`) }));
  const exactIndex = new Map(existingNorm.map((x) => [x.norm, x]));
  const existingShingles = existingNorm.map((x) => ({ ...x, sh: shingles(x.norm) }));
  const seenInBatch = new Map<string, string>();

  // ---- Optional AI: independent answers + classification (only for questions that need them) ----
  const needsSolve = settings.verification.independentAnswer && settings.aiEnabled && settings.models.verify ? open.filter((q) => !only || only.has(q.id)).filter((q) => !q.aiAnswer.length && IMPORTABLE.has(effective(q).type) && effective(q).options.length === 4) : [];
  for (const q of needsSolve) {
    if (!(await ctx.stillRunning())) return;
    const e = effective(q);
    try {
      const r = await importerAiCall({ jobId: job.id, task: "verify", models: [settings.models.verify!], system: SOLVE_SYSTEM, content: [{ type: "text", text: solveUserText(e) }], maxOutputTokens: 600, settings, questionId: q.id, needsVision: false });
      const parsed = solveSchema.safeParse(parseModelJson(r.text));
      if (parsed.success) {
        const labels = parsed.data.defective ? [] : parsed.data.answer.map((a) => labelFromPrinted(a, e.options.map((o) => o.label))).filter((x): x is string => !!x);
        await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { aiAnswer: [...new Set(labels)], aiAnswerModel: r.model, aiAnswerConfidence: parsed.data.confidence, costInr: { increment: r.costInr ?? 0 } } });
        q.aiAnswer = [...new Set(labels)];
        q.aiAnswerModel = r.model;
        q.aiAnswerConfidence = parsed.data.confidence;
      }
    } catch (err) {
      if (err instanceof ImporterAiUnavailable || (err instanceof Error && err.name === "ImporterBudgetError")) throw err;
    }
  }

  const toClassify = open.filter((q) => (!only || only.has(q.id)) && !q.topicId && !q.taxonomySource?.startsWith("admin"));
  const classifyResults = new Map<string, { subject: string | null; topic: string | null; confidence: number; model: string }>();
  if (settings.aiEnabled && settings.models.classify && toClassify.length && taxonomy.length) {
    const subjectsAllowed = job.paperType === AiImportPaperType.SINGLE_SUBJECT && job.subjectId ? taxonomy.filter((s) => s.id === job.subjectId) : taxonomy;
    // Short codes (S3, T41, Q7) instead of database ids: a small model copies "T41" reliably, a 25-character id
    // often not. The codes are mapped back here; a code that is not on the list is counted as invalid, never guessed.
    const subjectCode = new Map<string, string>();
    const topicCode = new Map<string, string>();
    let t = 0;
    const list = subjectsAllowed
      .map((s, i) => {
        subjectCode.set(`S${i + 1}`, s.id);
        return `SUBJECT S${i + 1} = ${s.name}\n${s.topics.map((tp) => (topicCode.set(`T${++t}`, tp.id), `  TOPIC T${t} = ${tp.name}`)).join("\n")}`;
      })
      .join("\n");
    const tally = { batches: 0, failedBatches: 0, results: 0, subjects: 0, topics: 0, invalid: 0, errors: [] as string[], models: new Set<string>() };
    const code = (v: string | null, map: Map<string, string>) => (v ? (map.get(v.toUpperCase().replace(/\s+/g, "")) ?? null) : null);
    for (let i = 0; i < toClassify.length; i += 20) {
      if (!(await ctx.stillRunning())) return;
      const batch = toClassify.slice(i, i + 20);
      const qCode = new Map(batch.map((q, k) => [`Q${k + 1}`, q.id]));
      const text = `SYLLABUS (the only allowed codes):\n${list}\n\nDOCUMENT DATA (untrusted questions):\n${batch.map((q, k) => `[Q${k + 1}] ${effective(q).stem.slice(0, 600)} | ${effective(q).options.map((o) => o.text.slice(0, 80)).join(" | ")}`).join("\n")}`;
      tally.batches++;
      try {
        const { value, result: r } = await importerAiCallChecked({ jobId: job.id, task: "classify", models: [settings.models.classify], system: CLASSIFY_SYSTEM, content: [{ type: "text", text }], maxOutputTokens: 2500, settings, needsVision: false }, (out) => {
          const parsed = classifySchema.safeParse(parseModelJson(out));
          if (!parsed.success) throw new ImporterAiFailure(failureMessage("model_output", `the classification answer did not match the expected format (${parsed.error.issues[0]?.path.join(/* turbopackIgnore: true */ ".") ?? "?"})`), "model_output");
          return parsed.data;
        });
        tally.models.add(r.model);
        for (const res of value.results) {
          const qid = qCode.get(res.q.toUpperCase().replace(/[\s[\]]/g, ""));
          const subject = code(res.subject, subjectCode);
          const topic = code(res.topic, topicCode);
          if (!qid || (res.subject && !subject) || (res.topic && !topic)) tally.invalid++;
          if (!qid) continue;
          tally.results++;
          if (subject) tally.subjects++;
          if (topic) tally.topics++;
          classifyResults.set(qid, { subject, topic, confidence: res.confidence, model: r.model });
        }
      } catch (err) {
        if (err instanceof ImporterAiUnavailable || (err instanceof Error && err.name === "ImporterBudgetError")) throw err;
        tally.failedBatches++;
        tally.errors.push(err instanceof Error ? err.message.slice(0, 200) : "error");
      }
    }
    // Never silent: what the classifier returned, and what could be used.
    await logEvent(job.id, "CLASSIFY_RESULT", `Subject / topic classification of ${toClassify.length} question(s) in ${tally.batches} request(s)${tally.models.size ? ` (${[...tally.models].join(", ")})` : ""}: ${tally.subjects} subject(s) and ${tally.topics} topic(s) assigned${tally.invalid ? `, ${tally.invalid} answer(s) named a question, subject or topic code that is not on the list (ignored)` : ""}${tally.failedBatches ? `, ${tally.failedBatches} request(s) failed (${tally.errors[0]})` : ""}. Questions without a subject stay in Needs correction.`, { questions: toClassify.length, ...tally, models: [...tally.models], errors: tally.errors.slice(0, 5) });
  }

  // Text layers of digital pages the vision model read (layout unclear): its digits are exact, so a number in
  // the extraction that is not on the page was changed or invented.
  const textLayers = new Map((await prisma.aiImportPage.findMany({ where: { jobId: job.id, kind: "TEXT_UNRELIABLE" }, select: { fileId: true, pageNumber: true, textLayer: true } })).map((p) => [`${p.fileId}:${p.pageNumber}`, p.textLayer]));

  // ---- Per question ----
  const numbersByFile = new Map<string, number[]>();
  for (const q of questions) {
    const n = effective(q).number;
    if (n !== null) numbersByFile.set(q.fileId, [...(numbersByFile.get(q.fileId) ?? []), n]);
  }

  for (const q of open) {
    const e = effective(q);
    if (only && !only.has(q.id)) {
      const n = dupText(e);
      if (!seenInBatch.has(n)) seenInBatch.set(n, q.id);
      continue;
    }
    const checks: Check[] = [];
    const issues = new Map<string, string>();
    const add = (code: string, detail: string) => issues.set(code, detail);
    /** Several findings of the same kind are kept together (never the last one only). */
    const addMore = (code: string, detail: string) => issues.set(code, issues.has(code) ? `${issues.get(code)} · ${detail}`.slice(0, 600) : detail);
    const optionLabels = e.options.map((o) => o.label);
    const printedLabels = e.options.map((o) => o.printed || o.label);

    // Stage 1 — source extraction
    checks.push({ stage: 1, name: "Question number", passed: e.number !== null, severity: e.number !== null ? "INFO" : "WARNING", method: "DETERMINISTIC", detail: e.number !== null ? `Q${e.number}${e.section ? ` (${e.section})` : ""} on page ${e.pages.join(", ")}` : "No question number was recognized." });
    if (!e.stem.trim()) add("OPTIONS_INCOMPLETE", "The question text is empty.");
    const conf = e.confidence ?? 0;
    const lowConf = conf < 0.8 || e.unreadable.length > 0;
    checks.push({ stage: 1, name: "Extraction confidence", passed: !lowConf, severity: lowConf ? "WARNING" : "INFO", method: e.method?.startsWith("AI") ? "AI" : "DETERMINISTIC", model: e.model ?? null, detail: `${Math.round(conf * 100)}% · ${e.method}${e.unreadable.length ? ` · unreadable: ${e.unreadable.join("; ").slice(0, 200)}` : ""}${e.notes?.length ? ` · ${e.notes.join(" ").slice(0, 300)}` : ""}` });
    if (e.unreadable.length) add("UNREADABLE_TEXT", e.unreadable.join("; ").slice(0, 300));
    if (lowConf) add("EXTRACTION_UNCERTAIN", e.notes?.join(" ").slice(0, 300) || `Extraction confidence ${Math.round(conf * 100)}%.`);
    // Independent verification evidence (Agent B), kept on the original extraction.
    const ver = (q.data as unknown as ExtractedQuestion).verification;
    if (ver) {
      checks.push({ stage: 1, name: "Independent verification", passed: ver.agree, severity: ver.agree ? "INFO" : "WARNING", method: "AI", model: ver.model, detail: ver.agree ? "A different model read the same page independently and every compared field matched." : `A different model read the same page independently: ${ver.detail}.${q.editedData ? " (Compared with the original extraction; your correction is kept.)" : ""}` });
      if (!ver.agree) add("VERIFY_DISAGREES", `Independent read (${ver.model}): ${ver.detail}.`);
    }
    if (rescanWaiting.has(q.id)) add("RESCAN_PENDING", "A re-scan result is waiting: compare it with the current question and choose what to keep.");
    const nums = numbersByFile.get(q.fileId) ?? [];
    if (e.number !== null && e.number > 1 && !nums.includes(e.number - 1) && !(e.section && e.number === 1)) add("NUMBERING_GAP", `Q${e.number - 1} was not found before this question.`);
    // Question / option segmentation: a number read twice, an unjoined continuation, a placeholder text,
    // options that look merged with the next question or missing / repeated.
    if (e.number === null && e.printedNumber !== null && e.printedNumber !== undefined) add("NUMBER_CONFLICT", `Printed as Q${e.printedNumber}, but that number was already read elsewhere in this paper — set the right number (or reject the copy).`);
    if (/^cont/.test(e.label) && !q.editedData) add("QUESTION_TEXT_SUSPECT", "This is text that continues a question from the previous page and could not be joined to it — join it by hand (edit the question it belongs to) and reject this part.");
    const placeholder = placeholderStem(e.stem, e.instructions, q.figures.length > 0);
    if (placeholder && e.stem.trim()) add("QUESTION_TEXT_SUSPECT", placeholder);
    const optProblems = optionProblems(e.options, e.number);
    if (optProblems.length) addMore("EXTRACTION_UNCERTAIN", optProblems.join(" "));
    checks.push({ stage: 1, name: "Question segmentation", passed: !optProblems.length && !placeholder && !issues.has("NUMBER_CONFLICT") && !issues.has("QUESTION_TEXT_SUSPECT"), severity: issues.has("NUMBER_CONFLICT") || issues.has("QUESTION_TEXT_SUSPECT") ? "ERROR" : optProblems.length ? "WARNING" : "INFO", method: "DETERMINISTIC", detail: [issues.get("NUMBER_CONFLICT"), issues.get("QUESTION_TEXT_SUSPECT"), ...optProblems].filter(Boolean).join(" ") || `Question number, text and ${e.options.length} option(s) are consistent.` });
    // Figures
    const figs = q.figures;
    const missingFig = figs.filter((f) => f.mappingStatus === "MISSING");
    const uncertainFig = figs.filter((f) => f.mappingStatus === "UNCERTAIN" && !f.confirmedById);
    if (missingFig.length) add("IMAGE_MISSING", `${missingFig.length} figure(s) could not be extracted.`);
    if (uncertainFig.length) {
      const reasons = [...new Set(uncertainFig.map((f) => (f.box as { reason?: string } | null)?.reason).filter((r): r is string => !!r))];
      add("IMAGE_MAPPING_UNCERTAIN", `${uncertainFig.length} figure(s) need their question/option confirmed.${reasons.length ? ` ${reasons.join(" ")}` : ""}`.slice(0, 600));
    }
    const mentionsFigure = MENTIONS_FIGURE.test(e.stem);
    if (mentionsFigure && figs.length === 0) add("IMAGE_MISSING", "The question refers to a figure, but no figure was found.");
    for (const o of e.options) if (!o.text.trim() && !figs.some((f) => f.owner === "OPTION" && f.optionLabel === o.label && f.mappingStatus !== "MISSING")) add("OPTIONS_INCOMPLETE", `Option ${o.label} has neither text nor an image.`);
    checks.push({ stage: 1, name: "Figures", passed: !missingFig.length && !uncertainFig.length && !(mentionsFigure && !figs.length), severity: missingFig.length || (mentionsFigure && !figs.length) ? "ERROR" : uncertainFig.length ? "WARNING" : "INFO", method: "DETERMINISTIC", detail: figs.length ? figs.map((f) => `${f.owner === "OPTION" ? `option ${f.optionLabel}` : f.owner.toLowerCase()} (${f.source.toLowerCase()}, ${f.mappingStatus.toLowerCase()})`).join(", ") : mentionsFigure ? "Refers to a figure; none found." : "No figures." });

    // Stage 2 — structure & subject
    let type = e.type;
    if (type === "OTHER" && e.options.length === 4) type = "SINGLE_CORRECT";
    if (!IMPORTABLE.has(type)) {
      if (type === "OTHER") add("OPTIONS_INCOMPLETE", "The question structure was not recognized.");
      else add("UNSUPPORTED_TYPE", type === "FIVE_OPTIONS" ? `${e.options.length} options — the Question Bank holds exactly four (A–D).` : `${type.replace(/_/g, " ").toLowerCase()} questions cannot be stored by the current Question Bank.`);
    } else if (e.options.length !== 4) {
      if (e.options.length < 4 && conf >= 0.85) add("UNSUPPORTED_TYPE", `${e.options.length} options printed — the Question Bank holds exactly four (A–D).`);
      else add("OPTIONS_INCOMPLETE", `${e.options.length} option(s) found; four are needed.`);
    }
    if (type === "MATCH_THE_FOLLOWING" && (!e.listI?.length || !e.listII?.length)) checks.push({ stage: 2, name: "Match lists", passed: false, severity: "WARNING", method: "DETERMINISTIC", detail: "Lists were not separated; they stay in the question text and the question imports as single-correct." });
    // Formulas
    const richText = [e.stem, ...e.options.map((o) => o.text), ...(e.listI ?? []).map((x) => x.text), ...(e.listII ?? []).map((x) => x.text)];
    const formulaWarnings = e.contentFormat === "RICH_V1" ? richText.flatMap((t, i) => lintRichSource(t, i === 0 ? "Question" : `Part ${i}`).warnings) : richText.some((t) => looksRich(t)) ? ["Formula markup in a plain question would show literally."] : [];
    if (formulaWarnings.length) add("FORMULA_ISSUE", formulaWarnings[0].slice(0, 300));
    // Digits, signs and exponents compared with the source (never corrected automatically).
    if (!q.editedData) {
      if (e.contentFormat !== "RICH_V1") {
        const flat = richText.map((t) => lostSuperscript(t)).find(Boolean);
        if (flat) addMore("FORMULA_ISSUE", `"${flat}" looks like a power of ten that lost its superscript — write it as a formula (e.g. $3 \\times 10^{8}$) if that is what is printed.`);
      }
      if (e.method === "AI_VISION") {
        const missingNums = e.pages.flatMap((pg) => numbersMissingFromSource(richText, textLayers.get(`${q.fileId}:${pg}`) ?? null));
        if (missingNums.length && e.pages.every((pg) => textLayers.has(`${q.fileId}:${pg}`))) addMore("FORMULA_ISSUE", `Number(s) ${[...new Set(missingNums)].slice(0, 6).join(", ")} in the extracted text do not appear on the source page — check digits, signs and exponents against the page.`);
      }
      if (ver?.fields.some((f) => f.endsWith(" numbers"))) addMore("FORMULA_ISSUE", `The independent read has different numbers / symbols (${ver.detail.slice(0, 200)}).`);
    }
    checks.push({ stage: 2, name: "Structure", passed: IMPORTABLE.has(type) && e.options.length === 4 && !formulaWarnings.length, severity: IMPORTABLE.has(type) && e.options.length === 4 ? (formulaWarnings.length ? "WARNING" : "INFO") : "ERROR", method: "DETERMINISTIC", detail: `${type.replace(/_/g, " ").toLowerCase()}, ${e.options.length} options, ${e.contentFormat === "RICH_V1" ? "with formulas" : "plain text"}${formulaWarnings.length ? ` — ${formulaWarnings[0].slice(0, 160)}` : ""}` });

    // Subject / topic (existing ids only)
    let subjectId = q.subjectId;
    let topicId = q.topicId;
    let taxConf = q.taxonomyConfidence;
    let taxSource = q.taxonomySource;
    if (!q.taxonomySource?.startsWith("admin")) {
      if (job.paperType === AiImportPaperType.SINGLE_SUBJECT && job.subjectId) {
        subjectId = job.subjectId;
        taxSource = "selected subject";
      } else if (e.hints?.subject && subjectByName.has(taxonomyNameKey(e.hints.subject))) {
        subjectId = subjectByName.get(taxonomyNameKey(e.hints.subject))!.id;
        taxSource = "source column";
      }
      if (e.hints?.topic && subjectId) {
        const t = subjectById.get(subjectId)?.topics.find((x) => taxonomyNameKey(x.name) === taxonomyNameKey(e.hints!.topic!));
        if (t) {
          topicId = t.id;
          taxConf = 1;
          taxSource = "source column";
        }
      }
      const ai = classifyResults.get(q.id);
      if (ai) {
        const subjOk = ai.subject && subjectById.has(ai.subject) && (!subjectId || subjectId === ai.subject || job.paperType !== AiImportPaperType.SINGLE_SUBJECT);
        if (!subjectId && subjOk) subjectId = ai.subject!;
        const t = ai.topic ? topicById.get(ai.topic) : undefined;
        if (t && subjectId && t.subjectId === subjectId && !topicId) {
          topicId = t.id;
          taxConf = ai.confidence;
          taxSource = `AI (${ai.model})`;
        } else if (ai.subject && subjectId && ai.subject !== subjectId && job.paperType === AiImportPaperType.SINGLE_SUBJECT) {
          checks.push({ stage: 2, name: "Subject check", passed: false, severity: "WARNING", method: "AI", model: ai.model, detail: `The classifier thinks this question belongs to ${subjectById.get(ai.subject)?.name ?? "another subject"}, not the selected subject.` });
        }
      }
    }
    if (!subjectId) add("SUBJECT_UNKNOWN", "No subject of this exam could be determined. Set it in Review Exceptions.");
    const topicSure = !!topicId && (taxConf ?? 0) >= settings.verification.topicMinConfidence;
    if (!topicSure) add("TOPIC_UNCERTAIN", topicId ? `Topic confidence ${Math.round((taxConf ?? 0) * 100)}%.` : "No topic could be determined.");
    checks.push({ stage: 2, name: "Subject & topic", passed: !!subjectId && topicSure, severity: !subjectId ? "ERROR" : topicSure ? "INFO" : "WARNING", method: taxSource?.startsWith("AI") ? "AI" : taxSource?.startsWith("admin") ? "ADMIN" : "DETERMINISTIC", detail: `${subjectId ? subjectById.get(subjectId)?.name ?? "?" : "no subject"} › ${topicId ? topicById.get(topicId)?.name ?? "?" : "no topic"}${taxSource ? ` (${taxSource})` : ""}` });

    // Stage 3 — answer
    let answerStatus: AiImportAnswerStatus = AiImportAnswerStatus.KEY_MISSING;
    let official: string[] = [];
    let officialRaw: string | null = null;
    let officialPage: number | null = null;
    let finalAnswer: string[] = q.answerConfirmedById ? q.finalAnswer : [];
    const matchedKey = keyFor.get(q.id);
    const wrongKey = matchedKey ? matchedKey.rows.map((r) => wrongKeyFiles.get(keyFileOfRow.get(r.id) ?? "")).find(Boolean) : undefined;
    const key = wrongKey ? undefined : matchedKey;
    if (wrongKey) {
      // Kept for reference only: never an official answer of this paper.
      answerStatus = AiImportAnswerStatus.KEY_MISMATCH;
      officialRaw = matchedKey!.rows.map((r) => r.rawValue).join(" / ");
      officialPage = matchedKey!.rows[0].page;
      add("ANSWER_KEY_PAPER_MISMATCH", wrongKey);
      checks.push({ stage: 3, name: "Official answer key", passed: false, severity: "ERROR", method: "DETERMINISTIC", detail: `${wrongKey} Its value for this number ("${officialRaw}") is not used.` });
    }
    if (key) {
      // Kept as printed; compared without brackets / spaces ("(1)" and "1" are the same answer).
      const distinct = [...new Set(key.rows.map((r) => r.rawValue.toUpperCase().replace(/[()\s]/g, "")))];
      officialRaw = key.rows.map((r) => r.rawValue).join(" / ");
      officialPage = key.rows[0].page;
      await prisma.aiImportKeyEntry.updateMany({ where: { id: { in: key.rows.map((r) => r.id) } }, data: { matchedQuestionId: q.id, status: key.rows.length > 1 ? "DUPLICATE" : "OK" } });
      if (distinct.length > 1) {
        answerStatus = AiImportAnswerStatus.AMBIGUOUS_MAPPING;
        add("ANSWER_AMBIGUOUS", `The key lists this question ${key.rows.length} times with different answers (${officialRaw}).`);
      } else if (WITHDRAWN.test(distinct[0])) {
        answerStatus = AiImportAnswerStatus.WITHDRAWN;
        add("POSSIBLE_WITHDRAWN", `The official key marks this question "${distinct[0]}" (dropped / bonus).`);
        await prisma.aiImportKeyEntry.updateMany({ where: { id: { in: key.rows.map((r) => r.id) } }, data: { status: "WITHDRAWN" } });
      } else {
        const parsedKey = parseKeyAnswer(key.rows[0].rawValue, printedLabels);
        if (!parsedKey.labels || parsedKey.labels.some((l) => !optionLabels.includes(l))) {
          answerStatus = /\bor\b/i.test(key.rows[0].rawValue) ? AiImportAnswerStatus.AMBIGUOUS_MAPPING : AiImportAnswerStatus.KEY_MISMATCH;
          add(answerStatus === AiImportAnswerStatus.AMBIGUOUS_MAPPING ? "ANSWER_AMBIGUOUS" : "ANSWER_MISMATCH", parsedKey.problem ?? `The key value "${distinct[0]}" is not one of this question's options.`);
        } else {
          official = parsedKey.labels;
          answerStatus = AiImportAnswerStatus.OFFICIAL_MATCHED;
          if (official.length > 1 && type !== "MULTIPLE_CORRECT") {
            answerStatus = AiImportAnswerStatus.AMBIGUOUS_MAPPING;
            add("ANSWER_AMBIGUOUS", `The key gives several answers (${official.join(", ")}) for a single-correct question.`);
          } else if (official.length === 1 && type === "MULTIPLE_CORRECT") {
            // Never silently stored as a multiple-correct answer, never changed: the type or the key needs a decision.
            answerStatus = AiImportAnswerStatus.AMBIGUOUS_MAPPING;
            add("ANSWER_TYPE_CONFLICT", `The official key gives one answer (${official[0]}) but the question is marked multiple-correct — check the question type, or confirm the answer by hand. The official key is kept as printed.`);
          } else if (e.printedAnswer.length && !sameSet(e.printedAnswer, official)) {
            answerStatus = AiImportAnswerStatus.KEY_MISMATCH;
            add("ANSWER_MISMATCH", `The paper prints ${e.printedAnswer.join(", ")} but the official key says ${official.join(", ")}.`);
          }
        }
      }
      checks.push({ stage: 3, name: "Official answer key", passed: answerStatus === AiImportAnswerStatus.OFFICIAL_MATCHED, severity: answerStatus === AiImportAnswerStatus.OFFICIAL_MATCHED ? "INFO" : "ERROR", method: "DETERMINISTIC", detail: `Key "${officialRaw}"${officialPage ? ` (key page ${officialPage})` : ""}, matched ${key.method}.` });
      if (!q.answerConfirmedById && answerStatus === AiImportAnswerStatus.OFFICIAL_MATCHED) finalAnswer = official;
    } else if (!wrongKey) {
      const unsafe = unsafeKeyPapers.get(q.fileId);
      if (unsafe) {
        answerStatus = AiImportAnswerStatus.AMBIGUOUS_MAPPING;
        add("ANSWER_AMBIGUOUS", unsafe);
      }
      checks.push({ stage: 3, name: "Official answer key", passed: false, severity: "WARNING", method: "DETERMINISTIC", detail: unsafe ?? (anyKey ? "The answer key has no entry for this question." : "No answer key uploaded for this paper.") });
      const printed = e.printedAnswer;
      const aiAgrees = q.aiAnswer.length > 0 && (q.aiAnswerConfidence ?? 0) >= 0.7;
      if (printed.length) {
        if (aiAgrees && sameSet(printed, q.aiAnswer)) answerStatus = AiImportAnswerStatus.INDEPENDENTLY_VERIFIED;
        else answerStatus = AiImportAnswerStatus.UNVERIFIED;
        if (!q.answerConfirmedById) finalAnswer = printed;
      } else if (q.aiAnswer.length) {
        answerStatus = AiImportAnswerStatus.UNVERIFIED;
        if (!q.answerConfirmedById) finalAnswer = settings.publish.allowUnverifiedAnswers ? q.aiAnswer : [];
      }
      if (answerStatus === AiImportAnswerStatus.UNVERIFIED) add("ANSWER_UNVERIFIED", printed.length ? `Answer ${printed.join(", ")} is printed in the paper but not confirmed by an official key.` : `Only an AI opinion (${q.aiAnswer.join(", ")}) is available — not an official answer.`);
    }
    if (q.aiAnswer.length && official.length && !sameSet(q.aiAnswer, official)) add("AI_OPINION_DIFFERS", `AI opinion ${q.aiAnswer.join(", ")} (${q.aiAnswerModel}) differs from the official key ${official.join(", ")}. The official key is kept.`);
    if (q.aiAnswer.length) checks.push({ stage: 3, name: "Independent AI opinion", passed: !official.length || sameSet(q.aiAnswer, official), severity: official.length && !sameSet(q.aiAnswer, official) ? "WARNING" : "INFO", method: "AI", model: q.aiAnswerModel, detail: `AI suggests ${q.aiAnswer.join(", ")} (confidence ${Math.round((q.aiAnswerConfidence ?? 0) * 100)}%) — an opinion, never an official answer.` });
    const typeOk = (labels: string[]) => (type === "MULTIPLE_CORRECT" ? labels.length >= 2 : labels.length === 1);
    if (!finalAnswer.length || !typeOk(finalAnswer)) {
      if (!issues.has("ANSWER_AMBIGUOUS") && !issues.has("ANSWER_MISMATCH") && !issues.has("POSSIBLE_WITHDRAWN") && !issues.has("ANSWER_KEY_PAPER_MISMATCH") && !issues.has("ANSWER_TYPE_CONFLICT")) add("ANSWER_MISSING", finalAnswer.length ? `The answer (${finalAnswer.join(", ")}) does not fit a ${type.replace(/_/g, " ").toLowerCase()} question.` : "No usable answer (no key entry, nothing printed in the paper).");
      if (finalAnswer.length && !typeOk(finalAnswer)) finalAnswer = [];
    }

    // Stage 4 — final audit: duplicates
    let duplicateOf: string | null = null;
    let dupKind: string | null = null;
    let dupScore: number | null = null;
    const norm = dupText(e);
    const exact = exactIndex.get(norm);
    if (exact) {
      duplicateOf = exact.id;
      dupKind = "EXACT";
      dupScore = 1;
      add("DUPLICATE_EXISTING", `Same text as existing question ${exact.code}.`);
    } else {
      const sh = shingles(norm);
      let best: { id: string; code: string; s: number } | null = null;
      for (const x of existingShingles) {
        const s = similarity(sh, x.sh);
        if (s >= settings.verification.nearDuplicateAt && (!best || s > best.s)) best = { id: x.id, code: x.code, s };
      }
      if (best) {
        duplicateOf = best.id;
        dupKind = "NEAR";
        dupScore = best.s;
        add("DUPLICATE_NEAR", `${Math.round(best.s * 100)}% similar to existing question ${best.code}.`);
      }
    }
    const batchTwin = seenInBatch.get(norm);
    if (batchTwin && batchTwin !== q.id && norm.length > 10) add("DUPLICATE_IN_BATCH", "The same question appears earlier in this import.");
    else seenInBatch.set(norm, q.id);
    // Admin decisions persist across re-runs: a reviewed question drops the
    // "needs a human look" flags (never structural ones), an admin-chosen
    // answer settles the answer flags.
    if (q.reviewedById) for (const c of REVIEWABLE) issues.delete(c);
    if (q.answerConfirmedById && finalAnswer.length && typeOk(finalAnswer)) for (const c of ["ANSWER_MISMATCH", "ANSWER_AMBIGUOUS", "POSSIBLE_WITHDRAWN", "ANSWER_UNVERIFIED", "ANSWER_MISSING", "ANSWER_KEY_PAPER_MISMATCH", "ANSWER_TYPE_CONFLICT"]) issues.delete(c);
    if (q.allowDuplicate) {
      issues.delete("DUPLICATE_EXISTING");
      issues.delete("DUPLICATE_NEAR");
      issues.delete("DUPLICATE_IN_BATCH");
    }
    checks.push({ stage: 4, name: "Duplicates", passed: !duplicateOf && !batchTwin, severity: dupKind === "EXACT" || batchTwin ? "ERROR" : dupKind ? "WARNING" : "INFO", method: "DETERMINISTIC", detail: dupKind ? `${dupKind === "EXACT" ? "Exact" : "Near"} duplicate (${Math.round((dupScore ?? 0) * 100)}%)${q.allowDuplicate ? " — admin chose to import anyway" : ""}` : batchTwin ? "Duplicate within this import." : "No duplicate found." });

    // Status
    const codes = [...issues.keys()];
    const blocking = codes.filter((c) => ISSUE_DEFS[c]?.blocking);
    let status: AiImportQuestionStatus = AiImportQuestionStatus.READY;
    if (codes.includes("UNSUPPORTED_TYPE")) status = AiImportQuestionStatus.NOT_IMPORTABLE;
    else if (!q.allowDuplicate && (codes.includes("DUPLICATE_EXISTING") || codes.includes("DUPLICATE_IN_BATCH"))) status = AiImportQuestionStatus.DUPLICATE;
    else if (blocking.length || codes.some((c) => ISSUE_DEFS[c]?.publishBlocking)) status = AiImportQuestionStatus.NEEDS_CORRECTION;
    checks.push({ stage: 4, name: "Import readiness", passed: !blocking.length, severity: blocking.length ? "ERROR" : codes.length ? "WARNING" : "INFO", method: "DETERMINISTIC", detail: blocking.length ? `Blocked: ${blocking.map((c) => ISSUE_DEFS[c].label).join(", ")}` : codes.length ? `Importable with flags: ${codes.map((c) => ISSUE_DEFS[c]?.label ?? c).join(", ")}` : "Ready" });

    await prisma.$transaction([
      prisma.aiImportCheck.deleteMany({ where: { questionId: q.id, method: { not: "ADMIN" } } }),
      prisma.aiImportCheck.createMany({ data: checks.map((c) => ({ questionId: q.id, stage: c.stage, name: c.name, passed: c.passed, severity: c.severity, method: c.method, model: c.model ?? null, detail: c.detail.slice(0, 1000) })) }),
      prisma.aiImportQuestion.update({
        where: { id: q.id },
        data: {
          status: q.status === AiImportQuestionStatus.IMPORT_FAILED ? AiImportQuestionStatus.IMPORT_FAILED : status,
          issueCodes: codes,
          issues: Object.fromEntries(issues) as Prisma.InputJsonValue,
          questionType: type,
          optionCount: e.options.length,
          contentFormat: e.contentFormat,
          confidence: conf,
          subjectId,
          topicId,
          taxonomyConfidence: taxConf,
          taxonomySource: taxSource,
          answerStatus,
          officialAnswer: official,
          officialAnswerRaw: officialRaw,
          officialKeyPage: officialPage,
          sourceAnswer: e.printedAnswer,
          finalAnswer,
          duplicateOfQuestionId: duplicateOf,
          duplicateKind: dupKind,
          duplicateScore: dupScore,
        },
      }),
    ]);
  }
}
