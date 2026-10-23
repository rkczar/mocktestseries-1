import "server-only";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import { AiImportJobStatus, AiImportPageStatus, AiImportQuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logEvent, ImportJobError } from "@/lib/ai-import/jobs";
import { importBlocker, type ImportMode, type ImportPlan } from "@/lib/ai-import/adapter";
import { REVIEWABLE } from "@/lib/ai-import/post";
import { compareVersions, figureRows, mergeChoice, recordVersion, snapshotFigures, RESCAN_FIELDS, type FigureSnapshot, type RescanField } from "@/lib/ai-import/versions";
import { cropFromRender, storeOriginalFigure, FigureError, MIN_CROP_SIDE } from "@/lib/ai-import/figures";
import { normalizeBox } from "@/lib/ai-import/figure-map";
import { ensureRender } from "@/lib/ai-import/process";
import { exists as vaultExists } from "@/lib/ai-import/vault";
import type { RescanRequest } from "@/lib/ai-import/process";
import type { SequenceAck } from "@/lib/ai-import/quality";
import { jobQuality, settleJobStatus } from "@/lib/ai-import/summary";
import { kickWorker } from "@/lib/ai-import/kick";
import { effective, runPostProcessing } from "@/lib/ai-import/post";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { planOf } from "@/lib/ai-import/select";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { rememberCorrection } from "@/lib/ai-import/taxonomy-memory";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * Admin decisions on extracted questions. Every change is recorded (event
 * log + an ADMIN check on the question) and re-validated by the next
 * post-processing pass (it runs at the start of every import). Imported
 * questions are edited in the Question Bank, not here.
 */

const LOCKED: AiImportQuestionStatus[] = [AiImportQuestionStatus.IMPORTED, AiImportQuestionStatus.PUBLISHED];
const BUSY: AiImportJobStatus[] = [AiImportJobStatus.PROCESSING, AiImportJobStatus.IMPORTING, AiImportJobStatus.ANALYZING];

