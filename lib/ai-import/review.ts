import "server-only";
import { missingSlots, rescanTarget, type MissingSlot, type PlacedQuestion, type RescanTarget } from "@/lib/ai-import/rescan-target";
import { ISSUE_DEFS } from "@/lib/ai-import/config";
import { AiImportAnswerStatus, AiImportJobStatus, AiImportPageStatus, AiImportQuestionStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logEvent, ImportJobError } from "@/lib/ai-import/jobs";
import { importBlocker, type ImportMode, type ImportPlan } from "@/lib/ai-import/adapter";
import { REVIEWABLE } from "@/lib/ai-import/post";
import { compareVersions, figureRows, mergeChoice, recordVersion, snapshotFigures, RESCAN_FIELDS, type FigureSnapshot, type RescanField } from "@/lib/ai-import/versions";
import { cropFromRender, storeOriginalFigure, FigureError, MIN_CROP_SIDE } from "@/lib/ai-import/figures";
import { normalizeBox } from "@/lib/ai-import/figure-map";
import { ensureRender } from "@/lib/ai-import/process";
import { exists as vaultExists } from "@/lib/ai-import/vault";
import { isPlaceholder, placeholderRow, type RescanRequest, type RescanView } from "@/lib/ai-import/process";
import { gapPages } from "@/lib/ai-import/reading-checks";
import type { SequenceAck } from "@/lib/ai-import/quality";
import { jobQuality, settleJobStatus } from "@/lib/ai-import/summary";
import { kickWorker } from "@/lib/ai-import/kick";
import { effective, runPostProcessing } from "@/lib/ai-import/post";
import { getImporterSettings } from "@/lib/ai-import/settings";
import { planOf } from "@/lib/ai-import/select";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { headingResolver, promoteExamples, quarantineProposals, rememberCorrection } from "@/lib/ai-import/taxonomy-memory";
import type { ExtractedQuestion } from "@/lib/ai-import/types";
import { MAX_VERIFY_PASSES, contentCurrent, contentPartOf, fingerprintsOf, passCount } from "@/lib/ai-import/verify-core";
import { importerBudgetBlock } from "@/lib/ai-import/ai";
import { learnFromCorrections } from "@/lib/ai-import/paper-learn";

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
  /** Instructions printed before the question / its shared passage (undefined = unchanged, "" = none). Both are part of the question text in the Question Bank. */
  instructions?: string | null;
  passage?: string | null;
  /** Explanation stored with the question (undefined = unchanged, "" = none). */
  explanation?: string | null;
  /** Source page reference (pages of the paper file the question is printed on). */
  pages?: number[];
  /**
   * Bilingual papers: the Hindi version as the administrator checked it against the page (undefined = unchanged).
   * Saving it confirms the Hindi reading; the structural pair checks still run on it.
   */
  hi?: { stem: string; options: { text: string }[] } | null;
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
  if (edit.hi !== undefined && edit.hi !== null && (typeof edit.hi.stem !== "string" || !Array.isArray(edit.hi.options) || edit.hi.options.some((o) => typeof o?.text !== "string"))) return [...errors, "The Hindi version is not valid."];
  if (edit.hi && !edit.hi.stem.trim()) errors.push("The Hindi question text cannot be empty.");
  if (edit.hi && edit.hi.options.length !== edit.options.length) errors.push(`The Hindi version needs the same number of options as the English version (${edit.options.length}).`);
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
  if ([edit.instructions, edit.passage].some((v) => v !== undefined && v !== null && typeof v !== "string")) errors.push("The instructions and passage must be text.");
  else if ((edit.instructions ?? "").length > 20_000 || (edit.passage ?? "").length > 20_000) errors.push("The instructions or passage are too long (20,000 characters each at most).");
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
  add("Instructions", before.instructions ?? "", after.instructions ?? "");
  add("Passage", before.passage ?? "", after.passage ?? "");
  add("Question text", before.stem, after.stem);
  const labels = [...new Set([...before.options.map((o) => o.label), ...after.options.map((o) => o.label)])].sort();
  for (const l of labels) add(`Option ${l}`, before.options.find((o) => o.label === l)?.text ?? "(none)", after.options.find((o) => o.label === l)?.text ?? "(none)");
  add("Explanation", before.hints?.explanation ?? "", after.hints?.explanation ?? "");
  add("Source pages", before.pages, after.pages);
  add("Match lists", [before.listI, before.listII], [after.listI, after.listII]);
  add("Hindi text", before.hi?.stem ?? "", after.hi?.stem ?? "");
  const hiCount = Math.max(before.hi?.options.length ?? 0, after.hi?.options.length ?? 0);
  for (let k = 0; k < hiCount; k++) add(`Hindi option ${String.fromCharCode(65 + k)}`, before.hi?.options[k]?.text ?? "(none)", after.hi?.options[k]?.text ?? "(none)");
  // Confirming an unchanged Hindi reading is a change of its review state.
  if (!before.hi?.confirmedById && after.hi?.confirmedById) out.push({ field: "Hindi confirmed", before: "no", after: "yes" });
  return out;
}

