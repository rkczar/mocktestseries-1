import "server-only";
import { Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { flagExplanationStaleIfExists } from "@/lib/ai-explanation";
import { publishRefusal } from "@/lib/question-publish-policy";
import { CONTENT_SELECT, contentOf, readContent, sameContent, writeContent } from "@/lib/question-content";
import { mockUnpublishImpact } from "@/lib/teacher/content";

/**
 * Master Admin decisions on the Teacher Content Approvals queue (Phase A,
 * docs/TEACHER-PORTAL.md). Callers (Server Actions) enforce
 * TEACHER_APPROVALS_MANAGE + role MASTER_ADMIN; every decision is one
 * transaction that first moves the request OPEN → decided (so two admins can
 * never both apply it) and is audit-logged against the request.
 *
 * Approve:
 *  - PUBLISH_QUESTION  → the Draft question is published through the normal
 *    publishing policy (lib/question-publish-policy.ts).
 *  - REVISION          → the proposed content is written to the live question,
 *    only if the live content still equals the revision's base (else the
 *    revision is marked STALE and nothing changes); the result must pass the
 *    publishing policy or the whole approval rolls back.
 *  - UNPUBLISH_NOTICE  → acknowledged; the question stays unpublished.
 *  - UNPUBLISH_REQUEST → Mock Test (Live CBT): the question is unpublished from
 *    that test now. Grand Test / Live Test / PYQ paper: the decision is
 *    recorded; the change itself is made with Retire / Replace (no per-test
 *    exclusion exists for those in Phase A).
 *  - RESTORE_REQUEST   → the unpublished question is put back in the test.
 *  - DELETE_REQUEST    → the decision is recorded; the deletion is executed
 *    with the existing Retire / Replace tool (preview, impact, confirmation).
 * Reject (or Restore on an UNPUBLISH_NOTICE, which also clears the exclusion)
 * leaves content unchanged.
 */

export type DecisionResult = { ok: true; message: string } | { ok: false; error: string };

class DecisionError extends Error {}

async function decide(tx: Prisma.TransactionClient, requestId: string, status: "APPROVED" | "REJECTED", actorId: string, note: string | null) {
  const moved = await tx.teacherContentRequest.updateMany({
    where: { id: requestId, status: "OPEN" },
    data: { status, reviewerId: actorId, decisionNote: note, decidedAt: new Date() },
  });
  if (moved.count !== 1) throw new DecisionError("This request is no longer open — reload the queue.");
}

async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, requestId: string, metadata: Prisma.InputJsonValue) {
  await tx.auditLog.create({ data: { actorId, action, entityType: "TeacherContentRequest", entityId: requestId, metadata } });
}

function cleanNote(note: unknown): string | null {
  const n = String(note ?? "").trim().slice(0, 1000);
  return n || null;
}

async function setExclusion(tx: Prisma.TransactionClient, mockTestId: string, questionId: string, actorId: string, reason: string) {
  const mock = await tx.mockTest.findUnique({ where: { id: mockTestId }, select: { status: true } });
  if (!mock) throw new DecisionError("The test no longer exists.");
  const impact = await mockUnpublishImpact(tx, mockTestId, questionId);
  if (mock.status === "PUBLISHED" && impact.servableQuestionsBefore <= 1) {
    throw new DecisionError("This is the last question students can get in this published test — unpublish the test itself instead.");
  }
  const n = await tx.mockTestQuestion.updateMany({
    where: { mockTestId, questionId, excludedAt: null },
    data: { excludedAt: new Date(), excludedById: actorId, excludedReason: reason },
  });
  if (n.count !== 1) throw new DecisionError("The question is no longer in this test, or is already unpublished from it.");
}

async function clearExclusion(tx: Prisma.TransactionClient, mockTestId: string, questionId: string) {
  return (await tx.mockTestQuestion.updateMany({
    where: { mockTestId, questionId, excludedAt: { not: null } },
    data: { excludedAt: null, excludedById: null, excludedReason: null },
  })).count;
}