async function editable(questionId: string) {
  const q = await prisma.aiImportQuestion.findUnique({ where: { id: questionId }, include: { job: { select: { id: true, status: true, examId: true, paperType: true, subjectId: true } } } });
  if (!q) throw new ImportJobError("Question not found.", 404);
  if (LOCKED.includes(q.status)) throw new ImportJobError("This question is already in the Question Bank — edit it there.");
  if (BUSY.includes(q.job.status)) throw new ImportJobError("The import is busy (processing or importing). Try again when it has finished.");
  if (q.job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("This import was cancelled.");
  return q;
}

async function adminCheck(questionId: string, name: string, detail: string) {
  await prisma.aiImportCheck.create({ data: { questionId, stage: 4, name, passed: true, severity: "INFO", method: "ADMIN", detail: detail.slice(0, 1000) } });
}

export interface QuestionEdit {
  stem: string;
  options: { label: string; text: string }[];
  type: ExtractedQuestion["type"];
  contentFormat: "PLAIN" | "RICH_V1";
  listI?: { key: string; text: string }[] | null;
  listII?: { key: string; text: string }[] | null;
  /** Original question number as printed (undefined = unchanged). */
  number?: number | null;
  /** Explanation stored with the question (undefined = unchanged, "" = none). */
  explanation?: string | null;
  /** Source page reference (pages of the paper file the question is printed on). */
  pages?: number[];
}

const TYPES: ExtractedQuestion["type"][] = ["SINGLE_CORRECT", "MULTIPLE_CORRECT", "MATCH_THE_FOLLOWING", "ASSERTION_REASON", "NUMERICAL", "SUBJECTIVE", "FIVE_OPTIONS", "OTHER"];

/** Approval belongs to the content that was approved: any later change clears it. */
const UNAPPROVE = { approvedById: null, approvedAt: null } as const;

/** Every problem with an edit, all at once (nothing is saved while one remains). */
export async function editProblems(q: { id: string; jobId: string; fileId: string }, base: ExtractedQuestion, edit: QuestionEdit, figureOptions: Set<string>): Promise<string[]> {
  const errors: string[] = [];
  if (!edit.stem.trim()) errors.push("The question text cannot be empty.");
  if (!TYPES.includes(edit.type)) errors.push("Choose a valid question type.");
  if (edit.options.length < 2 || edit.options.length > 6) errors.push("A question needs 2 to 6 options.");
  edit.options.forEach((o, i) => {
    const label = String.fromCharCode(65 + i);
    if (!o.text.trim() && !figureOptions.has(label)) errors.push(`Option ${label} has neither text nor an image.`);
  });
  if (edit.number !== undefined && edit.number !== null && (!Number.isInteger(edit.number) || edit.number < 1 || edit.number > 999)) errors.push("The question number must be a whole number from 1 to 999.");
  if (edit.number !== undefined && edit.number !== null && edit.number !== base.number) {
    const others = await prisma.aiImportQuestion.findMany({ where: { fileId: q.fileId, id: { not: q.id }, status: { not: AiImportQuestionStatus.REJECTED } }, select: { data: true, editedData: true, sourceLabel: true } });
    const clash = others.find((o) => {
      const e = effective(o);
      return e.number === edit.number && (e.section ?? "") === (base.section ?? "");
    });
    if (clash) errors.push(`Question number ${edit.number} already exists in this paper${base.section ? ` (section ${base.section})` : ""}. Reject or renumber that question first.`);
  }
  if (edit.pages) {
    const file = await prisma.aiImportFile.findUnique({ where: { id: q.fileId }, select: { pageCount: true } });
    const max = file?.pageCount ?? 1;
    if (!edit.pages.length || edit.pages.some((p) => !Number.isInteger(p) || p < 1 || p > max)) errors.push(`Source pages must be between 1 and ${max}.`);
  }
  if ((edit.explanation ?? "").length > 20_000) errors.push("The explanation is too long (20,000 characters at most).");
  return errors;
}

/** The fields an edit changed, with their values before and after (kept in the question's history). */
function changedFields(before: ExtractedQuestion, after: ExtractedQuestion): { field: string; before: string; after: string }[] {
  const out: { field: string; before: string; after: string }[] = [];
  const add = (field: string, a: unknown, b: unknown) => {
    const x = typeof a === "string" ? a : JSON.stringify(a ?? null);
    const y = typeof b === "string" ? b : JSON.stringify(b ?? null);
    if (x !== y) out.push({ field, before: x.slice(0, 2000), after: y.slice(0, 2000) });
  };
  add("Question number", before.number, after.number);
  add("Question type", before.type, after.type);
  add("Text format", before.contentFormat, after.contentFormat);
  add("Question text", before.stem, after.stem);
  const labels = [...new Set([...before.options.map((o) => o.label), ...after.options.map((o) => o.label)])].sort();
  for (const l of labels) add(`Option ${l}`, before.options.find((o) => o.label === l)?.text ?? "(none)", after.options.find((o) => o.label === l)?.text ?? "(none)");
  add("Explanation", before.hints?.explanation ?? "", after.hints?.explanation ?? "");
  add("Source pages", before.pages, after.pages);
  add("Match lists", [before.listI, before.listII], [after.listI, after.listII]);
  return out;
}

/** Saves an admin's correction as editedData (the extraction itself is never overwritten) and records what changed. */
export async function editQuestion(questionId: string, actorId: string, edit: QuestionEdit) {
  const q = await editable(questionId);
  const base = effective(q);
  const figs = await prisma.aiImportFigure.findMany({ where: { questionId }, select: { owner: true, optionLabel: true, mappingStatus: true } });
  const figureOptions = new Set(figs.filter((f) => f.owner === "OPTION" && f.mappingStatus !== "MISSING" && f.optionLabel).map((f) => f.optionLabel!));
  const problems = await editProblems(q, base, edit, figureOptions);
  if (problems.length) throw new ImportJobError(`Not saved: ${problems.join(" ")}`);
  const number = edit.number === undefined ? base.number : edit.number;
  const explanation = edit.explanation === undefined ? base.hints?.explanation ?? null : edit.explanation?.trim() || null;
  const next: ExtractedQuestion = {
    ...base,
    number,
    label: number === null ? base.label : String(number),
    stem: edit.stem.trim().slice(0, 20_000),
    options: edit.options.map((o, i) => ({ label: String.fromCharCode(65 + i), printed: base.options[i]?.printed ?? String.fromCharCode(65 + i), text: o.text.trim().slice(0, 5_000) })),
    type: edit.type,
    contentFormat: edit.contentFormat,
    listI: edit.listI ?? base.listI ?? null,
    listII: edit.listII ?? base.listII ?? null,
    pages: edit.pages ? [...new Set(edit.pages)].sort((a, b) => a - b) : base.pages,
    hints: { ...(base.hints ?? {}), explanation },
    confidence: 1,
    unreadable: [],
    method: base.method.endsWith("+ADMIN") ? base.method : `${base.method}+ADMIN`,
    notes: [...(base.notes ?? []), `Corrected by an administrator.`],
  };
  const changes = changedFields(base, next);
  if (!changes.length) throw new ImportJobError("Nothing changed — the question is exactly as before.");
  await prisma.$transaction([
    prisma.aiImportQuestion.update({ where: { id: q.id }, data: { editedData: next as unknown as Prisma.InputJsonValue, sourceLabel: next.label, pages: next.pages, reviewedById: actorId, reviewedAt: new Date(), ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED, questionType: next.type, optionCount: next.options.length, contentFormat: next.contentFormat } }),
    prisma.aiImportQuestionVersion.create({ data: { questionId: q.id, jobId: q.jobId, kind: "ADMIN_EDIT", data: base as unknown as Prisma.InputJsonValue, changes: changes as unknown as Prisma.InputJsonValue, actorId, note: `Changed: ${changes.map((c) => c.field).join(", ")}`.slice(0, 500) } }),
  ]);
  await adminCheck(q.id, "Edited", `Corrected by an administrator: ${changes.map((c) => c.field).join(", ")}.`);
  await logEvent(q.jobId, "QUESTION_EDITED", `Q${base.label} corrected (${changes.map((c) => c.field).join(", ")})`, { questionId: q.id, fields: changes.map((c) => c.field) }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_QUESTION_EDITED", entityType: "AiImportQuestion", entityId: q.id, metadata: { jobId: q.jobId, fields: changes.map((c) => c.field) } } });
}

export interface ApproveResult {
  approved: number;
  refused: { id: string; label: string; reason: string }[];
}

/**
 * Explicit approval for the Question Bank. A question with a structural problem (no answer, no subject,
 * missing image, uncertain image placement, unsupported type, duplicate, a re-scan result waiting) is
 * refused with its reason — approval never hides a problem. Figure placements are NOT confirmed here:
 * each uncertain placement is confirmed on its own. Reviewable flags (uncertain text, near-duplicate,
 * numbering gap, topic, independent-read disagreement) are cleared by this decision and recorded.
 */
/** Findings a bulk approval never clears: each needs an administrator's look at that one question. */
export const DECIDE_INDIVIDUALLY = ["VERIFY2_DISAGREES", "SUBJECT_MISMATCH", "REFERENCE_CONFLICT"];

export async function approveQuestions(ids: string[], actorId: string): Promise<ApproveResult> {
  const settings = await getImporterSettings();
  // Decide on the current facts: changes made since the last check are re-checked first (no AI calls).
  const jobIds = [...new Set((await prisma.aiImportQuestion.findMany({ where: { id: { in: ids } }, select: { jobId: true } })).map((x) => x.jobId))];
  for (const j of jobIds) await revalidateQuestions(j, ids);
  const out: ApproveResult = { approved: 0, refused: [] };
  const done: string[] = [];
  for (const id of ids) {
    const q = await editable(id);
    if (q.status === AiImportQuestionStatus.REJECTED) {
      out.refused.push({ id, label: q.sourceLabel, reason: "rejected — restore it first" });
      continue;
    }
    if (await prisma.aiImportQuestionVersion.count({ where: { questionId: id, kind: "RESCAN", status: "PENDING" } })) {
      out.refused.push({ id, label: q.sourceLabel, reason: "a re-scan result is waiting for your choice" });
      continue;
    }
    // An unresolved disagreement is decided on its own question page, never cleared by a bulk approval.
    const unresolved = ids.length > 1 ? q.issueCodes.filter((c) => DECIDE_INDIVIDUALLY.includes(c)) : [];
    if (unresolved.length) {
      out.refused.push({ id, label: q.sourceLabel, reason: `unresolved ${unresolved.map((c) => ISSUE_DEFS[c]?.label ?? c).join(", ").toLowerCase()} — open the question and decide it on its own` });
      continue;
    }
    const figures = await prisma.aiImportFigure.findMany({ where: { questionId: id } });
    const why = importBlocker({ ...q, figures, issueCodes: q.issueCodes.filter((c) => !REVIEWABLE.includes(c)) }, settings, { ignoreApproval: true });
    if (why && why !== "already imported") {
      out.refused.push({ id, label: q.sourceLabel, reason: why });
      continue;
    }
    await prisma.aiImportQuestion.update({ where: { id }, data: { reviewedById: actorId, reviewedAt: new Date(), approvedById: actorId, approvedAt: new Date(), status: AiImportQuestionStatus.EXTRACTED } });
    await adminCheck(id, "Approved", `Approved for the Question Bank by an administrator${q.issueCodes.length ? ` (with flags reviewed: ${q.issueCodes.filter((c) => REVIEWABLE.includes(c)).join(", ") || "none"})` : ""}.`);
    done.push(id);
    out.approved++;
  }
  const jobId = (await prisma.aiImportQuestion.findUnique({ where: { id: ids[0] ?? "" }, select: { jobId: true } }))?.jobId;
  if (jobId && (out.approved || out.refused.length)) {
    await logEvent(jobId, "QUESTIONS_APPROVED", `${out.approved} question(s) approved${out.refused.length ? `; ${out.refused.length} refused (${out.refused.slice(0, 5).map((r) => `Q${r.label}: ${r.reason}`).join("; ")})` : ""}`, { ids: done, refused: out.refused }, actorId);
    if (out.approved) await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_QUESTIONS_APPROVED", entityType: "AiImportJob", entityId: jobId, metadata: { questionIds: done } } });
  }
  return out;
}

/** Approves every question of a job that passed every check with no flag at all (one explicit click). */
export async function approveAllClean(jobId: string, actorId: string): Promise<ApproveResult> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId, status: AiImportQuestionStatus.READY, questionId: null, approvedById: null, issueCodes: { isEmpty: true } }, select: { id: true } });
  if (!rows.length) throw new ImportJobError("No question is ready for approval without review. Open the questions with flags and approve them one by one.");
  return approveQuestions(rows.map((r) => r.id), actorId);
}

