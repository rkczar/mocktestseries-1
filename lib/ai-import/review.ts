import "server-only";
import { AiImportJobStatus, AiImportPageStatus, AiImportQuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logEvent, ImportJobError } from "@/lib/ai-import/jobs";
import { kickWorker } from "@/lib/ai-import/kick";
import { effective, runPostProcessing } from "@/lib/ai-import/post";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { planOf } from "@/lib/ai-import/select";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import type { ImportMode, ImportPlan } from "@/lib/ai-import/adapter";
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
}

/** Saves an admin's correction as editedData (the extraction itself is never overwritten). */
export async function editQuestion(questionId: string, actorId: string, edit: QuestionEdit) {
  const q = await editable(questionId);
  const base = effective(q);
  if (!edit.stem.trim()) throw new ImportJobError("The question text cannot be empty.");
  if (edit.options.length > 6) throw new ImportJobError("Too many options.");
  const next: ExtractedQuestion = {
    ...base,
    stem: edit.stem.trim().slice(0, 20_000),
    options: edit.options.map((o, i) => ({ label: String.fromCharCode(65 + i), printed: base.options[i]?.printed ?? String.fromCharCode(65 + i), text: o.text.trim().slice(0, 5_000) })),
    type: edit.type,
    contentFormat: edit.contentFormat,
    listI: edit.listI ?? base.listI ?? null,
    listII: edit.listII ?? base.listII ?? null,
    confidence: 1,
    unreadable: [],
    method: `${base.method}+ADMIN`,
    notes: [...(base.notes ?? []), `Corrected by an administrator.`],
  };
  await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { editedData: next as unknown as Prisma.InputJsonValue, reviewedById: actorId, reviewedAt: new Date(), status: AiImportQuestionStatus.EXTRACTED, questionType: next.type, optionCount: next.options.length, contentFormat: next.contentFormat } });
  await adminCheck(q.id, "Edited", "Question corrected by an administrator.");
  await logEvent(q.jobId, "QUESTION_EDITED", `Q${base.label} corrected`, { questionId: q.id }, actorId);
}