/** Saves an admin's correction as editedData (the extraction itself is never overwritten) and records what changed. */
export async function editQuestion(questionId: string, actorId: string, edit: QuestionEdit, opts: { note?: string } = {}) {
  const q = await editable(questionId);
  const base = effective(q);
  const figs = await prisma.aiImportFigure.findMany({ where: { questionId } });
  const figureOptions = new Set(figs.filter((f) => f.owner === "OPTION" && f.mappingStatus !== "MISSING" && f.optionLabel).map((f) => f.optionLabel!));
  const problems = await editProblems(q, base, edit, figureOptions);
  if (problems.length) throw new ImportJobError(`Not saved: ${problems.join(" ")}`);
  const number = edit.number === undefined ? base.number : edit.number;
  const explanation = edit.explanation === undefined ? base.hints?.explanation ?? null : edit.explanation?.trim() || null;
  const next: ExtractedQuestion = {
    ...base,
    number,
    label: number === null ? base.label : String(number),
    instructions: edit.instructions === undefined ? base.instructions ?? null : edit.instructions?.trim().slice(0, 20_000) || null,
    passage: edit.passage === undefined ? base.passage ?? null : edit.passage?.trim().slice(0, 20_000) || null,
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
    ...(edit.hi === undefined
      ? {}
      : {
          hi: edit.hi
            ? {
                stem: edit.hi.stem.trim().slice(0, 20_000),
                options: edit.hi.options.map((o, i) => ({ label: String.fromCharCode(65 + i), printed: base.hi?.options[i]?.printed ?? String(i + 1), text: o.text.trim().slice(0, 5_000) })),
                confidence: 1,
                unreadable: [],
                // The administrator compared the two columns: same order unless they left a different option count.
                sameOptionOrder: edit.hi.options.length === edit.options.length ? true : null,
                figuresDiffer: false,
                secondReadAgreement: null,
                confirmedById: actorId,
              }
            : null,
        }),
  };
  const changes = changedFields(base, next);
  if (!changes.length) throw new ImportJobError("Nothing changed — the question is exactly as before.");
  await prisma.$transaction([
    prisma.aiImportQuestion.update({ where: { id: q.id }, data: { editedData: next as unknown as Prisma.InputJsonValue, sourceLabel: next.label, pages: next.pages, reviewedById: actorId, reviewedAt: new Date(), ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED, questionType: next.type, optionCount: next.options.length, contentFormat: next.contentFormat } }),
    prisma.aiImportQuestionVersion.create({ data: { questionId: q.id, jobId: q.jobId, kind: "ADMIN_EDIT", data: base as unknown as Prisma.InputJsonValue, figures: snapshotFigures(figs) as unknown as Prisma.InputJsonValue, changes: changes as unknown as Prisma.InputJsonValue, actorId, note: `Changed: ${changes.map((c) => c.field).join(", ")}${opts.note ? ` — ${opts.note}` : ""}`.slice(0, 500) } }),
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
export const DECIDE_INDIVIDUALLY = ["VERIFY2_DISAGREES", "SUBJECT_MISMATCH", "REFERENCE_CONFLICT", "FORMULA_NEEDS_MANUAL_VERIFICATION"];
/**
 * An approval from a LIST row (Exceptions table, one-page list — the question is not opened) is refused for every
 * unresolved conflict: the individual decisions above, and open answer / subject-topic / section conflicts. Those are
 * decided on the question's own page.
 */
export const LIST_PROTECTED = [...DECIDE_INDIVIDUALLY, "ANSWER_MISMATCH", "ANSWER_AMBIGUOUS", "ANSWER_TYPE_CONFLICT", "ANSWER_KEY_PAPER_MISMATCH", "POSSIBLE_WITHDRAWN", "TAXONOMY_DISAGREES", "SECTION_SUBJECT_DIFFERS"];

export async function approveQuestions(ids: string[], actorId: string, opts: { from?: "list" } = {}): Promise<ApproveResult> {
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
    const unresolved = opts.from === "list" ? q.issueCodes.filter((c) => LIST_PROTECTED.includes(c)) : ids.length > 1 ? q.issueCodes.filter((c) => DECIDE_INDIVIDUALLY.includes(c)) : [];
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
  // The corrections just confirmed may establish a reusable paper-format rule (stored PROPOSED; never used unconfirmed).
  for (const j of jobIds) if (out.approved) await learnFromCorrections(j, actorId);
  // Proposed classification examples of the questions approved now become active (only when unchanged since proposed).
  if (done.length) {
    const rows = await prisma.aiImportQuestion.findMany({ where: { id: { in: done } }, select: { id: true, approvedById: true, subjectId: true, topicId: true, subTopicId: true, job: { select: { examId: true } } } });
    for (const examId of new Set(rows.map((r) => r.job.examId))) await promoteExamples(examId, rows.filter((r) => r.job.examId === examId), actorId);
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
    await learnFromCorrections(first.jobId, actorId);
    const job = await prisma.aiImportJob.findUnique({ where: { id: first.jobId }, select: { examId: true } });
    if (job) await quarantineProposals(job.examId, ids, actorId, `question rejected: ${(reason || "rejected by an administrator").slice(0, 120)}`);
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
  if (q.answerStatus === AiImportAnswerStatus.WITHDRAWN) throw new ImportJobError("The official answer key deleted this question: it is kept for the record and is never imported, so no answer can be set.");
  const e = effective(q);
  const clean = [...new Set(labels.map((l) => l.toUpperCase()))].filter((l) => e.options.some((o) => o.label === l));
  if (!clean.length) throw new ImportJobError("Choose at least one of the question's options.");
  if (q.questionType !== "MULTIPLE_CORRECT" && clean.length !== 1) throw new ImportJobError("A single-correct question has exactly one answer.");
  if (q.questionType === "MULTIPLE_CORRECT" && clean.length < 2) throw new ImportJobError("A multiple-correct question needs at least two answers.");
  await prisma.aiImportQuestion.update({ where: { id }, data: { finalAnswer: clean, answerConfirmedById: actorId, ...UNAPPROVE, status: AiImportQuestionStatus.EXTRACTED } });
  await adminCheck(id, "Answer set", `Answer ${clean.join(", ")} chosen by an administrator${q.officialAnswer.length ? ` (official key: ${q.officialAnswer.join(", ")})` : ""}.`);
  await logEvent(q.jobId, "ANSWER_SET", `Q${q.sourceLabel}: answer ${clean.join(", ")} set by an administrator`, { questionId: id }, actorId);
}

/** Taxonomy academic-review statuses an import question can be held under (never imported while set). */
export const ACADEMIC_REVIEW_STATUSES = ["AMBIGUOUS_PENDING_ACADEMIC_REVIEW", "UNMAPPED_PENDING_ACADEMIC_REVIEW"] as const;
export type AcademicReviewStatus = (typeof ACADEMIC_REVIEW_STATUSES)[number];

/**
 * Holds questions under taxonomy academic review (or clears it with null after the academic decision). While held,
 * importBlocker refuses them, so they never reach the Question Bank and can never be published. Recorded in the
 * question's checks, the job's events and the audit log. Extracted text and answers are not touched.
 */
export async function setAcademicReview(ids: string[], actorId: string, status: AcademicReviewStatus | null, note: string | null = null): Promise<number> {
  if (status !== null && !ACADEMIC_REVIEW_STATUSES.includes(status)) throw new ImportJobError("Unknown academic-review status.");
  let n = 0;
  for (const id of ids) {
    const q = await editable(id);
    // Setting a hold withdraws an approval; clearing one never touches approval fields (a held question was never
    // approvable, so its approval history stays exactly as recorded).
    const was = { status: q.academicReview, note: q.academicReviewNote };
    await prisma.aiImportQuestion.update({ where: { id }, data: { academicReview: status, academicReviewNote: status ? (note?.trim().slice(0, 500) || null) : null, ...(status ? UNAPPROVE : {}) } });
    await adminCheck(id, status ? "Academic review pending" : "Academic review cleared", status ? `${status}${note ? `: ${note.trim().slice(0, 200)}` : ""}` : `Taxonomy academic review (${was.status ?? "none"}) cleared by an administrator${note?.trim() ? `: ${note.trim().slice(0, 200)}` : ""}.`);
    await logEvent(q.jobId, status ? "ACADEMIC_REVIEW_SET" : "ACADEMIC_REVIEW_CLEARED", `Q${q.sourceLabel}: ${status ?? `academic review cleared (was ${was.status ?? "none"})${note?.trim() ? ` — ${note.trim().slice(0, 200)}` : ""}`}`, { questionId: id, status, previous: was, note: note?.trim() || null }, actorId);
    n++;
  }
  if (n) await prisma.auditLog.create({ data: { actorId, action: status ? "AI_IMPORT_ACADEMIC_REVIEW_SET" : "AI_IMPORT_ACADEMIC_REVIEW_CLEARED", entityType: "AiImportQuestion", entityId: null, metadata: { ids, status, note } } });
  return n;
}

/**
 * An administrator's explicit academic decision on ONE held question: the subject / topic now stored is accepted and
 * the hold is cleared. Never called automatically; refused when nothing is held or no subject is set (an unmapped
 * question needs a subject chosen first). Approval is not given here — the question is approved separately.
 */
export async function clearAcademicReview(id: string, actorId: string, note: string): Promise<void> {
  const q = await editable(id);
  if (!q.academicReview) throw new ImportJobError("This question has no academic-review hold.");
  if (!q.subjectId) throw new ImportJobError("Choose the subject (and topic) first: a hold is cleared only for a mapping you have decided.");
  if (!note.trim()) throw new ImportJobError("Write a short reason for the academic decision; it is kept in the audit history.");
  await setAcademicReview([id], actorId, null, note);
}

/**
 * Marks import questions to be kept out of automatically generated practice once imported (historical current
 * affairs, 2026-11-11) — carried to Question.excludeFromPractice by the import. Approval is not withdrawn: it does not
 * change what the question says or its answer.
 */
export async function setPracticeExclusion(ids: string[], actorId: string, exclude: boolean, reason: string | null = null): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const q = await editable(id);
    await prisma.aiImportQuestion.update({ where: { id }, data: { excludeFromPractice: exclude, excludeFromPracticeReason: exclude ? (reason?.trim().slice(0, 300) || null) : null } });
    await logEvent(q.jobId, "PRACTICE_EXCLUSION_SET", `Q${q.sourceLabel}: ${exclude ? "kept out of automatic practice" : "included in automatic practice"}${exclude && reason ? ` (${reason.trim().slice(0, 120)})` : ""}`, { questionId: id, exclude }, actorId);
    n++;
  }
  if (n) await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_PRACTICE_EXCLUSION_SET", entityType: "AiImportQuestion", entityId: null, metadata: { ids, exclude, reason } } });
  return n;
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
  // "Remember" stores a PROPOSED example only; it becomes active when this question is approved with this classification.
  const remembered = opts.remember === true ? await rememberCorrection({ examId: q.job.examId, jobId: q.jobId, questionId: id, e: effective(q), subjectId, topicId, subTopicId: subTopicId ?? null, actorId, bulk: !!opts.bulk, evidence: { sourceNumber: q.sourceNumber, pages: q.pages, previous: { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, source: q.taxonomySource, confidence: q.taxonomyConfidence } } }) : false;
  await adminCheck(id, "Topic set", `${subject.name} › ${topic ? topic.name : "no topic"}${subTopic ? ` › ${subTopic.name}` : ""}${opts.bulk ? " (bulk correction)" : ""}${remembered ? " — proposed as an example for this exam (used only after this question is approved)" : ""}`);
  await logEvent(q.jobId, "TAXONOMY_SET", `Q${q.sourceLabel}: ${subject.name} › ${topic?.name ?? "no topic"}${subTopic ? ` › ${subTopic.name}` : ""}${opts.bulk ? " (bulk)" : ""}${remembered ? " — proposed as an example for this exam (used only after this question is approved)" : ""}`, { questionId: id, from: { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, source: q.taxonomySource }, to: { subjectId, topicId, subTopicId }, remembered, bulk: !!opts.bulk }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: opts.bulk ? "AI_IMPORT_TAXONOMY_BULK_SET" : "AI_IMPORT_TAXONOMY_SET", entityType: "AiImportQuestion", entityId: id, metadata: { jobId: q.jobId, from: { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, source: q.taxonomySource }, to: { subjectId, topicId, subTopicId: subTopicId ?? null }, remembered } } });
  return { remembered };
}

