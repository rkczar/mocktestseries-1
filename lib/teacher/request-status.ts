import "server-only";
import type { TeacherRequestStatus, TeacherRequestType } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * What a teacher request's decision means in practice (Phase A):
 *   PENDING      — waiting for the Master Admin.
 *   APPLIED      — approved and the change is in effect.
 *   NOT_APPLIED  — approved, but the change has to be made by hand with
 *                  Retire / Replace and has not been made yet (deletion
 *                  requests; unpublish requests for Grand Tests, Live Tests and
 *                  PYQ papers, which have no per-test exclusion in Phase A).
 *   REJECTED / WITHDRAWN.
 * Derived from the CURRENT state of the question and the test every time (no
 * stored flag that could drift): a deletion counts as applied once the
 * question is retired or gone; a Grand / Live Test or PYQ unpublish once the
 * question is no longer in that test / paper (or is retired).
 */
export type EffectiveStatus = "PENDING" | "APPLIED" | "NOT_APPLIED" | "REJECTED" | "WITHDRAWN";

export const EFFECTIVE_LABEL: Record<EffectiveStatus, string> = {
  PENDING: "Pending",
  APPLIED: "Applied",
  NOT_APPLIED: "Approved — action not yet applied",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

interface Req {
  id: string;
  type: TeacherRequestType;
  status: TeacherRequestStatus;
  questionId: string | null;
  targetKind: string | null;
  targetId: string | null;
}

/** Needs a manual follow-up after approval (the rest is applied inside the approval transaction). */
export function isManualFollowUp(r: Pick<Req, "type" | "targetKind">): boolean {
  return r.type === "DELETE_REQUEST" || (r.type === "UNPUBLISH_REQUEST" && r.targetKind !== "MOCK_TEST");
}

export async function effectiveStatuses(reqs: Req[]): Promise<Map<string, EffectiveStatus>> {
  const out = new Map<string, EffectiveStatus>();
  const manual = reqs.filter((r) => r.status === "APPROVED" && isManualFollowUp(r));
  const qids = [...new Set(manual.map((r) => r.questionId).filter((v): v is string => !!v))];
  const [questions, grand, live] = await Promise.all([
    qids.length ? prisma.question.findMany({ where: { id: { in: qids } }, select: { id: true, retiredAt: true, previousYearPaperId: true } }) : [],
    qids.length ? prisma.grandTestQuestion.findMany({ where: { questionId: { in: qids } }, select: { grandTestId: true, questionId: true } }) : [],
    qids.length ? prisma.liveTestQuestion.findMany({ where: { questionId: { in: qids } }, select: { liveTestId: true, questionId: true } }) : [],
  ]);
  const q = new Map(questions.map((x) => [x.id, x]));
  const inGrand = new Set(grand.map((g) => `${g.grandTestId}:${g.questionId}`));
  const inLive = new Set(live.map((l) => `${l.liveTestId}:${l.questionId}`));
  for (const r of reqs) {
    if (r.status === "OPEN") out.set(r.id, "PENDING");
    else if (r.status === "REJECTED") out.set(r.id, "REJECTED");
    else if (r.status === "WITHDRAWN") out.set(r.id, "WITHDRAWN");
    else if (!isManualFollowUp(r)) out.set(r.id, "APPLIED");
    else {
      const question = r.questionId ? q.get(r.questionId) : undefined;
      // Hard-deleted (questionId nulled) or retired = the question is out of every test.
      const gone = !question || !!question.retiredAt;
      let applied = gone;
      if (!gone && r.type === "UNPUBLISH_REQUEST") {
        const key = `${r.targetId}:${r.questionId}`;
        applied =
          r.targetKind === "GRAND_TEST" ? !inGrand.has(key) : r.targetKind === "LIVE_TEST" ? !inLive.has(key) : r.targetKind === "PYQ_PAPER" ? question!.previousYearPaperId !== r.targetId : false;
      }
      out.set(r.id, applied ? "APPLIED" : "NOT_APPLIED");
    }
  }
  return out;
}
