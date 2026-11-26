import { prisma } from "@/lib/prisma";
import { captureQuestionSource } from "@/lib/question-source/capture";

/** The decision for one imported question (pure; see applyLateOfficialKey). */
export function lateKeyDecision(i: { status: string; answerVerification: string | null; reviewReason: string | null; answerStatus: string; label: string; current: string[]; official: string[]; optionLabels: string[] }): { action: "UPDATED" | "CONFIRMED" | "FLAGGED" | null; reason: string | null } {
  if (i.answerStatus === "WITHDRAWN") {
    if (i.status === "WITHDRAWN" || i.reviewReason?.includes("official key withdraws")) return { action: null, reason: null };
    return { action: "FLAGGED", reason: `REVIEW_REQUIRED — the official key withdraws Q${i.label}; the Question Bank record is ${i.status} (not changed automatically).` };
  }
  if (!i.official.length || !i.official.every((l) => i.optionLabels.includes(l))) return { action: null, reason: null };
  const same = i.official.join() === i.current.join();
  if (same) return i.answerVerification !== "OFFICIAL_KEY" ? { action: "CONFIRMED", reason: null } : { action: null, reason: null };
  if (i.status === "DRAFT") return { action: "UPDATED", reason: `REVIEW_REQUIRED — answer set from the official key matched after import (was ${i.current.join(", ") || "none"}, now ${i.official.join(", ")}).` };
  if (i.reviewReason?.includes(`official key says ${i.official.join(", ")}`)) return { action: null, reason: null };
  return { action: "FLAGGED", reason: `ANSWER_UNVERIFIED — official key says ${i.official.join(", ")}, the ${i.status} Question Bank answer is ${i.current.join(", ") || "none"} (not changed automatically).` };
}

/**
 * An official answer key matched AFTER questions were imported (legacy papers imported without a key, 2026-11-26):
 * updates the existing Question Bank records in place — never a re-import.
 *  - DRAFT: correct option(s) set from the official key, answerVerification OFFICIAL_KEY, review note kept.
 *  - PUBLISHED / ARCHIVED with the SAME answer: only answerVerification → OFFICIAL_KEY.
 *  - PUBLISHED with a DIFFERENT answer, or a key that withdraws the question: never changed automatically (scoring and
 *    attempt history depend on it) — flagged for review with both answers.
 * Every change is audited and refreshes the question's source evidence (answer-key crop).
 */
export async function applyLateOfficialKey(jobId: string): Promise<{ updated: number; confirmed: number; flagged: number }> {
  const out = { updated: 0, confirmed: 0, flagged: 0 };
  const job = await prisma.aiImportJob.findUnique({ where: { id: jobId }, select: { createdById: true } });
  if (!job) return out;
  const rows = await prisma.aiImportQuestion.findMany({ where: { jobId, questionId: { not: null }, answerStatus: { in: ["OFFICIAL_MATCHED", "WITHDRAWN"] } }, select: { id: true, questionId: true, sourceLabel: true, answerStatus: true, officialAnswer: true } });
  for (const r of rows) {
    const q = await prisma.question.findUnique({ where: { id: r.questionId! }, select: { id: true, status: true, answerVerification: true, reviewRequired: true, reviewReason: true, options: { select: { id: true, label: true, isCorrect: true } } } });
    if (!q) continue;
    const current = q.options.filter((o) => o.isCorrect).map((o) => o.label).sort();
    const official = [...r.officialAnswer].sort();
    const { action, reason } = lateKeyDecision({ status: q.status, answerVerification: q.answerVerification, reviewReason: q.reviewReason, answerStatus: r.answerStatus, label: r.sourceLabel, current, official, optionLabels: q.options.map((o) => o.label) });
    if (!action) continue;
    await prisma.$transaction([
      ...(action === "UPDATED" ? q.options.map((o) => prisma.questionOption.update({ where: { id: o.id }, data: { isCorrect: official.includes(o.label) } })) : []),
      prisma.question.update({
        where: { id: q.id },
        data: {
          ...(action !== "FLAGGED" ? { answerVerification: "OFFICIAL_KEY" } : {}),
          ...(reason ? { reviewRequired: true, reviewReason: reason.slice(0, 1000) } : {}),
        },
      }),
      prisma.auditLog.create({ data: { actorId: job.createdById, action: `QUESTION_LATE_KEY_${action}`, entityType: "Question", entityId: q.id, metadata: { jobId, importQuestionId: r.id, before: current, official, status: q.status } } }),
    ]);
    out[action === "UPDATED" ? "updated" : action === "CONFIRMED" ? "confirmed" : "flagged"]++;
    await captureQuestionSource(r.id).catch(() => undefined);
  }
  return out;
}