/**
 * "Keep current" on a subject / topic suggestion: the administrator confirms the stored classification as their own
 * decision (taxonomySource "admin"), so no suggestion is offered over it again. Content is unchanged, so an approval
 * stays; the stored ids are validated against the exam's own taxonomy first.
 */
export async function keepTaxonomy(id: string, actorId: string): Promise<void> {
  const q = await editable(id);
  if (!q.subjectId) throw new ImportJobError("This question has no subject yet — choose one (there is nothing to keep).");
  const tax = await getExamTaxonomy(prisma, q.job.examId);
  const subject = tax.find((s) => s.id === q.subjectId);
  const topic = q.topicId ? subject?.topics.find((t) => t.id === q.topicId) : null;
  if (!subject || (q.topicId && !topic) || (q.subTopicId && !topic?.subTopics.some((st) => st.id === q.subTopicId))) throw new ImportJobError("The stored subject / topic is not part of this exam's taxonomy any more — choose it again.");
  await prisma.aiImportQuestion.update({ where: { id }, data: { taxonomySource: "admin", taxonomyConfidence: 1 } });
  await adminCheck(id, "Classification kept", `${subject.name} › ${topic?.name ?? "no topic"} kept by an administrator (the suggestion was not used).`);
  await logEvent(q.jobId, "TAXONOMY_KEPT", `Q${q.sourceLabel}: ${subject.name} › ${topic?.name ?? "no topic"} kept (suggestion not used)`, { questionId: id, kept: { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId }, previousSource: q.taxonomySource }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_TAXONOMY_KEPT", entityType: "AiImportQuestion", entityId: id, metadata: { jobId: q.jobId, kept: { subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId }, previousSource: q.taxonomySource } } });
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
export async function rescanQuestions(ids: string[], scope: RescanScope, actorId: string): Promise<{ pages: number; questions: number; reads: string[] }> {
  const qs = await prisma.aiImportQuestion.findMany({ where: { id: { in: ids } }, select: { id: true, jobId: true, fileId: true, pages: true, status: true, sourceKey: true, sourceLabel: true, data: true, editedData: true } });
  if (!qs.length) throw new ImportJobError("Select the questions to re-scan.");
  const jobId = qs[0].jobId;
  if (qs.some((q) => q.jobId !== jobId)) throw new ImportJobError("Re-scan questions of one import at a time.");
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.QUEUED) throw new ImportJobError("The import is running right now. Re-scan when it has finished.");
  if (job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("This import was cancelled.");
  if (!job.confirmedAt) throw new ImportJobError("This import was never processed, so there is nothing to re-scan.");
  const settings = await getImporterSettings();
  if (!settings.aiEnabled) throw new ImportJobError("Re-scanning reads the original page again with AI, and paid AI is switched off in Import Settings. Nothing was changed — correct the question by hand, or switch paid AI on first.");
  const plan = planOf(job.config);
  if (!plan?.tasks.extract.model) throw new ImportJobError("This import's confirmed model plan has no page-reading model, so its pages cannot be read again. Nothing was changed — use Reconfigure Models, or correct the question by hand.");
  // Budget preflight: a request the importer budget cannot pay for is refused here, before anything is queued (no
  // stored request, no pass used). One page = the plan's worst case for a page read plus its independent read.
  const perPage = (plan.tasks.extract.maxInr ?? 0) + (plan.tasks.verify?.model ? (plan.tasks.verify.maxInr ?? 0) : 0);
  const blocked = await importerBudgetBlock(jobId, settings, { beforeConfirmation: true, amountInr: perPage });
  if (blocked) throw new ImportJobError(`Re-scan not started: ${blocked.message} Nothing was queued and no verification pass was used.`);
  const open = qs.filter((q) => !LOCKED.includes(q.status));
  if (!open.length) throw new ImportJobError("These questions are already in the Question Bank — edit them there.");
  // A re-scan is a paid verification pass: a question that already had MAX_VERIFY_PASSES is decided by hand.
  const atLimit = open.filter((q) => passCount((q.data as unknown as ExtractedQuestion).paperVerify) >= MAX_VERIFY_PASSES);
  if (atLimit.length) throw new ImportJobError(`${atLimit.slice(0, 8).map((q) => `Q${q.sourceLabel}`).join(", ")}${atLimit.length > 8 ? " …" : ""} already had ${MAX_VERIFY_PASSES} verification passes (Verify 1, Verify 2, re-scan). Nothing was sent — decide ${atLimit.length === 1 ? "it" : "them"} by hand.`);
  const files = await prisma.aiImportFile.findMany({ where: { id: { in: [...new Set(open.map((q) => q.fileId))] } } });
  for (const f of files) {
    const kind = (f.detected as { kind?: string } | null)?.kind;
    if (kind === "docx" || kind === "xlsx" || kind === "csv") throw new ImportJobError(`${f.originalName} is a ${kind.toUpperCase()} file, read exactly (no AI): re-scanning would give the same result. Correct the question by hand.`);
    if (f.status === "PURGED" || !f.storageKey || !(await vaultExists(f.storageKey))) throw new ImportJobError(`The original file ${f.originalName} is no longer stored (removed after its retention period), so its pages cannot be re-scanned. Nothing was changed — correct the question by hand.`);
  }
  // Where each question is read (lib/ai-import/rescan-target.ts): its own band, a band stacked with its continuation
  // page, or — when its position is not stored — its whole page. Other questions of the paper are never saved from it.
  const placed = new Map<string, PlacedQuestion[]>();
  for (const fileId of new Set(open.map((q) => q.fileId))) {
    const rows = await prisma.aiImportQuestion.findMany({ where: { fileId, status: { not: AiImportQuestionStatus.REJECTED } }, select: { id: true, pages: true, data: true, editedData: true } });
    placed.set(fileId, rows.map((r) => {
      const d = (r.editedData ?? r.data) as unknown as ExtractedQuestion;
      return { id: r.id, section: d.section ?? "", number: d.number ?? null, pages: r.pages, region: d.region ?? null };
    }));
  }
  const targets = new Map<string, RescanTarget>();
  for (const q of open) {
    if (!q.pages.length) throw new ImportJobError(`Q${q.sourceLabel} has no source page recorded. Set its source page (Edit) first.`);
    const d = (q.editedData ?? q.data) as unknown as ExtractedQuestion;
    const missing = isPlaceholder(d);
    const others = (placed.get(q.fileId) ?? []).filter((o) => (o as { id?: string }).id !== q.id);
    targets.set(q.id, scope === "page" ? { kind: "PAGES", pages: q.pages, why: "whole page requested" } : rescanTarget({ section: d.section ?? "", number: d.number ?? null, pages: q.pages, region: missing ? null : d.region ?? null }, others, missing));
  }
  const byPage = new Map<string, { fileId: string; page: number; keys: Set<string>; views: RescanView[] }>();
  const reads: string[] = [];
  for (const q of open) {
    const t = targets.get(q.id)!;
    // A STACK is read once, from its first page (the continuation page is part of the same image).
    const readPages = t.kind === "STACK" ? [t.pages[0]] : t.kind === "REGION" ? [t.page] : t.pages;
    for (const p of readPages) {
      const k = `${q.fileId}|${p}`;
      const e = byPage.get(k) ?? { fileId: q.fileId, page: p, keys: new Set<string>(), views: [] };
      e.keys.add(q.sourceKey);
      if (t.kind === "REGION") e.views.push({ kind: "REGION", box: t.box });
      else if (t.kind === "STACK") e.views.push({ kind: "STACK", pages: t.pages, boxes: t.boxes });
      else e.views.push({ kind: "PAGE" });
      byPage.set(k, e);
    }
    reads.push(`Q${q.sourceLabel}: ${t.kind === "REGION" ? `only its part of page ${t.page} (${t.why})` : t.kind === "STACK" ? `pages ${t.pages.join(" + ")} together (${t.why})` : `whole page ${t.pages.join(", ")} — ${t.why}`}`);
  }
  const now = new Date().toISOString();
  let pages = 0;
  for (const e of byPage.values()) {
    const page = await prisma.aiImportPage.findUnique({ where: { fileId_pageNumber: { fileId: e.fileId, pageNumber: e.page } } });
    if (!page || page.kind === "BLANK" || page.kind === "DOCUMENT") continue;
    const raw = (page.rawOutput as Record<string, unknown> | null) ?? {};
    const prev = raw.rescan as RescanRequest | undefined;
    const keys = scope === "page" || (prev && prev.keys === null) ? null : [...new Set([...(prev?.keys ?? []), ...e.keys])];
    // A cut-out only when it is the page's single request; several questions of one page (or an earlier request still
    // waiting) read the whole page, filtered by the keys.
    const view: RescanView = keys && keys.length === 1 && e.views.length === 1 && !prev ? e.views[0] : { kind: "PAGE" };
    if (view.kind === "PAGE" && e.views.some((v) => v.kind !== "PAGE")) reads.push(`Page ${e.page}: several questions are read from it, so the whole page is read (only the selected questions are saved).`);
    await prisma.aiImportPage.update({ where: { id: page.id }, data: { status: AiImportPageStatus.PENDING, errorMessage: null, rawOutput: { ...raw, rescan: { keys, requestedById: actorId, requestedAt: now, view } } as Prisma.InputJsonValue } });
    pages++;
  }
  if (!pages) throw new ImportJobError("No readable source page was found for these questions.");
  const r = await prisma.aiImportJob.updateMany({ where: { id: jobId, status: job.status }, data: { status: AiImportJobStatus.QUEUED, finishedAt: null, errorMessage: null } });
  if (!r.count) throw new ImportJobError("The import changed state at the same moment. Refresh and try again.", 409);
  // No pass is used by the request: the worker counts one when a reading of the question is saved as a candidate
  // (lib/ai-import/process.ts saveQuestion), once per request, with the model that actually read it.
  await logEvent(jobId, "RESCAN_REQUESTED", `Re-scan requested: ${scope === "page" ? `${pages} whole page(s)` : `${open.length} question(s) on ${pages} page(s)`} are read again from the original file. Manual corrections are kept; new results you have to choose from appear on each question.`, { scope, questionIds: open.map((q) => q.id), pages }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: "AI_IMPORT_RESCAN_REQUESTED", entityType: "AiImportJob", entityId: jobId, metadata: { scope, questionIds: open.map((q) => q.id) } } });
  kickWorker();
  return { pages, questions: open.length, reads };
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
  if (!diffs.length) {
    // Nothing that differs was taken: the question (and its approval) stays exactly as it is.
    await prisma.aiImportQuestionVersion.update({ where: { id: v.id }, data: { status: "APPLIED", decidedAt: new Date(), decidedById: actorId, note: "Saved with no change: the current question was kept." } });
    await prisma.aiImportQuestion.update({ where: { id: q.id }, data: { status: AiImportQuestionStatus.EXTRACTED } });
    await adminCheck(q.id, "Re-scan decided", "Kept the current question; no field of the re-scan was taken.");
    await logEvent(q.jobId, "RESCAN_APPLIED", `Q${q.sourceLabel}: re-scan result not used (no field taken)`, { questionId: q.id, versionId, fields: [] }, actorId);
    return;
  }
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
  const qs = await prisma.aiImportQuestion.findMany({ where: { id: { in: ids } }, select: { id: true, jobId: true, status: true, taxonomySource: true, approvedById: true, subjectId: true, topicId: true, subTopicId: true, data: true, editedData: true } });
  if (!qs.length) throw new ImportJobError("Select the questions to re-classify.");
  const jobId = qs[0].jobId;
  const job = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.QUEUED || job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("The import is running or cancelled. Try again when it has finished.");
  const settings = await getImporterSettings();
  // The free local classifier always runs; the AI classifier only for what it cannot settle, when paid AI is on and the
  // import's model plan has a classification model.
  const aiToo = settings.aiEnabled && !!planOf(job.config)?.tasks.classify.model;
  // Settled decisions are never re-opened (importer-reliability-2 — two re-classify runs flipped subjects back and
  // forth): an administrator's choice, an approved question, and a subject / topic a check already AGREED with.
  const agreed = (q: (typeof qs)[number]) => {
    const pv = (q.data as unknown as ExtractedQuestion).paperVerify;
    const same = (c: { status: string; stored: { subjectId: string | null; topicId: string | null; subTopicId: string | null } } | null | undefined) => c?.status === "AGREED" && c.stored.subjectId === q.subjectId && c.stored.topicId === q.topicId && c.stored.subTopicId === q.subTopicId;
    return !!q.topicId && (same(pv?.v2?.classification) || same(pv?.v1?.classification));
  };
  const target = qs.filter((q) => !LOCKED.includes(q.status) && !q.taxonomySource?.startsWith("admin") && !q.approvedById && !agreed(q));
  if (!target.length) throw new ImportJobError("Every selected question is settled — chosen by an administrator, approved, already stored, or its subject / topic was confirmed by a check; nothing to re-classify.");
  // An AI-chosen subject is cleared too (a wrong subject would otherwise survive and block every correct topic);
  // a subject from the paper itself (selected subject, printed section heading / column) is kept.
  // A subject the paper's printed section heading names is kept whoever filled it first.
  const resolveHeading = job.paperType === "SINGLE_SUBJECT" ? null : await headingResolver(job.examId);
  const printedSubject = (q: (typeof qs)[number]) => !!q.subjectId && resolveHeading?.(effective(q).hints?.subject)?.subjectId === q.subjectId;
  const aiChosen = target.filter((q) => (!q.taxonomySource || q.taxonomySource.startsWith("AI") || q.taxonomySource === "local classifier" || q.taxonomySource === "confirmed example") && !printedSubject(q)).map((q) => q.id);
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
  if (!quality.missing.length && !quality.countDifference && !quality.expectedConflict && quality.expected !== null) throw new ImportJobError("There is no count difference, missing number, expected-count conflict or unknown expected count to acknowledge.");
  const expect = { missing: quality.missing, expected: quality.expected, counted: quality.counted };
  const ack: SequenceAck = { byId: actorId, at: new Date().toISOString(), note: note.trim().slice(0, 500), missing: expect.missing.slice(0, 1000), expected: expect.expected, counted: expect.counted, conflict: quality.expectedConflict };
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

/** Placeholder rows for the review list: reliably missing numbers of each question paper, with their predicted page(s). */
export async function missingQuestionRows(jobId: string): Promise<{ slots: (MissingSlot & { fileName: string })[]; notes: string[] }> {
  const files = await prisma.aiImportFile.findMany({ where: { jobId, role: "PAPER" }, select: { id: true, originalName: true, pageCount: true } });
  if (!files.length) return { slots: [], notes: [] };
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId }, select: { fileId: true, pages: true, status: true, data: true, editedData: true } });
  const quality = await jobQuality(jobId);
  const { slots, notes } = missingSlots(
    rows.map((r) => {
      const e = (r.editedData ?? r.data) as unknown as ExtractedQuestion;
      return { fileId: r.fileId, section: e.section ?? "", number: e.number ?? null, pages: r.pages, status: r.status };
    }),
    quality?.expected ?? null,
    new Map(files.map((f) => [f.id, f.pageCount ?? 0])),
    gapPages,
  );
  const name = new Map(files.map((f) => [f.id, f.originalName]));
  return { slots: slots.map((s) => ({ ...s, fileName: name.get(s.fileId) ?? "" })), notes };
}

