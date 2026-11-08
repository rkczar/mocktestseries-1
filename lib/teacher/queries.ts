import "server-only";
import { Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withExamTaxonomy } from "@/lib/exam-taxonomy";
import type { TeacherScope } from "@/lib/teacher/scope";

/** Read helpers for Teacher Portal pages — every query is filtered by the scope's exam ids. */

export const PAGE_SIZE = 25;

export async function teacherExams(scope: TeacherScope) {
  return prisma.exam.findMany({ where: { id: { in: scope.examIds } }, orderBy: { order: "asc" }, select: { id: true, name: true } });
}

/** Exam → subject → topic tree for the editor, assigned exams only (no PYQ papers: teachers never link papers). */
export async function teacherExamTree(scope: TeacherScope) {
  const exams = await prisma.exam.findMany({ where: { id: { in: scope.examIds } }, orderBy: { order: "asc" }, select: { id: true, name: true } });
  const withTax = await withExamTaxonomy(prisma, exams);
  return withTax.map((e) => ({ ...e, previousYearPapers: [] as { id: string; title: string; year: number }[] }));
}

export async function listTeacherQuestions(scope: TeacherScope, f: { examId?: string; status?: string; q?: string; page: number }) {
  const examIds = f.examId && scope.examIds.includes(f.examId) ? [f.examId] : scope.examIds;
  const where: Prisma.QuestionWhereInput = {
    examId: { in: examIds },
    ...(f.status === "DRAFT" || f.status === "PUBLISHED" || f.status === "ARCHIVED" ? { status: f.status as QuestionStatus } : {}),
    ...(f.q ? { OR: [{ code: { contains: f.q, mode: "insensitive" } }, { text: { contains: f.q, mode: "insensitive" } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.question.count({ where }),
    prisma.question.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (f.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, code: true, text: true, status: true, retiredAt: true, updatedAt: true, exam: { select: { name: true } }, subject: { select: { name: true } } },
    }),
  ]);
  return { total, rows, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}
