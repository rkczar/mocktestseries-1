import "server-only";
import { Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withExamTaxonomy } from "@/lib/exam-taxonomy";
import type { TeacherScope } from "@/lib/teacher/scope";
import { QUESTION_PREVIEW_SELECT } from "@/lib/question-preview";

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

/** Question-list filters (all optional; anything outside the scope is ignored). Also the "from" state the editor returns to. */
export interface QuestionListFilters {
  examId?: string;
  status?: string;
  q?: string;
  subjectId?: string;
  topicId?: string;
  subTopicId?: string;
  paperId?: string;
  page: number;
}

const LIST_KEYS = { exam: "examId", status: "status", q: "q", subject: "subjectId", topic: "topicId", subtopic: "subTopicId", paper: "paperId" } as const;

/** Parses list filters from a query string / searchParams (only known keys, bounded lengths). */
export function parseQuestionListFilters(sp: URLSearchParams | Record<string, string | string[] | undefined>): QuestionListFilters {
  const get = (k: string) => {
    const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
    const one = Array.isArray(v) ? v[0] : v;
    return one ? String(one).trim().slice(0, 100) : undefined;
  };
  const f: QuestionListFilters = { page: Math.max(1, Number.parseInt(get("page") ?? "1", 10) || 1) };
  for (const [k, field] of Object.entries(LIST_KEYS)) {
    const v = get(k);
    if (v) (f as unknown as Record<string, string>)[field] = v;
  }
  return f;
}

/** The query string for a filter state (stable, known keys only). */
export function questionListQuery(f: QuestionListFilters, patch: Partial<QuestionListFilters> & { expand?: boolean } = {}): string {
  const n = { ...f, ...patch };
  const sp = new URLSearchParams();
  for (const [k, field] of Object.entries(LIST_KEYS)) {
    const v = (n as unknown as Record<string, string | undefined>)[field];
    if (v) sp.set(k, v);
  }
  if (n.page > 1) sp.set("page", String(n.page));
  if (patch.expand) sp.set("expand", "all");
  return sp.toString();
}

function questionListWhere(scope: TeacherScope, f: QuestionListFilters): Prisma.QuestionWhereInput {
  const examIds = f.examId && scope.examIds.includes(f.examId) ? [f.examId] : scope.examIds;
  return {
    examId: { in: examIds },
    ...(f.status === "DRAFT" || f.status === "PUBLISHED" || f.status === "ARCHIVED" ? { status: f.status as QuestionStatus } : {}),
    ...(f.q ? { OR: [{ code: { contains: f.q, mode: "insensitive" } }, { text: { contains: f.q, mode: "insensitive" } }] } : {}),
    ...(f.subjectId ? { subjectId: f.subjectId } : {}),
    ...(f.topicId ? { topicId: f.topicId } : {}),
    ...(f.subTopicId ? { subTopicId: f.subTopicId } : {}),
    ...(f.paperId ? { previousYearPaperId: f.paperId } : {}),
  };
}

// Stable order (not updatedAt): saving a question must not move it, so "Save & next" walks the list in order.
const LIST_ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];

export async function listTeacherQuestions(scope: TeacherScope, f: QuestionListFilters) {
  const where = questionListWhere(scope, f);
  const [total, rows] = await Promise.all([
    prisma.question.count({ where }),
    prisma.question.findMany({
      where,
      orderBy: LIST_ORDER,
      skip: (f.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        status: true,
        retiredAt: true,
        updatedAt: true,
        exam: { select: { name: true } },
        subject: { select: { name: true } },
        topic: { select: { name: true } },
        subTopic: { select: { name: true } },
        previousYearPaper: { select: { title: true, year: true } },
        ...QUESTION_PREVIEW_SELECT,
      },
    }),
  ]);
  return { total, rows, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** The question after `currentId` in the same filtered list (for "Save & next"), or null. */
export async function nextQuestionId(scope: TeacherScope, f: QuestionListFilters, currentId: string): Promise<string | null> {
  const cur = await prisma.question.findFirst({ where: { id: currentId, examId: { in: scope.examIds } }, select: { createdAt: true, id: true } });
  if (!cur) return null;
  const next = await prisma.question.findFirst({
    where: {
      AND: [
        questionListWhere(scope, f),
        { status: { not: "ARCHIVED" }, retiredAt: null },
        { OR: [{ createdAt: { lt: cur.createdAt } }, { createdAt: cur.createdAt, id: { lt: cur.id } }] },
      ],
    },
    orderBy: LIST_ORDER,
    select: { id: true },
  });
  return next?.id ?? null;
}

/** Subjects / topics / sub-topics / PYQ papers of the teacher's exams, for the list filters. */
export async function teacherQuestionFilterOptions(scope: TeacherScope) {
  const [tree, papers] = await Promise.all([
    teacherExamTree(scope),
    prisma.previousYearPaper.findMany({ where: { examId: { in: scope.examIds } }, orderBy: [{ year: "desc" }], select: { id: true, title: true, year: true, examId: true } }),
  ]);
  return { tree, papers };
}