/**
 * "Re-scan" on a missing-question row: an empty placeholder is created at the printed number and predicted page(s),
 * and only that question is read again from the original file (its band between the neighbouring questions when their
 * positions are stored). The reading waits as a candidate on the placeholder until an administrator saves it. Refused —
 * nothing created — when the page cannot be established or the re-scan cannot run.
 */
export async function rescanMissingQuestion(input: { jobId: string; fileId: string; section: string; number: number; actorId: string }): Promise<{ questionId: string; reads: string[] }> {
  const { slots } = await missingQuestionRows(input.jobId);
  const slot = slots.find((s) => s.fileId === input.fileId && s.section === input.section && s.number === input.number);
  if (!slot) throw new ImportJobError(`Q${input.number} is not a missing number of this paper (it may have been added or found meanwhile). Refresh the list.`);
  if (!slot.pages.length) throw new ImportJobError(`The page of ${slot.label} could not be established from its neighbouring questions. Nothing was changed — add it by hand with its page (Quality panel → Add a missing question), then re-scan it.`);
  const job = await prisma.aiImportJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  if (BUSY.includes(job.status) || job.status === AiImportJobStatus.QUEUED || job.status === AiImportJobStatus.CANCELLED) throw new ImportJobError("The import is running or cancelled.");
  const key = `${slot.section}#${slot.number}`;
  const after = await prisma.aiImportQuestion.findFirst({ where: { fileId: slot.fileId, sourceNumber: { lt: slot.number } }, orderBy: { orderIndex: "desc" }, select: { orderIndex: true } });
  const row = await prisma.aiImportQuestion.create({ data: placeholderRow(job.id, slot.fileId, key, { section: slot.section, number: slot.number, label: String(slot.number), pages: slot.pages }, after?.orderIndex ?? 0) });
  try {
    const r = await rescanQuestions([row.id], "question", input.actorId);
    await logEvent(job.id, "QUESTION_ADDED", `Missing question ${slot.label} (page ${slot.pages.join(" / ")}) added as a placeholder for a re-scan`, { questionId: row.id }, input.actorId);
    return { questionId: row.id, reads: r.reads };
  } catch (e) {
    // The re-scan could not be queued: the empty placeholder is removed again (nothing else was touched).
    await prisma.aiImportQuestion.deleteMany({ where: { id: row.id, editedData: { equals: Prisma.DbNull }, versions: { none: {} } } });
    throw e;
  }
}

