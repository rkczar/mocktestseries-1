import "server-only";
import { unstable_cache } from "next/cache";
import { QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Aggregate, answer-free facts about an exam's previous year papers for the
 * public PYQ hub, the year-wise paper pages, the syllabus weightage and the
 * exam hub. Counts follow the canonical PYQ membership rule
 * (lib/pyq-membership.ts): a question belongs to a paper only through
 * Question.previousYearPaperId, and only PUBLISHED questions count. Subject
 * names are this site's own question-bank classification, not an official
 * breakdown. Nothing here exposes a question, option or answer.
 */

/** A year page is indexable only when its paper(s) carry this much real, unique data. */
export const MIN_INDEXABLE_PAPER_QUESTIONS = 50;
export const MIN_INDEXABLE_PAPER_SUBJECTS = 5;

export interface SubjectCount {
  name: string;
  count: number;
}

export interface PaperInsight {
  id: string;
  year: number;
  title: string;
  paperCode: string | null;
  questionCount: number;
  /** Subjects represented in the paper, most questions first. */
  subjects: SubjectCount[];
  indexable: boolean;
}

export interface SubjectWeightage extends SubjectCount {
  /** Share of all published PYQ questions, 0–1. */
  share: number;
  /** Number of papers with at least one question from this subject. */
  papers: number;
}

export interface ExamPyqInsights {
  papers: PaperInsight[];
  totalQuestions: number;
  /** Across every paper, most questions first. */
  weightage: SubjectWeightage[];
  /** Years that have at least one indexable paper, newest first. */
  indexableYears: number[];
}

/** Uncached — exported for scripts; pages use getExamPyqInsights. */
export async function computeExamPyqInsights(examId: string): Promise<ExamPyqInsights> {
  const papers = await prisma.previousYearPaper.findMany({
    where: { examId, isActive: true },
    orderBy: [{ year: "desc" }, { order: "asc" }],
    select: { id: true, year: true, title: true, paperCode: true },
  });
  const rows =
    papers.length > 0
      ? await prisma.question.groupBy({
          by: ["previousYearPaperId", "subjectId"],
          where: { previousYearPaperId: { in: papers.map((p) => p.id) }, status: QuestionStatus.PUBLISHED },
          _count: { _all: true },
        })
      : [];
  const subjectNames = new Map(
    (await prisma.subject.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.subjectId))] } }, select: { id: true, name: true } })).map((s) => [
      s.id,
      s.name,
    ])
  );

  const byPaper = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.previousYearPaperId) continue;
    const name = subjectNames.get(r.subjectId) ?? "Other";
    const subjects = byPaper.get(r.previousYearPaperId) ?? new Map<string, number>();
    subjects.set(name, (subjects.get(name) ?? 0) + r._count._all);
    byPaper.set(r.previousYearPaperId, subjects);
  }

  const sortCounts = (m: Map<string, number>): SubjectCount[] =>
    [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const paperInsights: PaperInsight[] = papers.map((p) => {
    const subjects = sortCounts(byPaper.get(p.id) ?? new Map());
    const questionCount = subjects.reduce((sum, s) => sum + s.count, 0);
    return {
      ...p,
      questionCount,
      subjects,
      indexable: questionCount >= MIN_INDEXABLE_PAPER_QUESTIONS && subjects.length >= MIN_INDEXABLE_PAPER_SUBJECTS,
    };
  });

  const totals = new Map<string, { count: number; papers: number }>();
  for (const p of paperInsights) {
    for (const s of p.subjects) {
      const t = totals.get(s.name) ?? { count: 0, papers: 0 };
      totals.set(s.name, { count: t.count + s.count, papers: t.papers + 1 });
    }
  }
  const totalQuestions = paperInsights.reduce((sum, p) => sum + p.questionCount, 0);
  const weightage = [...totals]
    .map(([name, t]) => ({ name, count: t.count, papers: t.papers, share: totalQuestions > 0 ? t.count / totalQuestions : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const indexableYears = [...new Set(paperInsights.filter((p) => p.indexable).map((p) => p.year))].sort((a, b) => b - a);
  return { papers: paperInsights, totalQuestions, weightage, indexableYears };
}

/** Cached hourly: PYQ papers change only when an admin imports or edits one. */
export const getExamPyqInsights = unstable_cache(computeExamPyqInsights, ["exam-pyq-insights"], {
  tags: ["exam-pyq-insights"],
  revalidate: 3600,
});

export function pyqYearPath(slug: string, year: number): string {
  return `/exams/${slug}/previous-year-papers/${year}`;
}

/** "15.2%" — one decimal, for subject shares. */
export function formatShare(share: number): string {
  return `${(Math.round(share * 1000) / 10).toFixed(1)}%`;
}