export async function approveRequest(actorId: string, requestId: string, noteIn?: unknown): Promise<DecisionResult> {
  const note = cleanNote(noteIn);
  const req = await prisma.teacherContentRequest.findUnique({ where: { id: String(requestId) } });
  if (!req) return { ok: false, error: "Request not found." };
  if (req.status !== "OPEN") return { ok: false, error: "This request is no longer open." };
  let flagStale = false;
  try {
    const message = await prisma.$transaction(async (tx) => {
      await decide(tx, req.id, "APPROVED", actorId, note);
      switch (req.type) {
        case "PUBLISH_QUESTION": {
          const q = req.questionId ? await tx.question.findUnique({ where: { id: req.questionId }, select: { status: true, retiredAt: true } }) : null;
          if (!q || q.retiredAt || q.status !== QuestionStatus.DRAFT) throw new DecisionError("The question is no longer a Draft — reject this request instead.");
          const refusal = await publishRefusal(req.questionId!, tx);
          if (refusal) throw new DecisionError(refusal);
          await tx.question.updateMany({ where: { id: req.questionId!, status: QuestionStatus.DRAFT }, data: { status: QuestionStatus.PUBLISHED } });
          await tx.auditLog.create({ data: { actorId, action: "QUESTION_STATUS_CHANGED", entityType: "Question", entityId: req.questionId!, metadata: { status: "PUBLISHED", teacherRequestId: req.id } } });
          await audit(tx, actorId, "TEACHER_REQUEST_APPROVED", req.id, { type: req.type, note });
          return "Approved — the question is now published.";
        }
        case "REVISION": {
          const rev = req.revisionId ? await tx.questionRevision.findUnique({ where: { id: req.revisionId } }) : null;
          if (!rev || rev.status !== "SUBMITTED") throw new DecisionError("The revision is no longer waiting for approval.");
          // Lock the live question row while comparing and writing.
          await tx.$queryRaw`SELECT id FROM "Question" WHERE id = ${rev.questionId} FOR UPDATE`;
          const live = await tx.question.findUniqueOrThrow({ where: { id: rev.questionId }, select: { ...CONTENT_SELECT, status: true, retiredAt: true } });
          if (live.retiredAt) throw new DecisionError("The question was retired — reject this revision.");
          const base = readContent(rev.baseSnapshot);
          if (!sameContent(base, contentOf(live))) throw new StaleRevision(rev.id);
          const proposed = readContent(rev.proposedSnapshot);
          await writeContent(tx, rev.questionId, proposed);
          if (live.status === QuestionStatus.PUBLISHED) {
            const refusal = await publishRefusal(rev.questionId, tx, { evaluatePublished: true });
            if (refusal) throw new DecisionError(`${refusal} Nothing was changed — reject the revision or ask the teacher to fix it.`);
          }
          await tx.questionRevision.update({ where: { id: rev.id }, data: { status: "APPROVED", decidedAt: new Date(), decidedById: actorId } });
          await tx.auditLog.create({
            data: { actorId, action: "QUESTION_UPDATED", entityType: "Question", entityId: rev.questionId, metadata: { teacherRevisionId: rev.id, teacherRequestId: req.id, authorId: rev.authorId, lastEditedById: rev.lastEditedById } },
          });
          await audit(tx, actorId, "TEACHER_REQUEST_APPROVED", req.id, { type: req.type, revisionId: rev.id, note });
          flagStale = base.text !== proposed.text || base.questionType !== proposed.questionType || JSON.stringify(base.options) !== JSON.stringify(proposed.options);
          return "Approved — the revision is now live.";
        }
        case "UNPUBLISH_NOTICE": {
          await audit(tx, actorId, "TEACHER_REQUEST_APPROVED", req.id, { type: req.type, note });
          return "Acknowledged — the question stays unpublished from this test.";
        }
        case "UNPUBLISH_REQUEST": {
          if (req.targetKind === "MOCK_TEST" && req.targetId && req.questionId) {
            await setExclusion(tx, req.targetId, req.questionId, actorId, req.reason);
            await audit(tx, actorId, "TEACHER_REQUEST_APPROVED", req.id, { type: req.type, applied: true, note });
            return "Approved — the question is unpublished from this test for new attempts.";
          }
          await audit(tx, actorId, "TEACHER_REQUEST_APPROVED", req.id, { type: req.type, applied: false, note });
          return "Approved — action not yet applied. Make the change with Retire / Replace (link below).";
        }
        case "RESTORE_REQUEST": {
          if (!req.targetId || !req.questionId || (await clearExclusion(tx, req.targetId, req.questionId)) !== 1) {
            throw new DecisionError("The question is no longer unpublished from this test.");
          }
          await audit(tx, actorId, "TEACHER_REQUEST_APPROVED", req.id, { type: req.type, note });
          return "Approved — the question is back in the test for new attempts.";
        }
        case "DELETE_REQUEST": {
          await audit(tx, actorId, "TEACHER_REQUEST_APPROVED", req.id, { type: req.type, note });
          return "Approved — action not yet applied. Retire or replace the question with Retire / Replace (link below).";
        }
      }
    });
    if (flagStale && req.questionId) await flagExplanationStaleIfExists(req.questionId);
    return { ok: true, message };
  } catch (e) {
    if (e instanceof StaleRevision) {
      await prisma.$transaction(async (tx) => {
        await tx.questionRevision.updateMany({ where: { id: e.revisionId, status: "SUBMITTED" }, data: { status: "STALE", decidedAt: new Date(), decidedById: actorId } });
        const note2 = "Out of date: the published question changed after this revision was made. The teacher must start a new revision.";
        await decide(tx, req.id, "REJECTED", actorId, note2);
        await audit(tx, actorId, "TEACHER_REVISION_STALE", req.id, { revisionId: e.revisionId });
      });
      return { ok: false, error: "Not applied: the published question changed after this revision was made. The revision was closed as out of date; nothing was changed." };
    }
    if (e instanceof DecisionError) return { ok: false, error: e.message };
    throw e;
  }
}