/** Refuses publishing while the paper is incomplete (QualityReport.publishBlocker); the refusal is logged. */
export async function assertPaperPublishable(jobId: string, actorId: string, mode: string): Promise<void> {
  const quality = await jobQuality(jobId);
  if (!quality?.publishBlocker) return;
  await logEvent(jobId, "PUBLISH_BLOCKED_INCOMPLETE", `Publish refused: ${quality.publishBlocker}`, { mode, expected: quality.expected, counted: quality.counted, missing: quality.missing.slice(0, 50), expectedFrom: quality.expectedFrom }, actorId);
  throw new ImportJobError(`Not published: ${quality.publishBlocker}`);
}

/** Admin chooses how to import: draft only, or import and publish (all eligible / selected). */
export async function requestImport(jobId: string, actorId: string, mode: ImportMode, questionIds: string[] | null) {
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ImportJobError("Import job not found.", 404);
  const allowed: AiImportJobStatus[] = [AiImportJobStatus.NEEDS_REVIEW, AiImportJobStatus.COMPLETED_WITH_ISSUES, AiImportJobStatus.COMPLETED];
  if (!allowed.includes(job.status)) throw new ImportJobError("Questions can be imported once processing has finished.");
  if (mode === "PUBLISH_SELECTED" && !questionIds?.length) throw new ImportJobError("Select the questions to publish.");
  // Completeness gate (owner Sprint A item 6, 2026-11-06): nothing of a paper is published while its question count is
  // unconfirmed or contradicted by a printed total, questions are missing without an acknowledged reason, or pages were
  // not read. Adding questions as Draft stays possible; the decision is the administrator's, never silent.
  if (mode !== "DRAFT") await assertPaperPublishable(jobId, actorId, mode);
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

/**
 * "Confirm text-only, no image needed": an administrator decides that a question whose text points at a figure needs
 * none (2026-10-25: "Unusual bulge on chest X-ray"). Kept on the extraction with the content it was decided on — any
 * later change of the wording lapses it. Refused when an embedded image of the question failed to extract (that image
 * exists and must be restored, cropped or confirmed). `confirm = false` withdraws the decision.
 */
export async function confirmTextOnly(questionId: string, actorId: string, confirm = true): Promise<void> {
  const q = await editable(questionId);
  const figures = await prisma.aiImportFigure.findMany({ where: { questionId } });
  if (confirm && figures.some((f) => f.mappingStatus === "MISSING")) throw new ImportJobError("An image of this question failed to extract from the source — restore or crop it; it cannot be confirmed as text-only.");
  if (confirm && figures.some((f) => f.owner !== "UNASSIGNED")) throw new ImportJobError("This question has images; remove them first if it really is text-only.");
  const d = q.data as unknown as ExtractedQuestion;
  const decision = confirm ? { textOnly: true as const, byId: actorId, at: new Date().toISOString(), content: contentPartOf(effective(q)) } : null;
  await prisma.aiImportQuestion.update({ where: { id: questionId }, data: { data: { ...d, imageDecision: decision } as unknown as Prisma.InputJsonValue } });
  await adminCheck(questionId, confirm ? "Text-only confirmed" : "Text-only withdrawn", confirm ? "An administrator confirmed that this question needs no image." : "The text-only decision was withdrawn.");
  await logEvent(q.jobId, confirm ? "TEXT_ONLY_CONFIRMED" : "TEXT_ONLY_WITHDRAWN", `Q${q.sourceLabel}: ${confirm ? "confirmed as text-only (no image needed)" : "text-only decision withdrawn"} by an administrator.`, { questionId }, actorId);
  await prisma.auditLog.create({ data: { actorId, action: confirm ? "AI_IMPORT_TEXT_ONLY_CONFIRMED" : "AI_IMPORT_TEXT_ONLY_WITHDRAWN", entityType: "AiImportQuestion", entityId: questionId, metadata: { jobId: q.jobId } } });
  await revalidateQuestions(q.jobId, [questionId]);
}

/**
 * The administrator takes ONE field suggestion of a current Verify 1 / Verify 2 result (question text or one option) —
 * through the normal correction (editQuestion: the extraction is kept, the change is in the history, the approval is
 * withdrawn). Answers, subjects and topics are never taken this way (they have their own controls), and a suggestion
 * of an out-of-date result (the question changed since) is refused.
 */
export async function applyVerifySuggestion(questionId: string, actorId: string, field: string, by: "V1" | "V2") {
  if (!/^(text|option [A-D])$/.test(field)) throw new ImportJobError("Only a question-text or option suggestion can be applied here — set answers, subjects and topics with their own controls.");
  const q = await editable(questionId);
  const figures = await prisma.aiImportFigure.findMany({ where: { questionId } });
  const e = effective(q);
  const fp = fingerprintsOf({ e, finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures });
  const pv = (q.data as unknown as ExtractedQuestion).paperVerify;
  const result = by === "V2" ? pv?.v2 : pv?.v1;
  if (!result || !contentCurrent(result, fp)) throw new ImportJobError("That verification result is out of date (the question changed since) — run the verification again.");
  const check = (result.fieldChecks ?? []).find((c) => c.field === field && c.status === "PROBLEM" && c.suggestion);
  if (!check?.suggestion) throw new ImportJobError("There is no suggestion for that field.");
  const label = field.startsWith("option ") ? field.slice(7) : null;
  if (label && !e.options.some((o) => o.label === label)) throw new ImportJobError(`The question has no option ${label}.`);
  const edit: QuestionEdit = { stem: label ? e.stem : check.suggestion, options: e.options.map((o) => ({ label: o.label, text: o.label === label ? check.suggestion! : o.text })), type: e.type, contentFormat: e.contentFormat, listI: e.listI ?? null, listII: e.listII ?? null };
  await editQuestion(questionId, actorId, edit, { note: `accepted Verify ${by === "V2" ? 2 : 1} suggestion for ${field} (${(check.evidence ?? "").slice(0, 160)})` });
}
