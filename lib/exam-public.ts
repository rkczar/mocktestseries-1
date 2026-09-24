import "server-only";
import { LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import { prisma } from "@/lib/prisma";

/**
 * Data access for the public exam SEO hub (/exams, /exams/[slug] and its deep
 * pages). Deliberately separate from lib/student-data.ts (which powers the
 * authenticated /student/exams tree) — this only ever reads fields that are
 * safe to show to an anonymous visitor, and every query is scoped to
 * `publicPageEnabled: true` so a real, unpublished exam never leaks here.
 */

export async function getPublicExamBySlug(slug: string) {
  return prisma.exam.findFirst({
    where: { publicSlug: slug, publicPageEnabled: true },
  });
}

export async function getPublicExamList() {
  return prisma.exam.findMany({
    where: { publicPageEnabled: true, isActive: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });
}

export interface ExamPublicStats {
  subjects: number;
  topics: number;
  questions: number;
  papers: number;
  mockTests: number;
  aiExplanations: number;
}

export async function getExamPublicStats(examId: string): Promise<ExamPublicStats> {
  const [subjects, topics, questions, papers, mockTests, aiExplanations] = await Promise.all([
    prisma.subject.count({ where: { examId } }),
    prisma.topic.count({ where: { subject: { examId } } }),
    prisma.question.count({ where: { examId, status: "PUBLISHED" } }),
    prisma.previousYearPaper.count({ where: { examId, isActive: true } }),
    prisma.mockTest.count({ where: { examId, ...LIVE_MOCK_TEST_WHERE } }),
    prisma.aIExplanation.count({ where: { status: "COMPLETED", question: { examId, status: "PUBLISHED" } } }),
  ]);
  return { subjects, topics, questions, papers, mockTests, aiExplanations };
}

export interface SubjectWithCounts {
  id: string;
  name: string;
  topicCount: number;
  questionCount: number;
}

export async function getExamSubjectsWithCounts(examId: string): Promise<SubjectWithCounts[]> {
  const subjects = await prisma.subject.findMany({
    where: { examId },
    orderBy: { order: "asc" },
    include: {
      _count: { select: { topics: true, questions: { where: { status: "PUBLISHED" } } } },
    },
  });
  return subjects.map((s) => ({
    id: s.id,
    name: s.name,
    topicCount: s._count.topics,
    questionCount: s._count.questions,
  }));
}

export interface PublicPaper {
  id: string;
  year: number;
  title: string;
  paperCode: string | null;
  questionCount: number;
}

export async function getExamPapers(examId: string): Promise<PublicPaper[]> {
  const papers = await prisma.previousYearPaper.findMany({
    where: { examId, isActive: true },
    orderBy: [{ year: "desc" }, { order: "asc" }],
    include: { _count: { select: { questions: { where: { status: "PUBLISHED" } } } } },
  });
  return papers.map((p) => ({
    id: p.id,
    year: p.year,
    title: p.title,
    paperCode: p.paperCode,
    questionCount: p._count.questions,
  }));
}

export interface ImportantDate {
  label: string;
  date: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export function parseImportantDates(raw: unknown): ImportantDate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
    .filter((r) => typeof r.label === "string" && typeof r.date === "string")
    .map((r) => ({ label: r.label as string, date: r.date as string }));
}

export function parseFaqItems(raw: unknown): FaqItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
    .filter((r) => typeof r.question === "string" && typeof r.answer === "string")
    .map((r) => ({ question: r.question as string, answer: r.answer as string }));
}
