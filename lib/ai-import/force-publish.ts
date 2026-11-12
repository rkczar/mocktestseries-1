import "server-only";
import crypto from "node:crypto";
import { AiImportAnswerStatus, AiImportJobStatus, AiImportQuestionStatus, QuestionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ImportJobError, logEvent } from "@/lib/ai-import/jobs";
import { answerVerified, importBlocker, importForced, matchListProblem, publishBlocker, type ForceKind } from "@/lib/ai-import/adapter";
import { verifyState, fingerprintsOf } from "@/lib/ai-import/verify-core";
import { ISSUE_DEFS, issueLabel } from "@/lib/ai-import/config";
import { CHECK_NAMES, CHECK_STATUS_LABELS, approvalOutdatedBy } from "@/lib/ai-import/checks";
import { effective } from "@/lib/ai-import/post";
import { getImporterSettings } from "@/lib/ai-import/settings";
import type { ExtractedQuestion } from "@/lib/ai-import/types";

/**
 * FORCE TO PUBLISH (owner requirement, 2026-11-12): an authorized Master Admin's explicit, confirmed instruction to put ONE
 * importer question into the Question Bank as PUBLISHED past every normal academic / validation blocker (bilingual
 * mismatch, Needs correction, formula flags, academic holds, stale verification, missing approval, duplicate warning…).
 * Nothing about the content is rewritten: the stored text, Hindi, options, key, explanation and images are published
 * as they are, and every bypassed blocker is written to an immutable audit record. Only a genuine technical limit can
 * stop it (no stored answer key, not four options, a storage / database failure) and is reported as exactly that.
 *
 * WITHDRAWN does the same for a question the official answer key withdrew: it is added to its Previous Year Paper as
 * QuestionStatus.WITHDRAWN (shown in place with a WITHDRAWN label, never answerable, never scored).
 *
 * Never run automatically: only the Master Admin action calls this.
 */
export interface ForceResult {
  kind: ForceKind;
  importQuestionId: string;
  questionId: string;
  code: string;
  status: "PUBLISHED" | "WITHDRAWN";
  previousStatus: string;
  bypassed: string[];
  alreadyDone: boolean;
}

/** Every normal gate this question fails right now, in words — what FORCE TO PUBLISH bypasses (recorded, never hidden). */
export function bypassedBlockers(q: Parameters<typeof importBlocker>[0], settings: Parameters<typeof importBlocker>[1]): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s && !out.includes(s)) out.push(s);
  };
  add(q.questionId ? null : importBlocker(q, settings));
  add(publishBlocker(q, settings));
  if (q.status !== AiImportQuestionStatus.READY && q.status !== AiImportQuestionStatus.IMPORTED && q.status !== AiImportQuestionStatus.PUBLISHED) add(`status ${q.status}`);
  if (!q.approvedById) add("not approved");
  if (q.academicReview) add(`academic hold ${q.academicReview}`);
  if (q.answerStatus === AiImportAnswerStatus.WITHDRAWN) add("withdrawn in the official answer key");
  else if (q.answerStatus !== AiImportAnswerStatus.OFFICIAL_MATCHED) add(`answer status ${q.answerStatus}`);
  for (const c of q.issueCodes) add(`${c}${ISSUE_DEFS[c] ? ` (${issueLabel(c)})` : ""}`);
  const checks = (q.data as unknown as ExtractedQuestion).checks ?? null;
  if (checks) for (const k of ["content", "answer", "taxonomy", "independent"] as const) if (checks[k]?.required && checks[k].status !== "PASSED") add(`${CHECK_NAMES[k]}: ${CHECK_STATUS_LABELS[checks[k].status].toLowerCase()}${checks[k].detail ? ` — ${checks[k].detail}` : ""}`.slice(0, 400));
  // importBlocker stops at its first reason: the later gates are evaluated on their own so none is left out of the audit.
  const e = effective(q);
  if (q.approvedById) add(approvalOutdatedBy(q.approvedAt, verifyState(q.data, fingerprintsOf({ e, finalAnswer: q.finalAnswer, subjectId: q.subjectId, topicId: q.topicId, subTopicId: q.subTopicId, figures: q.figures }))));
  if (!answerVerified(q)) add(q.finalAnswer.length ? "answer not verified (official key or an administrator's confirmation needed)" : "no answer");
  if (!q.subjectId) add("no subject");
  if (q.questionType === "MATCH_THE_FOLLOWING") add(!e.listI?.length || !e.listII?.length ? "match question without List I / List II" : matchListProblem(e.listI, e.listII));
  if (e.options.length !== 4) add(`${e.options.length} option(s) instead of 4`);
  return out;
}

