import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Mock Test question MEMBERSHIP (Step 3). Every assignment references a
 * canonical Question Bank row (MockTestQuestion is only {mockTestId,
 * questionId, order}); nothing here ever copies, updates or deletes a
 * Question. Question OWNERSHIP — examId, previousYearPaperId, source, code —
 * is independent of which tests reuse it, so a Punjab MO 2021 PYQ added to a
 * RUHS mock stays Punjab MO / Punjab MO 2021 and no RUHS paper's count
 * changes (lib/pyq-membership.ts). Callers (the Mock Test server actions)
 * own authorization and audit.
 *
 * Each operation re-reads the current assignment and rewrites a dense
 * 0..n-1 order, so concurrent edits and stale client lists can never
 * produce duplicate slots.
 */

export type MembershipResult = { error: string } | { ids: string[]; examId: string };

export async function loadAssignment(mockTestId: string) {
  const mockTest = await prisma.mockTest.findUnique({
    where: { id: mockTestId },
    select: { id: true, examId: true, status: true, questions: { orderBy: { order: "asc" }, select: { questionId: true } } },
  });
  return mockTest ? { ...mockTest, ids: mockTest.questions.map((q) => q.questionId) } : null;
}

/** Replaces the whole ordered assignment in one transaction. */
export async function writeAssignment(mockTestId: string, ids: string[]) {
  await prisma.$transaction([
    prisma.mockTestQuestion.deleteMany({ where: { mockTestId } }),
    prisma.mockTestQuestion.createMany({ data: ids.map((questionId, order) => ({ mockTestId, questionId, order })) }),
  ]);
}

/** Any non-archived question of ANY exam can be attached (cross-exam reuse is reference-only). */
export async function attachableIds(ids: string[]) {
  const rows = await prisma.question.findMany({ where: { id: { in: ids }, status: { not: "ARCHIVED" } }, select: { id: true } });
  const ok = new Set(rows.map((r) => r.id));
  return ids.filter((id) => ok.has(id));
}

/** Appends in the order given, skipping anything already in the test or archived/missing. */
export async function addQuestionsToMock(mockTestId: string, questionIds: string[]) {
  const current = await loadAssignment(mockTestId);
  if (!current) return { error: "Mock test not found." } as const;
  const have = new Set(current.ids);
  const wanted = [...new Set(questionIds)].filter((id) => !have.has(id));
  const valid = await attachableIds(wanted);
  if (valid.length > 0) await writeAssignment(mockTestId, [...current.ids, ...valid]);
  const crossExam = valid.length ? await prisma.question.count({ where: { id: { in: valid }, examId: { not: current.examId } } }) : 0;
  return { added: valid.length, crossExam, rejected: wanted.length - valid.length, skipped: questionIds.length - valid.length };
}

export async function removeQuestionsFromMock(mockTestId: string, questionIds: string[]) {
  const current = await loadAssignment(mockTestId);
  if (!current) return { error: "Mock test not found." } as const;
  const drop = new Set(questionIds);
  const next = current.ids.filter((id) => !drop.has(id));
  if (current.status === "PUBLISHED" && next.length === 0) {
    return { error: "A published test must keep at least one question. Unpublish it first to remove every question." } as const;
  }
  await writeAssignment(mockTestId, next);
  return { removed: current.ids.length - next.length };
}

/** Swaps one question for another in the same slot. */
export async function replaceQuestionInMock(mockTestId: string, oldId: string, newId: string) {
  const current = await loadAssignment(mockTestId);
  if (!current) return { error: "Mock test not found." } as const;
  const slot = current.ids.indexOf(oldId);
  if (slot === -1) return { error: "That question is no longer in this test — reload and try again." } as const;
  if (current.ids.includes(newId)) return { error: "The replacement is already in this test." } as const;
  const [valid] = await attachableIds([newId]);
  if (!valid) return { error: "The replacement must be a non-archived Question Bank question." } as const;
  const next = [...current.ids];
  next[slot] = newId;
  await writeAssignment(mockTestId, next);
  return { slot: slot + 1 };
}