/** Withdraws an approval (the question stays out of the Question Bank until approved again). */
export async function unapproveQuestions(ids: string[], actorId: string): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const q = await editable(id);
    if (!q.approvedById) continue;
    await prisma.aiImportQuestion.update({ where: { id }, data: { ...UNAPPROVE } });
    await adminCheck(id, "Approval withdrawn", "Approval withdrawn by an administrator.");
    await logEvent(q.jobId, "APPROVAL_WITHDRAWN", `Q${q.sourceLabel}: approval withdrawn`, { questionId: id }, actorId);
    n++;
  }
  return n;
}

export async function rejectQuestions(ids: string[], actorId: string, reason: string) {
  for (const id of ids) {
    await editable(id);
    await prisma.aiImportQuestion.update({ where: { id }, data: { status: AiImportQuestionStatus.REJECTED, rejectedReason: reason.trim().slice(0, 300) || "Rejected by an administrator", reviewedById: actorId, reviewedAt: new Date() } });
    await adminCheck(id, "Rejected", reason || "Rejected by an administrator");
  }
  const first = ids.length ? await prisma.aiImportQuestion.findUnique({ where: { id: ids[0] }, select: { jobId: true } }) : null;
  if (first) {
    await logEvent(first.jobId, "QUESTIONS_REJECTED", `${ids.length} question(s) rejected`, { ids, reason }, actorId);
    await settleJobStatus(first.jobId);
  }
}

/** Reopens a rejected question (it is re-validated by the next pass). */
export async function restoreQuestion(id: string, actorId: string) {
  const q = await editable(id);
  if (q.status !== AiImportQuestionStatus.REJECTED) throw new ImportJobError("Only a rejected question can be restored.");
  await prisma.aiImportQuestion.update({ where: { id }, data: { status: AiImportQuestionStatus.EXTRACTED, rejectedReason: null } });
  await logEvent(q.jobId, "QUESTION_RESTORED", `Q${q.sourceLabel} restored`, { questionId: id }, actorId);
}

