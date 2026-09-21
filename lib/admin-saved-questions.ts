import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Admin → Questions → Saved Questions (Section 18). Read-only
 * analytics/visibility over the existing SavedQuestion rows — never a second
 * copy of them, and never a path that lets Admin change a student's personal
 * saved state. One groupBy aggregates save counts per question; a second
 * query fetches the corresponding Question rows so the numbers reflect real
 * PUBLISHED/DRAFT/ARCHIVED bank content rather than a denormalized snapshot.
 */

export interface SavedQuestionsAdminFilters {
  examId?: string;
  subjectId?: string;
  search?: string;
  since?: Date;
}

export interface SavedQuestionAdminRow {
  questionId: string;
  code: string;
  text: string;
  status: string;
  examName: string;
  subjectName: string;
  saveCount: number;
  lastSavedAt: Date;
}

export async function getSavedQuestionsAdminOverview(filters: SavedQuestionsAdminFilters = {}): Promise<{
  rows: SavedQuestionAdminRow[];
  totalSaves: number;
  distinctQuestions: number;
  distinctStudents: number;
}> {
  const questionWhere = {
    examId: filters.examId || undefined,
    subjectId: filters.subjectId || undefined,
    ...(filters.search
      ? {
          OR: [
            { code: { contains: filters.search, mode: "insensitive" as const } },
            { text: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const matchingQuestionIds = filters.examId || filters.subjectId || filters.search
    ? (await prisma.question.findMany({ where: questionWhere, select: { id: true } })).map((q) => q.id)
    : null;

  const savedWhere = {
    createdAt: filters.since ? { gte: filters.since } : undefined,
    questionId: matchingQuestionIds ? { in: matchingQuestionIds } : undefined,
  };

  const [grouped, distinctStudentRows] = await Promise.all([
    prisma.savedQuestion.groupBy({
      by: ["questionId"],
      where: savedWhere,
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { questionId: "desc" } },
      take: 200,
    }),
    prisma.savedQuestion.findMany({ where: savedWhere, select: { studentId: true }, distinct: ["studentId"] }),
  ]);

  const questionIds = grouped.map((g) => g.questionId);
  const questions = await prisma.question.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, code: true, text: true, status: true, exam: { select: { name: true } }, subject: { select: { name: true } } },
  });
  const questionById = new Map(questions.map((q) => [q.id, q]));

  const rows: SavedQuestionAdminRow[] = grouped
    .map((g) => {
      const q = questionById.get(g.questionId);
      if (!q) return null;
      return {
        questionId: g.questionId,
        code: q.code,
        text: q.text,
        status: q.status as string,
        examName: q.exam.name,
        subjectName: q.subject.name,
        saveCount: g._count._all,
        lastSavedAt: g._max.createdAt as Date,
      };
    })
    .filter((r): r is SavedQuestionAdminRow => r !== null);

  const totalSaves = rows.reduce((sum, r) => sum + r.saveCount, 0);

  return {
    rows,
    totalSaves,
    distinctQuestions: rows.length,
    distinctStudents: distinctStudentRows.length,
  };
}