/** Admin looked at the question: clears the reviewable flags and confirms its figure mapping. */
export async function approveQuestions(ids: string[], actorId: string) {
  let n = 0;
  for (const id of ids) {
    const q = await editable(id);
    await prisma.aiImportQuestion.update({ where: { id }, data: { reviewedById: actorId, reviewedAt: new Date(), status: AiImportQuestionStatus.EXTRACTED } });
    await prisma.aiImportFigure.updateMany({ where: { questionId: id, mappingStatus: { not: "MISSING" } }, data: { confirmedById: actorId, mappingStatus: "OK" } });
    await adminCheck(id, "Approved", "Reviewed and approved by an administrator (structural problems, if any, still block import).");
    n++;
    void q;
  }
  if (n) {
    const first = await prisma.aiImportQuestion.findUnique({ where: { id: ids[0] }, select: { jobId: true } });
    if (first) await logEvent(first.jobId, "QUESTIONS_APPROVED", `${n} question(s) approved`, { ids }, actorId);
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
  if (first) await logEvent(first.jobId, "QUESTIONS_REJECTED", `${ids.length} question(s) rejected`, { ids, reason }, actorId);
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
  await prisma.aiImportQuestion.update({ where: { id }, data: { finalAnswer: clean, answerConfirmedById: actorId, status: AiImportQuestionStatus.EXTRACTED } });
  await adminCheck(id, "Answer set", `Answer ${clean.join(", ")} chosen by an administrator${q.officialAnswer.length ? ` (official key: ${q.officialAnswer.join(", ")})` : ""}.`);
  await logEvent(q.jobId, "ANSWER_SET", `Q${q.sourceLabel}: answer ${clean.join(", ")} set by an administrator`, { questionId: id }, actorId);
}

/** Subject/topic from the exam's own taxonomy only. */
export async function setTaxonomy(id: string, actorId: string, subjectId: string, topicId: string | null) {
  const q = await editable(id);
  const tax = await getExamTaxonomy(prisma, q.job.examId);
  const subject = tax.find((s) => s.id === subjectId);
  if (!subject) throw new ImportJobError("That subject is not configured for this exam.");
  if (topicId && !subject.topics.some((t) => t.id === topicId)) throw new ImportJobError("That topic does not belong to the subject (for this exam).");
  await prisma.aiImportQuestion.update({ where: { id }, data: { subjectId, topicId, taxonomyConfidence: 1, taxonomySource: "admin", status: AiImportQuestionStatus.EXTRACTED } });
  await adminCheck(id, "Topic set", `${subject.name} › ${topicId ? subject.topics.find((t) => t.id === topicId)!.name : "no topic"}`);
}

/** Re-assigns one figure (stem / option X / not part of this question) and confirms it. */
export async function setFigure(figureId: string, actorId: string, owner: "STEM" | "OPTION" | "REMOVE", optionLabel: string | null) {
  const f = await prisma.aiImportFigure.findUnique({ where: { id: figureId } });
  if (!f?.questionId) throw new ImportJobError("Figure not found.", 404);
  await editable(f.questionId);
  if (owner === "REMOVE") {
    await prisma.aiImportFigure.delete({ where: { id: figureId } });
    await adminCheck(f.questionId, "Figure removed", "A figure was detached from this question by an administrator (the original stays in the vault).");
  } else {
    if (owner === "OPTION" && !/^[A-D]$/.test(optionLabel ?? "")) throw new ImportJobError("Choose option A, B, C or D.");
    if (f.mappingStatus === "MISSING") throw new ImportJobError("This figure could not be extracted; it cannot be attached.");
    await prisma.aiImportFigure.update({ where: { id: figureId }, data: { owner, optionLabel: owner === "OPTION" ? optionLabel : null, mappingStatus: "OK", confirmedById: actorId } });
    await adminCheck(f.questionId, "Figure confirmed", `Figure assigned to ${owner === "OPTION" ? `option ${optionLabel}` : "the question text"}.`);
  }
  await prisma.aiImportQuestion.update({ where: { id: f.questionId }, data: { status: AiImportQuestionStatus.EXTRACTED } });
}

export async function allowDuplicate(id: string, actorId: string, allow: boolean) {
  const q = await editable(id);
  await prisma.aiImportQuestion.update({ where: { id }, data: { allowDuplicate: allow, status: AiImportQuestionStatus.EXTRACTED } });
  await adminCheck(id, allow ? "Duplicate accepted" : "Duplicate check restored", allow ? "The administrator chose to import this question even though it resembles an existing one." : "Duplicate check applies again.");
  await logEvent(q.jobId, "DUPLICATE_DECISION", `Q${q.sourceLabel}: ${allow ? "import anyway" : "treat as duplicate"}`, { questionId: id }, actorId);
}

/** Queues another AI read of the pages of these questions (admin edits are kept). */
export async function reprocessQuestions(ids: string[], actorId: string) {
  const qs = await prisma.aiImportQuestion.findMany({ where: { id: { in: ids } }, select: { id: true, jobId: true, fileId: true, pages: true, status: true } });
  if (!qs.length) throw new ImportJobError("Nothing to reprocess.");
  const jobId = qs[0].jobId;
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("The import is busy or cancelled.");
  const settings = await getImporterSettings();
  if (!settings.aiEnabled || !planOf(job.config)?.tasks.extract.model) throw new ImportJobError("Reprocessing reads the page again with AI, which is switched off or has no page-reading model in this job's confirmed model plan.");
  let pages = 0;
  for (const q of qs) {
    if (LOCKED.includes(q.status)) continue;
    const r = await prisma.aiImportPage.updateMany({ where: { fileId: q.fileId, pageNumber: { in: q.pages }, kind: { in: ["TEXT", "TEXT_UNRELIABLE", "SCANNED"] } }, data: { status: AiImportPageStatus.PENDING, errorMessage: null } });
    pages += r.count;
    await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.EXTRACTED } });
  }
  if (!pages) throw new ImportJobError("These questions come from documents that are read exactly (DOCX / spreadsheet); edit them instead.");
  await prisma.aiImportJob.update({ where: { id: jobId }, data: { status: AiImportJobStatus.QUEUED, finishedAt: null } });
  await logEvent(jobId, "REPROCESS", `${pages} page(s) queued for another AI read`, { questionIds: ids }, actorId);
  kickWorker();
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

/** Deterministic re-check of edited questions right away (no AI calls). */
export async function revalidateQuestions(jobId: string, ids: string[]) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job || BUSY.includes(job.status)) return;
  const settings = await getImporterSettings();
  await runPostProcessing({ job, settings: { ...settings, aiEnabled: false }, examName: "", subjectName: null, stillRunning: async () => true }, new Set(ids));
}