/** The admin chooses the correct answer by hand (stored as admin-confirmed — never as "official"). */
export async function setAnswer(id: string, actorId: string, labels: string[]) {
  const q = await editable(id);
  const e = effective(q);
  const clean = [...new Set(labels.map((l) => l.toUpperCase()))].filter((l) => e.options.some((o) => o.label === l));
  if (!clean.length) throw new ImportJobError("Choose at least one of the question's options.");
  if (q.questionType !== "MULTIPLE_CORRECT" && clean.length !== 1) throw new ImportJobError("A single-correct question has exactly one answer.");
  if (q.questionType === "MULTIPLE_CORRECT" && clean.length < 2) throw new ImportJobError("A multiple-correct question needs at least two answers.");
  await prisma.aiImportQuestion.update({ where: { id }, data: { finalAnswer: clean, answerConfirmedById: actorId, ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  await adminCheck(id, "Answer set", `Answer ${clean.join(", ")} chosen by an administrator${q.officialAnswer.length ? ` (official key: ${q.officialAnswer.join(", ")})` : ""}.`);
  await logEvent(q.jobId, "ANSWER_SET", `Q${q.sourceLabel}: answer ${clean.join(", ")} set by an administrator`, { questionId: id }, actorId);
}

/**
 * Subject / topic / sub-topic from the exam's own taxonomy only (existing ids; nothing is created). Recorded in the
 * question's checks, the job's events and the audit log; with `remember` the confirmed mapping is stored as a reusable
 * example of this exam (lib/ai-import/taxonomy-memory.ts). It never marks the question verified: its Verify 1 / Verify 2
 * results become out of date (the ids are part of their fingerprint) and it must still be approved.
 */
export async function setTaxonomy(id: string, actorId: string, subjectId: string, topicId: string | null, subTopicId: string | null = null, opts: { remember?: boolean; bulk?: boolean } = {}) {
  const q = await editable(id);
  const tax = await getExamTaxonomy(prisma, q.job.examId);
  const subject = tax.find((s) => s.id === subjectId);
  if (!subject) throw new ImportJobError("That subject is not configured for this exam.");
  if (q.job.paperType === "SINGLE_SUBJECT" && q.job.subjectId && q.job.subjectId !== subjectId) throw new ImportJobError("This import is a single-subject paper; its questions keep the selected subject.");
  const topic = topicId ? subject.topics.find((t) => t.id === topicId) : null;
  if (topicId && !topic) throw new ImportJobError("That topic does not belong to the subject (for this exam).");
  if (subTopicId && (!topic || !topic.subTopics.some((st) => st.id === subTopicId))) throw new ImportJobError("That sub-topic does not belong to the topic (for this exam).");
  const subTopic = subTopicId ? topic!.subTopics.find((st) => st.id === subTopicId)! : null;
  await prisma.aiImportQuestion.update({ where: { id }, data: { subjectId, topicId, subTopicId: subTopicId ?? null, taxonomyConfidence: 1, taxonomySource: "admin", ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  const remembered = opts.remember ? await rememberCorrection({ examId: q.job.examId, jobId: q.jobId, questionId: id, e: effective(q), subjectId, topicId, subTopicId: subTopicId ?? null, actorId, bulk: !!opts.bulk }) : false;
  await adminCheck(id, "Topic set", `${subject.name} › ${topic ? topic.name : "no topic"}${subTopic ? ` › ${subTopic.name}` : ""}${opts.bulk ? " (bulk correction)" : ""}${remembered ? " — saved as an example for this exam" : ""}`);
  await logEvent(q.jobId, "TAXONOMY_SET", `Q${q.sourceLabel}: ${subject.name} › ${topic?.name ?? "no topic"}${subTopic ? ` › ${subTopic.name}` : ""}${opts.bulk ? " (bulk)" : ""}${remembered ? " — saved as an example for this exam" : ""}`, { questionId: id, from: { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, source: q.taxonomySource }, to: { subjectId, topicId, subTopicId }, remembered, bulk: !!opts.bulk }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: opts.bulk ? "AI_IMPORT_TAXONOMY_BULK_SET" : "AI_IMPORT_TAXONOMY_SET", entityType: "AiImportQuestion", entityId: id, metadata: { jobId: q.jobId, from: { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, source: q.taxonomySource }, to: { subjectId, topicId, subTopicId: subTopicId ?? null }, remembered } } });
  return { remembered };
}

/**
 * Bulk subject / topic / subtopic correction of questions of ONE import, after an explicit confirmation of the exact
 * number of questions shown (a stale or scripted request cannot change more than was reviewed). Each question is
 * validated against its exam's own taxonomy by setTaxonomy (refusals are reported, nothing else is touched).
 */
export async function bulkSetTaxonomy(ids: string[], actorId: string, subjectId: string, topicId: string | null, subTopicId: string | null, confirm: { count: number; remember?: boolean } | null | undefined): Promise<{ updated: number; refused: string[]; remembered: number; jobId: string | null }> {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string"))].slice(0, 2000);
  if (!unique.length) throw new ImportJobError("Select the questions to correct.");
  if (typeof subjectId !== "string" || !subjectId) throw new ImportJobError("Choose a subject.");
  if (!confirm || confirm.count !== unique.length) throw new ImportJobError(`Confirm the bulk correction of the ${unique.length} selected question(s) first. Nothing was changed.`);
  const jobsOf = await prisma.aiImportQuestion.groupBy({ by: ["jobId"], where: { id: { in: unique } } });
  if (jobsOf.length !== 1) throw new ImportJobError(jobsOf.length ? "Bulk correction works on the questions of one import at a time. Nothing was changed." : "Question not found.");
  let updated = 0;
  let remembered = 0;
  const refused: string[] = [];
  for (const id of unique) {
    try {
      const r = await setTaxonomy(id, actorId, subjectId, topicId || null, subTopicId || null, { remember: confirm.remember === true, bulk: true });
      if (r.remembered) remembered++;
      updated++;
    } catch (e) {
      if (!(e instanceof ImportJobError)) throw e;
      refused.push(e.message);
    }
  }
  return { updated, refused: [...new Set(refused)].slice(0, 5), remembered, jobId: jobsOf[0].jobId };
}

async function figureHistory(questionId: string, jobId: string, actorId: string, note: string) {
  const [q, figs] = await Promise.all([prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: questionId } }), prisma.aiImportFigure.findMany({ where: { questionId } })]);
  await recordVersion({ questionId, jobId, kind: "ADMIN_EDIT", data: effective(q), figures: snapshotFigures(figs), actorId, note, changes: [{ field: "Figures", before: figs.map((f) => `${f.owner === "OPTION" ? `option ${f.optionLabel}` : f.owner.toLowerCase()} (${f.mappingStatus.toLowerCase()})`).join(", ") || "none", after: note }] });
}

/**
 * Re-assigns one figure (question text / option X) and confirms its placement, or detaches it from the
 * question ("not part of this question"). A detached figure keeps its row and its vault original, so it
 * can be attached again; nothing is deleted.
 */
export async function setFigure(figureId: string, actorId: string, owner: "STEM" | "OPTION" | "REMOVE", optionLabel: string | null) {
  const f = await prisma.aiImportFigure.findUnique({ where: { id: figureId } });
  if (!f?.questionId) throw new ImportJobError("Figure not found.", 404);
  const q = await editable(f.questionId);
  if (owner === "REMOVE") {
    await figureHistory(f.questionId, q.jobId, actorId, "A figure was detached (not part of this question)");
    if (f.source === "MISSING" || !f.originalKey) await prisma.aiImportFigure.delete({ where: { id: figureId } });
    else await prisma.aiImportFigure.update({ where: { id: figureId }, data: { questionId: null, owner: "UNASSIGNED", optionLabel: null, mappingStatus: "DETACHED", confirmedById: actorId } });
    await adminCheck(f.questionId, "Figure removed", "A figure was detached from this question by an administrator (the original stays in the vault).");
  } else {
    if (owner === "OPTION" && !/^[A-E]$/.test(optionLabel ?? "")) throw new ImportJobError("Choose option A, B, C, D or E.");
    if (f.mappingStatus === "MISSING") throw new ImportJobError("This figure could not be extracted; upload a replacement image instead.");
    await figureHistory(f.questionId, q.jobId, actorId, `Figure placed on ${owner === "OPTION" ? `option ${optionLabel}` : "the question text"} and confirmed`);
    await prisma.aiImportFigure.update({ where: { id: figureId }, data: { owner, optionLabel: owner === "OPTION" ? optionLabel : null, mappingStatus: "OK", confirmedById: actorId } });
    await adminCheck(f.questionId, "Figure confirmed", `Figure assigned to ${owner === "OPTION" ? `option ${optionLabel}` : "the question text"}.`);
  }
  await prisma.aiImportQuestion.update({ where: { id: f.questionId }, data: { ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  await logEvent(q.jobId, "FIGURE_SET", `Q${q.sourceLabel}: figure ${owner === "REMOVE" ? "detached" : `placed on ${owner === "OPTION" ? `option ${optionLabel}` : "the question text"}`}`, { questionId: q.id, figureId }, actorId);
}

/** Marks a figure's placement as uncertain again (it then needs confirming before approval). */
export async function markFigureUncertain(figureId: string, actorId: string, note: string) {
  const f = await prisma.aiImportFigure.findUnique({ where: { id: figureId } });
  if (!f?.questionId) throw new ImportJobError("Figure not found.", 404);
  const q = await editable(f.questionId);
  if (f.mappingStatus === "MISSING") throw new ImportJobError("This figure is already marked missing.");
  await figureHistory(f.questionId, q.jobId, actorId, "Figure placement marked uncertain");
  await prisma.aiImportFigure.update({ where: { id: figureId }, data: { mappingStatus: "UNCERTAIN", confirmedById: null, description: note.trim() ? note.trim().slice(0, 500) : f.description } });
  await prisma.aiImportQuestion.update({ where: { id: f.questionId }, data: { ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  await logEvent(q.jobId, "FIGURE_UNCERTAIN", `Q${q.sourceLabel}: figure marked uncertain`, { questionId: q.id, figureId }, actorId);
}

/** Records that the question needs an image the extraction did not capture (blocks approval until supplied). */
export async function markImageMissing(questionId: string, actorId: string, owner: "STEM" | "OPTION", optionLabel: string | null, note: string) {
  const q = await editable(questionId);
  if (owner === "OPTION" && !/^[A-E]$/.test(optionLabel ?? "")) throw new ImportJobError("Choose the option the missing image belongs to.");
  await figureHistory(questionId, q.jobId, actorId, `Image marked missing on ${owner === "OPTION" ? `option ${optionLabel}` : "the question text"}`);
  await prisma.aiImportFigure.create({ data: { jobId: q.jobId, fileId: q.fileId, pageNumber: q.pages[0] ?? 0, questionId, owner, optionLabel: owner === "OPTION" ? optionLabel : null, source: "MISSING", originalKey: "", originalSha256: "", originalMime: "", width: 0, height: 0, bytes: 0, description: (note.trim() || "Marked missing by an administrator").slice(0, 500), confidence: 0, mappingStatus: "MISSING" } });
  await prisma.aiImportQuestion.update({ where: { id: questionId }, data: { ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  await logEvent(q.jobId, "IMAGE_MARKED_MISSING", `Q${q.sourceLabel}: an image is missing on ${owner === "OPTION" ? `option ${optionLabel}` : "the question text"}`, { questionId }, actorId);
}

const UPLOAD_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * An administrator's image for a question or option: a replacement for an extracted figure (cropped,
 * wrong or missing) or an image the extraction did not capture. The upload is decoded and stored as a
 * new vault original; the figure it replaces is detached, never deleted, and the change is recorded.
 */
export async function attachUploadedFigure(input: { questionId: string; actorId: string; bytes: Buffer; mime: string; owner: "STEM" | "OPTION"; optionLabel: string | null; replaceFigureId: string | null }) {
  const q = await editable(input.questionId);
  const ext = UPLOAD_EXT[input.mime];
  if (!ext) throw new ImportJobError("Upload a PNG, JPEG or WebP image.");
  if (input.bytes.length > 10 * 1024 * 1024) throw new ImportJobError("The image is larger than 10 MB.");
  if (input.owner === "OPTION" && !/^[A-E]$/.test(input.optionLabel ?? "")) throw new ImportJobError("Choose the option this image belongs to.");
  const old = input.replaceFigureId ? await prisma.aiImportFigure.findUnique({ where: { id: input.replaceFigureId } }) : null;
  if (input.replaceFigureId && (!old || old.questionId !== q.id)) throw new ImportJobError("The image to replace does not belong to this question.", 404);
  let stored;
  try {
    stored = await storeOriginalFigure(input.bytes, ext);
  } catch (e) {
    throw new ImportJobError(e instanceof FigureError ? e.message : "The image could not be read.");
  }
  await figureHistory(q.id, q.jobId, input.actorId, old ? "Figure replaced by an uploaded image" : "Image uploaded");
  await prisma.$transaction(async (tx) => {
    if (old) {
      if (old.source === "MISSING" || !old.originalKey) await tx.aiImportFigure.delete({ where: { id: old.id } });
      else await tx.aiImportFigure.update({ where: { id: old.id }, data: { questionId: null, owner: "UNASSIGNED", optionLabel: null, mappingStatus: "REPLACED", confirmedById: input.actorId } });
    }
    await tx.aiImportFigure.create({
      data: {
        jobId: q.jobId,
        fileId: q.fileId,
        pageNumber: old?.pageNumber ?? q.pages[0] ?? 0,
        questionId: q.id,
        owner: input.owner,
        optionLabel: input.owner === "OPTION" ? input.optionLabel : null,
        sharedGroup: old?.sharedGroup ?? null,
        source: "ADMIN_UPLOAD",
        originalKey: stored.key,
        originalSha256: stored.sha256,
        originalMime: stored.mime,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
        description: old?.description && old.source !== "MISSING" ? old.description : `Uploaded by an administrator`,
        confidence: 1,
        mappingStatus: "OK",
        confirmedById: input.actorId,
      },
    });
    await tx.aiImportQuestion.update({ where: { id: q.id }, data: { ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  });
  await adminCheck(q.id, "Image uploaded", `${old ? "Replacement" : "New"} image (${stored.width}×${stored.height}) on ${input.owner === "OPTION" ? `option ${input.optionLabel}` : "the question text"}.`);
  await logEvent(q.jobId, "FIGURE_UPLOADED", `Q${q.sourceLabel}: ${old ? "figure replaced by an uploaded image" : "image uploaded"} (${stored.width}×${stored.height})`, { questionId: q.id, replaced: old?.id ?? null }, input.actorId);
}

/**
 * An administrator's crop of the ORIGINAL page: a corrected box for an extracted figure (the earlier crop is
 * detached and kept, with its vault original) or another figure for the same question / option. The page
 * render is re-created from the original upload when needed and is never modified. The new crop is placed
 * and confirmed by the administrator.
 */
export async function cropFigureFromPage(input: { questionId: string; actorId: string; pageNumber: number; box: { x: number; y: number; w: number; h: number }; owner: "STEM" | "OPTION"; optionLabel: string | null; replaceFigureId: string | null }) {
  const q = await editable(input.questionId);
  if (input.owner === "OPTION" && !/^[A-E]$/.test(input.optionLabel ?? "")) throw new ImportJobError("Choose the option this image belongs to.");
  const norm = normalizeBox(input.box, 1);
  if (!norm.box) throw new ImportJobError(`The crop cannot be used: ${norm.problem}.`);
  const old = input.replaceFigureId ? await prisma.aiImportFigure.findUnique({ where: { id: input.replaceFigureId } }) : null;
  if (input.replaceFigureId && (!old || old.questionId !== q.id)) throw new ImportJobError("The image to replace does not belong to this question.", 404);
  const file = await prisma.aiImportFile.findUnique({ where: { id: q.fileId } });
  const kind = (file?.detected as { kind?: string } | null)?.kind;
  if (!file?.storageKey || file.status === "PURGED") throw new ImportJobError("The original file is no longer stored, so a new crop cannot be cut. Upload the image instead.");
  if (kind !== "pdf" && kind !== "png" && kind !== "jpeg") throw new ImportJobError("This document has no page images to crop from. Upload the image instead.");
  const page = await prisma.aiImportPage.findUnique({ where: { fileId_pageNumber: { fileId: file.id, pageNumber: input.pageNumber } } });
  if (!page) throw new ImportJobError("That page is not part of this paper.", 404);
  const settings = await getImporterSettings();
  const render = await ensureRender({ id: q.jobId }, file, input.pageNumber, settings.limits.renderDpi);
  const crop = await cropFromRender(render, norm.box, 0);
  if (!crop) throw new ImportJobError("The crop is too small. Draw a larger box around the figure.");
  if (Math.min(crop.width, crop.height) < MIN_CROP_SIDE) throw new ImportJobError(`The crop is only ${crop.width}×${crop.height} px. Draw a larger box around the whole figure.`);
  let stored;
  try {
    stored = await storeOriginalFigure(crop.bytes, "png");
  } catch (e) {
    throw new ImportJobError(e instanceof FigureError ? e.message : "The crop could not be stored.");
  }
  const where = input.owner === "OPTION" ? `option ${input.optionLabel}` : "the question text";
  await figureHistory(q.id, q.jobId, input.actorId, old ? `Figure re-cropped from page ${input.pageNumber}` : `Crop added from page ${input.pageNumber}`);
  await prisma.$transaction(async (tx) => {
    if (old) {
      if (old.source === "MISSING" || !old.originalKey) await tx.aiImportFigure.delete({ where: { id: old.id } });
      else await tx.aiImportFigure.update({ where: { id: old.id }, data: { questionId: null, owner: "UNASSIGNED", optionLabel: null, mappingStatus: "REPLACED", confirmedById: input.actorId } });
    }
    await tx.aiImportFigure.create({
      data: {
        jobId: q.jobId,
        fileId: q.fileId,
        pageNumber: input.pageNumber,
        questionId: q.id,
        owner: input.owner,
        optionLabel: input.owner === "OPTION" ? input.optionLabel : null,
        sharedGroup: old?.sharedGroup ?? null,
        box: { ...norm.box, crop: { from: "render", width: crop.width, height: crop.height }, reason: `Cropped from page ${input.pageNumber} by an administrator.` },
        source: "CROP",
        originalKey: stored.key,
        originalSha256: stored.sha256,
        originalMime: stored.mime,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
        description: old?.description && old.source !== "MISSING" ? old.description : null,
        confidence: 1,
        mappingStatus: "OK",
        confirmedById: input.actorId,
      },
    });
    await tx.aiImportQuestion.update({ where: { id: q.id }, data: { ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  });
  await adminCheck(q.id, old ? "Figure re-cropped" : "Crop added", `${old ? "Corrected" : "New"} crop (${stored.width}×${stored.height}) from page ${input.pageNumber} on ${where}; the earlier image stays in the vault.`);
  await logEvent(q.jobId, old ? "FIGURE_RECROPPED" : "FIGURE_CROP_ADDED", `Q${q.sourceLabel}: ${old ? "figure re-cropped" : "crop added"} from page ${input.pageNumber} (${stored.width}×${stored.height}) on ${where}`, { questionId: q.id, replaced: old?.id ?? null, box: norm.box }, input.actorId);
}

export async function allowDuplicate(id: string, actorId: string, allow: boolean) {
  const q = await editable(id);
  await prisma.aiImportQuestion.update({ where: { id }, data: { allowDuplicate: allow, ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  await adminCheck(id, allow ? "Duplicate accepted" : "Duplicate check restored", allow ? "The administrator chose to import this question even though it resembles an existing one." : "Duplicate check applies again.");
  await logEvent(q.jobId, "DUPLICATE_DECISION", `Q${q.sourceLabel}: ${allow ? "import anyway" : "treat as duplicate"}`, { questionId: id }, actorId);
}

// ---- Re-scan / re-extract ----------------------------------------------------------------------

export type RescanScope = "question" | "page";

/**
 * Re-scans questions from the ORIGINAL uploaded file (the page is rendered again from the vault copy and
 * read by the job's page-reading model). `question` saves only these questions' results; `page` re-reads
 * every question on their pages. Manual corrections are never overwritten: the worker keeps the new read
 * as a version to compare (lib/ai-import/process.ts saveQuestion). Refused — with the reason — when the
 * original is gone, the file was read exactly (Word / spreadsheet), or paid AI cannot run.
 */
export async function rescanQuestions(ids: string[], scope: RescanScope, actorId: string): Promise<{ pages: number; questions: number }> {
  const qs = await prisma.aiImportQuestion.findMany({ where: { id: { in: ids } }, select: { id: true, jobId: true, fileId: true, pages: true, status: true, sourceKey: true, sourceLabel: true } });
  if (!qs.length) throw new ImportJobError("Select the questions to re-scan.");
  const jobId = qs[0].jobId;
  if (qs.some((q) => q.jobId !== jobId)) throw new ImportJobError("Re-scan questions of one import at a time.");
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.QUEUED) throw new ImportJobError("The import is running right now. Re-scan when it has finished.");
  if (job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("This import was cancelled.");
  if (!job.confirmedAt) throw new ImportJobError("This import was never processed, so there is nothing to re-scan.");
  const settings = await getImporterSettings();
  if (!settings.aiEnabled) throw new ImportJobError("Re-scanning reads the original page again with AI, and paid AI is switched off in Import Settings. Nothing was changed — correct the question by hand, or switch paid AI on first.");
  if (!planOf(job.config)?.tasks.extract.model) throw new ImportJobError("This import's confirmed model plan has no page-reading model, so its pages cannot be read again. Nothing was changed — use Reconfigure Models, or correct the question by hand.");
  const open = qs.filter((q) => !LOCKED.includes(q.status));
  if (!open.length) throw new ImportJobError("These questions are already in the Question Bank — edit them there.");
  const files = await prisma.aiImportFile.findMany({ where: { id: { in: [...new Set(open.map((q) => q.fileId))] } } });
  for (const f of files) {
    const kind = (f.detected as { kind?: string } | null)?.kind;
    if (kind === "docx" || kind === "xlsx" || kind === "csv") throw new ImportJobError(`${f.originalName} is a ${kind.toUpperCase()} file, read exactly (no AI): re-scanning would give the same result. Correct the question by hand.`);
    if (f.status === "PURGED" || !f.storageKey || !(await vaultExists(f.storageKey))) throw new ImportJobError(`The original file ${f.originalName} is no longer stored (removed after its retention period), so its pages cannot be re-scanned. Nothing was changed — correct the question by hand.`);
  }
  const byPage = new Map<string, { fileId: string; page: number; keys: Set<string> }>();
  for (const q of open) {
    if (!q.pages.length) throw new ImportJobError(`Q${q.sourceLabel} has no source page recorded. Set its source page (Edit) first.`);
    for (const p of q.pages) {
      const k = `${q.fileId}|${p}`;
      const e = byPage.get(k) ?? { fileId: q.fileId, page: p, keys: new Set<string>() };
      e.keys.add(q.sourceKey);
      byPage.set(k, e);
    }
  }
  const now = new Date().toISOString();
  let pages = 0;
  for (const e of byPage.values()) {
    const page = await prisma.aiImportPage.findUnique({ where: { fileId_pageNumber: { fileId: e.fileId, pageNumber: e.page } } });
    if (!page || page.kind === "BLANK" || page.kind === "DOCUMENT") continue;
    const raw = (page.rawOutput as Record<string, unknown> | null) ?? {};
    const prev = raw.rescan as RescanRequest | undefined;
    const keys = scope === "page" || (prev && prev.keys === null) ? null : [...new Set([...(prev?.keys ?? []), ...e.keys])];
    await prisma.aiImportPage.update({ where: { id: page.id }, data: { status: AiImportPageStatus.PENDING, errorMessage: null, rawOutput: { ...raw, rescan: { keys, requestedById: actorId, requestedAt: now } } as Prisma.InputJsonValue } });
    pages++;
  }
  if (!pages) throw new ImportJobError("No readable source page was found for these questions.");
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: job.status }, data: { status: AiImportJobStatus.QUEUED, finishedAt: null, errorMessage: null } });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  await logEvent(jobId, "RESCAN_REQUESTED", `Re-scan requested: ${scope === "page" ? `${pages} whole page(s)` : `${open.length} question(s) on ${pages} page(s)`} are read again from the original file. Manual corrections are kept; new results you have to choose from appear on each question.`, { scope, questionIds: open.map((q) => q.id), pages }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_RESCAN_REQUESTED", entityType: "AiImportJob", entityId: jobId, metadata: { scope, questionIds: open.map((q) => q.id) } } });
  kickWorker();
  return { pages, questions: open.length };
}

/** Kept for the job page's "Reprocess with AI": a whole-page re-scan. */
export async function reprocessQuestions(ids: string[], actorId: string) {
  await rescanQuestions(ids, "page", actorId);
}

/**
 * The administrator's choice on a PENDING re-scan result: the listed fields come from the re-scan,
 * everything else stays as it is now (manual corrections included). Figures are taken as a set.
 */
export async function applyRescan(versionId: string, actorId: string, fields: string[]) {
  const v = await prisma.aiImportQuestionVersion.findUnique({ where: { id: versionId } });
  if (!v || v.kind !== "RESCAN") throw new ImportJobError("Re-scan result not found.", 404);
  if (v.status !== "PENDING") throw new ImportJobError("This re-scan result was already decided.");
  const q = await editable(v.questionId);
  const take = new Set(fields.filter((f): f is RescanField => (RESCAN_FIELDS as readonly string[]).includes(f)));
  const current = effective(q);
  const next = v.data as unknown as ExtractedQuestion;
  const merged = mergeChoice(current, next, take);
  const nextFigs = (v.figures as unknown as FigureSnapshot[] | null) ?? [];
  const figs = await prisma.aiImportFigure.findMany({ where: { questionId: q.id } });
  const diffs = compareVersions(current, snapshotFigures(figs), next, nextFigs).filter((d) => take.has(d.field) && !d.same);
  await prisma.$transaction(async (tx) => {
    await tx.aiImportQuestionVersion.create({ data: { questionId: q.id, jobId: q.jobId, kind: "ADMIN_EDIT", data: current as unknown as Prisma.InputJsonValue, figures: snapshotFigures(figs) as unknown as Prisma.InputJsonValue, changes: diffs.map((d) => ({ field: d.label, before: d.current, after: d.rescan })) as unknown as Prisma.InputJsonValue, actorId, note: `Re-scan applied for: ${[...take].join(", ") || "nothing"}` } });
    if (take.has("figures")) {
      // The current figures are detached (kept), the re-scan's figures are attached unconfirmed.
      await tx.aiImportFigure.updateMany({ where: { questionId: q.id, source: { not: "MISSING" } }, data: { questionId: null, owner: "UNASSIGNED", optionLabel: null, mappingStatus: "REPLACED" } });
      await tx.aiImportFigure.deleteMany({ where: { questionId: q.id, source: "MISSING" } });
      if (nextFigs.length) await tx.aiImportFigure.createMany({ data: figureRows(nextFigs, { jobId: q.jobId, fileId: q.fileId, questionId: q.id }) });
    }
    await tx.aiImportQuestion.update({ where: { id: q.id }, data: { editedData: merged as unknown as Prisma.InputJsonValue, sourceLabel: merged.label, questionType: merged.type, optionCount: merged.options.length, contentFormat: merged.contentFormat, ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
    await tx.aiImportQuestionVersion.update({ where: { id: v.id }, data: { status: "APPLIED", decidedAt: new Date(), decidedById: actorId, note: `Applied: ${[...take].join(", ") || "nothing (kept the current question)"}` } });
  });
  await adminCheck(q.id, "Re-scan decided", take.size ? `Taken from the re-scan: ${[...take].join(", ")}; everything else kept.` : "Kept the current question; the re-scan result was not used.");
  await logEvent(q.jobId, "RESCAN_APPLIED", `Q${q.sourceLabel}: re-scan result ${take.size ? `applied for ${[...take].join(", ")}` : "not used"}`, { questionId: q.id, versionId, fields: [...take] }, actorId);
}

export async function discardRescan(versionId: string, actorId: string) {
  const v = await prisma.aiImportQuestionVersion.findUnique({ where: { id: versionId } });
  if (!v || v.kind !== "RESCAN") throw new ImportJobError("Re-scan result not found.", 404);
  if (v.status !== "PENDING") throw new ImportJobError("This re-scan result was already decided.");
  const q = await editable(v.questionId);
  await prisma.aiImportQuestionVersion.update({ where: { id: v.id }, data: { status: "DISCARDED", decidedAt: new Date(), decidedById: actorId } });
  await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.EXTRACTED } });
  await adminCheck(q.id, "Re-scan discarded", "Kept the current question; the re-scan result was discarded (it stays in the history).");
  await logEvent(q.jobId, "RESCAN_DISCARDED", `Q${q.sourceLabel}: re-scan result discarded`, { questionId: q.id, versionId }, actorId);
}

/**
 * Re-classifies subject/topic with the job's classification model: the AI suggestion is cleared for
 * these questions (an administrator's choice is never touched) and the job runs its checks again.
 */
export async function reclassifyQuestions(ids: string[], actorId: string): Promise<number> {
  const qs = await prisma.aiImportQuestion.findMany({ where: { id: { in: ids } }, select: { id: true, jobId: true, status: true, taxonomySource: true } });
  if (!qs.length) throw new ImportJobError("Select the questions to re-classify.");
  const jobId = qs[0].jobId;
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.QUEUED || job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("The import is running or cancelled. Try again when it has finished.");
  const settings = await getImporterSettings();
  // The free local classifier always runs; the AI classifier only for what it cannot settle, when paid AI is on and the
  // import's model plan has a classification model.
  const aiToo = settings.aiEnabled && !!planOf(job.config)?.tasks.classify.model;
  const target = qs.filter((q) => !LOCKED.includes(q.status) && !q.taxonomySource?.startsWith("admin"));
  if (!target.length) throw new ImportJobError("Every selected question has a subject/topic chosen by an administrator (or is already stored); nothing to re-classify.");
  // An AI-chosen subject is cleared too (a wrong subject would otherwise survive and block every correct topic);
  // a subject from the paper itself (selected subject, printed heading / column) is kept.
  const aiChosen = target.filter((q) => !q.taxonomySource || q.taxonomySource.startsWith("AI") || q.taxonomySource === "local classifier" || q.taxonomySource === "confirmed example").map((q) => q.id);
  if (aiChosen.length) await prisma.aiImportQuestion.updateMany({ where: { id: { in: aiChosen } }, data: { subjectId: null } });
  await prisma.aiImportQuestion.updateMany({ where: { id: { in: target.map((q) => q.id) } }, data: { topicId: null, subTopicId: null, taxonomyConfidence: null, taxonomySource: null, ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: job.status }, data: { status: AiImportJobStatus.QUEUED, finishedAt: null } });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  await logEvent(jobId, "RECLASSIFY_REQUESTED", `${target.length} question(s) queued for subject/topic classification (free local classifier${aiToo ? ", then the AI classifier for what it cannot settle" : "; AI classification is off or not in this import's model plan"})`, { questionIds: target.map((q) => q.id), ai: aiToo }, actorId);
  kickWorker();
  return target.length;
}

/** Records that the remaining count difference / missing numbers are explained (they stay in the report). */
export async function acknowledgeSequence(jobId: string, actorId: string, note: string) {
  if (note.trim().length < 5) throw new ImportJobError("Explain the difference (at least a few words), e.g. \"Q37 was withdrawn by the board\".");
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { config: true, status: true } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  // What is acknowledged is the CURRENT difference, computed here; it lapses when the facts change.
  const quality = await jobQuality(jobId);
  if (!quality) throw new ImportJobError("Import job not found.", 404);
  if (!quality.missing.length && !quality.countDifference) throw new ImportJobError("There is no count difference or missing number to acknowledge.");
  const expect = { missing: quality.missing, expected: quality.expected, counted: quality.counted };
  const ack: SequenceAck = { byId: actorId, at: new Date().toISOString(), note: note.trim().slice(0, 500), missing: expect.missing.slice(0, 1000), expected: expect.expected, counted: expect.counted };
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { config: { ...((job.config as object) ?? {}), sequenceAck: ack } as unknown as Prisma.InputJsonValue } });
  await settleJobStatus(jobId);
  await logEvent(jobId, "SEQUENCE_ACKNOWLEDGED", `Count difference acknowledged: ${ack.note} (expected ${ack.expected ?? "—"}, counted ${ack.counted}, missing ${ack.missing.join(", ") || "none"})`, ack as unknown as Record<string, unknown>, actorId);
}

/**
 * Adds a question the extraction missed, as an empty record at its printed number and page, so it can
 * be filled in (Edit), re-scanned and approved like any other. Never invented from AI output.
 */
export async function addMissingQuestion(input: { jobId: string; fileId: string; number: number; section: string; page: number; actorId: string }): Promise<string> {
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.QUEUED || job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("The import is running or cancelled.");
  const file = await prisma.aiImportFile.findUnique({ where: { id: input.fileId } });
  if (!file || file.jobId !== job.id || file.role !== "PAPER") throw new ImportJobError("Choose a question paper of this import.");
  if (!Number.isInteger(input.number) || input.number < 1 || input.number > 999) throw new ImportJobError("The question number must be a whole number from 1 to 999.");
  if (!Number.isInteger(input.page) || input.page < 1 || input.page > (file.pageCount ?? 1)) throw new ImportJobError(`The page must be between 1 and ${file.pageCount ?? 1}.`);
  const section = /^S\d{1,2}$/.test(input.section) ? input.section : "";
  const key = `${section}#${input.number}`;
  if (await prisma.aiImportQuestion.findUnique({ where: { fileId_sourceKey: { fileId: file.id, sourceKey: key } }, select: { id: true } })) throw new ImportJobError(`Question ${section ? `${section} ` : ""}${input.number} already exists in this import.`);
  const after = await prisma.aiImportQuestion.findFirst({ where: { fileId: file.id, sourceNumber: { lt: input.number } }, orderBy: { orderIndex: "desc" }, select: { orderIndex: true } });
  const data: ExtractedQuestion = { section, number: input.number, label: String(input.number), pages: [input.page], type: "SINGLE_CORRECT", stem: "", options: ["A", "B", "C", "D"].map((l) => ({ label: l, printed: l, text: "" })), printedAnswer: [], contentFormat: "PLAIN", confidence: 0, unreadable: [], figures: [], method: "ADMIN", notes: ["Added by an administrator as missing from the extraction."] };
  const row = await prisma.aiImportQuestion.create({ data: { jobId: job.id, fileId: file.id, sourceKey: key, sourceNumber: input.number, sourceLabel: String(input.number), pages: [input.page], orderIndex: after?.orderIndex ?? 0, status: AiImportQuestionStatus.EXTRACTED, data: data as unknown as Prisma.InputJsonValue, questionType: "SINGLE_CORRECT", optionCount: 4, confidence: 0, issueCodes: ["OPTIONS_INCOMPLETE"] } });
  await logEvent(job.id, "QUESTION_ADDED", `Missing question ${section ? `${section} ` : ""}Q${input.number} (page ${input.page}) added by an administrator`, { questionId: row.id }, input.actorId);
  return row.id;
}

/** Admin chooses how to import: draft only, or import and publish (all eligible / selected). */
export async function requestImport(jobId: string, actorId: string, mode: ImportMode, questionIds: string[] | null) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  const allowed: AiImportJobStatus[] = [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.COMPLETED_WITH_ISSUES, AiImportJobStatus.COMPLETED];
  if (!allowed.includes(job.status)) throw new ImportJobError("Questions can be imported once processing has finished.");
  if (mode === "PUBLISH_SELECTED" && !questionIds?.length) throw new ImportJobError("Select the questions to publish.");
  const plan: ImportPlan = { mode, questionIds: mode === "PUBLISH_SELECTED" ? questionIds : null, requestedById: actorId, requestedAt: new Date().toISOString() };
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: { in: allowed } }, data: { status: AiImportJobStatus.IMPORTING, config: { ...((job.config as object) ?? {}), importPlan: plan } as unknown as Prisma.InputJsonValue } });
  if (!r.count) throw new ImportJobError("Another import of this job has just started.", 409);
  await logEvent(jobId, "IMPORT_REQUESTED", mode === "DRAFT" ? "Import as Draft requested" : mode === "PUBLISH_ALL" ? "Import & Publish All Eligible requested" : `Import & Publish Selected requested (${questionIds?.length ?? 0})`, { mode, count: questionIds?.length ?? null }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_REQUESTED", entityType: "AiImportJob", entityId: jobId, metadata: { mode, selected: questionIds?.length ?? null } } });
  kickWorker();
}

/** Extends how long an original paper is kept (Original Paper Vault). */
export async function extendRetention(fileId: string, actorId: string, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new ImportJobError("Choose between 1 and 3650 days.");
  const f = await prisma.aiImportFile.findUnique({ where: { id: fileId } });
  if (!f || !f.storageKey || f.status === "PURGED") throw new ImportJobError("File not found in the vault.", 404);
  const base = f.retainUntil && f.retainUntil > new Date() ? f.retainUntil : new Date();
  const until = new Date(base.getTime() + days * 86_400_000);
  await prisma.aiImportFile.update({ where: { id: fileId }, data: { retainUntil: until } });
  await logEvent(f.jobId, "RETENTION_EXTENDED", `${f.originalName}: kept until ${until.toISOString().slice(0, 10)}`, { fileId, days }, actorId);
}

/** Deterministic re-check of edited questions right away (no AI calls), then the job's status follows its quality. */
export async function revalidateQuestions(jobId: string, ids: string[]) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job || BUSY.includes(job.status)) return;
  const settings = await getImporterSettings();
  await runPostProcessing({ job, settings: { ...settings, aiEnabled: false }, examName: "", subjectName: null, stillRunning: async () => true }, new Set(ids));
  await settleJobStatus(jobId);
}