class StaleRevision extends Error {
  constructor(public revisionId: string) {
    super("stale");
  }
}

/** Reject. For an UNPUBLISH_NOTICE this is "Restore": the exclusion is cleared. */
export async function rejectRequest(actorId: string, requestId: string, noteIn?: unknown): Promise<DecisionResult> {
  const note = cleanNote(noteIn);
  const req = await prisma.teacherContentRequest.findUnique({ where: { id: String(requestId) } });
  if (!req) return { ok: false, error: "Request not found." };
  if (req.type !== "UNPUBLISH_NOTICE" && !note) return { ok: false, error: "Give the teacher a reason for the rejection." };
  try {
    const message = await prisma.$transaction(async (tx) => {
      await decide(tx, req.id, "REJECTED", actorId, note);
      if (req.type === "REVISION" && req.revisionId) {
        await tx.questionRevision.updateMany({ where: { id: req.revisionId, status: "SUBMITTED" }, data: { status: "REJECTED", decidedAt: new Date(), decidedById: actorId } });
      }
      if (req.type === "UNPUBLISH_NOTICE" && req.targetId && req.questionId) {
        const restored = await clearExclusion(tx, req.targetId, req.questionId);
        await audit(tx, actorId, "TEACHER_UNPUBLISH_RESTORED", req.id, { restored, note });
        return restored ? "Restored — the question is back in the test for new attempts." : "Closed — the question was already back in the test.";
      }
      await audit(tx, actorId, "TEACHER_REQUEST_REJECTED", req.id, { type: req.type, note });
      return "Rejected — nothing was changed.";
    });
    return { ok: true, message };
  } catch (e) {
    if (e instanceof DecisionError) return { ok: false, error: e.message };
    throw e;
  }
}