/** What the Question Bank stores differently from the importer's fields (recorded; nothing is invented). */
function adaptations(q: Parameters<typeof importBlocker>[0], kind: ForceKind): string[] {
  const e = effective(q);
  const out: string[] = [];
  if (q.questionType === "MATCH_THE_FOLLOWING" && (!e.listI?.length || !e.listII?.length || matchListProblem(e.listI, e.listII))) out.push("Match question stored as single-correct: its List I / List II cannot be stored without keys; the list text is kept in the question text");
  if (e.instructions?.trim() || e.passage?.trim()) out.push("instructions / passage placed before the question text (normal import layout)");
  if (kind === "WITHDRAWN") out.push("no correct option stored (withdrawn in the official answer key)");
  return out;
}

const FORCE_LEASE_MS = 10 * 60_000;
const RUNNING: AiImportJobStatus[] = [AiImportJobStatus.QUEUED, AiImportJobStatus.PROCESSING, AiImportJobStatus.IMPORTING, AiImportJobStatus.ANALYZING];

export async function forceImportQuestion(input: { importQuestionId: string; actorId: string; reason: string; kind: ForceKind; confirmed: boolean }): Promise<ForceResult> {
  const { importQuestionId, actorId, kind } = input;
  const reason = (input.reason ?? "").trim().slice(0, 1000);
  if (input.confirmed !== true) throw new ImportJobError("Confirm the action first (tick the confirmation).");
  if (reason.length < 5) throw new ImportJobError("Write the reason for the audit trail (at least 5 characters).");
  // Server-side authorization, re-read from the database on every call (the session role is checked by the action too).
  const admin = await prisma.adminUser.findUnique({ where: { id: actorId }, select: { isActive: true, role: { select: { name: true } } } });
  if (!admin?.isActive || admin.role.name !== "MASTER_ADMIN") throw new ImportJobError("Only an active Master Admin can use FORCE TO PUBLISH.", 403);

  const q = await prisma.aiImportQuestion.findUnique({ where: { id: importQuestionId }, include: { figures: true, job: true } });
  if (!q) throw new ImportJobError("Question not found.", 404);
  if (RUNNING.includes(q.job.status)) throw new ImportJobError(`Technical: the import is ${q.job.status.toLowerCase()} — wait until it has finished, then try again (two writers on one question are never allowed).`, 409);
  if (q.status === AiImportQuestionStatus.REJECTED) throw new ImportJobError("Technical: this row was rejected as an extraction artifact (not an original question). Restore it first if it is a real question.", 409);
  if (kind === "WITHDRAWN" && q.answerStatus !== AiImportAnswerStatus.WITHDRAWN) throw new ImportJobError("Add as WITHDRAWN is only for a question the official answer key withdrew. Use FORCE TO PUBLISH for any other question.", 409);
  if (kind === "WITHDRAWN" && !q.job.previousYearPaperId) throw new ImportJobError("Add as WITHDRAWN needs the import linked to its Previous Year Paper (a withdrawn question is only ever shown inside its paper).", 409);
  // A question already in the Question Bank is never re-stated from here: the only accepted repeat is the same action
  // again (idempotent). Anything else (e.g. publishing a question added as WITHDRAWN, which has no correct option, or
  // withdrawing a published one that sits in tests) goes through the Question Bank's own rules.
  if (q.questionId) {
    const existing = await prisma.question.findUnique({ where: { id: q.questionId }, select: { status: true, code: true } });
    const target0 = kind === "PUBLISH" ? QuestionStatus.PUBLISHED : QuestionStatus.WITHDRAWN;
    if (existing?.status === target0) return { kind, importQuestionId: q.id, questionId: q.questionId, code: existing.code, status: target0, previousStatus: q.status, bypassed: [], alreadyDone: true };
    throw new ImportJobError(`This question is already in the Question Bank${existing ? ` (${existing.code}, ${existing.status.toLowerCase()})` : ""}; change it there.`, 409);
  }

  const settings = await getImporterSettings();
  const bypassed = bypassedBlockers(q, settings);
  const previousStatus = q.status;
  const target = kind === "PUBLISH" ? QuestionStatus.PUBLISHED : QuestionStatus.WITHDRAWN;

  const adapted = adaptations(q, kind);
  const alreadyDone = false;
  // The job's worker lease is held for the forced import: the importer worker (and a second forced click) cannot
  // touch this job until it is released, and the status is re-checked in the same conditional update.
  const owner = `force:${actorId}:${crypto.randomUUID()}`;
  const claimed = await prisma.aiImportJob.updateMany({ where: { id: q.jobId, status: { notIn: RUNNING }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + FORCE_LEASE_MS) } });
  if (claimed.count !== 1) throw new ImportJobError("Technical: the import is busy (being processed, imported or forced by another action) — try again in a minute.", 409);
  let questionId: string | null = null;
  try {
    const fresh = await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q.id }, include: { figures: true } });
    if (fresh.questionId) throw new ImportJobError("Technical: this question was stored meanwhile — reload the page.", 409);
    let item;
    try {
      item = await importForced(q.job, fresh, settings, actorId, kind);
    } catch (error) {
      throw new ImportJobError(`Technical failure while storing the question: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 600), 500);
    }
    if (item.outcome !== "imported") throw new ImportJobError(`Technical failure: ${item.reason}`.slice(0, 600), 500);
    questionId = (await prisma.aiImportQuestion.findUniqueOrThrow({ where: { id: q.id }, select: { questionId: true } })).questionId;
    if (!questionId) throw new ImportJobError("Technical failure: the Bulk Import stored no question.", 500);
  } finally {
    await prisma.aiImportJob.updateMany({ where: { id: q.jobId, leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: null } });
  }

  const e = effective(q);
  const latestVersion = await prisma.aiImportQuestionVersion.findFirst({ where: { questionId: q.id }, orderBy: { createdAt: "desc" }, select: { id: true, kind: true } });
  const contentSha256 = crypto.createHash("sha256").update(JSON.stringify({ e, finalAnswer: q.finalAnswer })).digest("hex");
  const audit = {
    action: kind === "PUBLISH" ? "FORCE_TO_PUBLISH" : "ADD_AS_WITHDRAWN",
    importQuestionId: q.id,
    jobId: q.jobId,
    questionNumber: q.sourceNumber,
    previousStatus,
    resultingStatus: target,
    bypassed,
    adaptations: adapted,
    reason,
    versions: { importQuestionUpdatedAt: q.updatedAt.toISOString(), latestVersionId: latestVersion?.id ?? null, latestVersionKind: latestVersion?.kind ?? null, contentSha256 },
    alreadyDone,
  };
  const now = new Date();
  const qb = await prisma.$transaction(async (tx) => {
    const updated = await tx.question.update({
      where: { id: questionId! },
      data: {
        status: target,
        ...(kind === "WITHDRAWN" ? { answerVerification: "WITHDRAWN_IN_OFFICIAL_KEY" } : {}),
      },
      select: { id: true, code: true },
    });
    // A withdrawn question has no correct option, whatever answer (placeholder, old key, AI) the import carried.
    if (kind === "WITHDRAWN") await tx.questionOption.updateMany({ where: { questionId: questionId! }, data: { isCorrect: false } });
    await tx.aiImportQuestion.update({
      where: { id: q.id },
      data: kind === "PUBLISH" ? { status: AiImportQuestionStatus.PUBLISHED, publishedAt: now } : { status: AiImportQuestionStatus.IMPORTED },
    });
    // Append-only record (the application never updates or deletes AuditLog rows).
    await tx.auditLog.create({ data: { actorId, action: kind === "PUBLISH" ? "AI_IMPORT_FORCE_TO_PUBLISH" : "AI_IMPORT_ADD_AS_WITHDRAWN", entityType: "Question", entityId: questionId, metadata: { ...audit, questionCode: updated.code } as Prisma.InputJsonValue } });
    return updated;
  });
  await logEvent(q.jobId, kind === "PUBLISH" ? "FORCE_TO_PUBLISH" : "ADDED_AS_WITHDRAWN", `Q${q.sourceLabel}: ${kind === "PUBLISH" ? "FORCE TO PUBLISH" : "added to the paper as WITHDRAWN"} by a Master Admin (${qb.code})${bypassed.length ? ` — bypassed: ${bypassed.join("; ")}` : ""}. Reason: ${reason}`.slice(0, 2000), { ...audit, questionId }, actorId);
  return { kind, importQuestionId: q.id, questionId: questionId!, code: qb.code, status: target, previousStatus, bypassed, alreadyDone };
}
