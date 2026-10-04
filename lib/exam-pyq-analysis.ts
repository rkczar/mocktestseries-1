import "server-only";
import { unstable_cache } from "next/cache";
import { QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { examSubjectWhere } from "@/lib/exam-taxonomy";
import { getPublicExamBySlug } from "@/lib/exam-public";
import { displayExamName } from "@/lib/exam-display";
import { examShortName } from "@/lib/exam-editorial-facts";
import { getExamPyqInsights, type ExamPyqInsights, type PaperInsight } from "@/lib/exam-pyq-insights";

/**
 * Cross-paper, subject-level analysis of an exam's previous year papers for
 * the public Subject-Wise Weightage, Previous Year Paper Analysis and
 * Preparation Strategy pages. Built only on the answer-free aggregates of
 * lib/exam-pyq-insights.ts (published questions, canonical paper
 * membership) plus two cached lookups. Deliberately subject-level: topic
 * tags and the difficulty field are not complete enough to analyse yet.
 */

/** Every analysis page exists (and is in the sitemap) only for exams with this much real data. */
export const MIN_ANALYSIS_PAPERS = 3;
export const MIN_ANALYSIS_QUESTIONS = 300;

/** A share change counts as a trend only when it is at least this large AND significant (|z| ≥ 1.96). */
const MIN_TREND_DIFF = 0.02;
const Z_95 = 1.96;

export const EXAM_INSIGHT_PAGES = {
  weightage: "subject-wise-weightage",
  analysis: "previous-year-paper-analysis",
  strategy: "preparation-strategy",
} as const;

export function examInsightPath(slug: string, page: keyof typeof EXAM_INSIGHT_PAGES): string {
  return `/exams/${slug}/${EXAM_INSIGHT_PAGES[page]}`;
}

export function hasPyqAnalysis(insights: ExamPyqInsights): boolean {
  return insights.papers.filter((p) => p.indexable).length >= MIN_ANALYSIS_PAPERS && insights.totalQuestions >= MIN_ANALYSIS_QUESTIONS;
}

export interface SubjectTrend {
  name: string;
  olderShare: number;
  recentShare: number;
  diff: number;
  signal: "up" | "down" | "steady";
}

export interface SubjectSpread {
  name: string;
  count: number;
  share: number;
  /** Papers with at least one question from the subject. */
  papers: number;
  /** Fewest / most questions in a single paper (0 when a paper had none). */
  min: number;
  max: number;
}

export interface PeriodSummary {
  years: number[];
  questions: number;
}

export interface PyqAnalysis {
  /** Papers with questions, oldest first. */
  papers: PaperInsight[];
  totalQuestions: number;
  firstYear: number;
  lastYear: number;
  /** Years between the first and last paper with no paper on this site. */
  gapYears: number[];
  older: PeriodSummary;
  recent: PeriodSummary;
  /** Most questions first. */
  spreads: SubjectSpread[];
  trends: SubjectTrend[];
  inEveryPaper: SubjectSpread[];
  /** Subjects in fewer than half of the papers. */
  rare: SubjectSpread[];
  /** Subject(s) with the most questions in each paper, oldest paper first. */
  leaders: { year: number; names: string[]; count: number }[];
  questionsPerPaper: { min: number; max: number };
  subjectsPerPaper: { min: number; max: number };
}

function zScore(c1: number, n1: number, c2: number, n2: number): number {
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (c2 / n2 - c1 / n1) / se;
}

/**
 * Pure: derives the analysis from the PYQ insights. "Recent" is the newer
 * half of the papers (the extra paper goes to recent when the count is odd),
 * so the split adapts as papers are added instead of hard-coding a year.
 */
export function analysePyqInsights(insights: ExamPyqInsights): PyqAnalysis {
  const papers = insights.papers.filter((p) => p.questionCount > 0).sort((a, b) => a.year - b.year);
  const years = papers.map((p) => p.year);
  const firstYear = Math.min(...years);
  const lastYear = Math.max(...years);
  const present = new Set(years);
  const gapYears: number[] = [];
  for (let y = firstYear + 1; y < lastYear; y++) if (!present.has(y)) gapYears.push(y);

  const split = Math.floor(papers.length / 2);
  const olderPapers = papers.slice(0, split);
  const recentPapers = papers.slice(split);
  const sumQuestions = (ps: PaperInsight[]) => ps.reduce((sum, p) => sum + p.questionCount, 0);
  const countIn = (ps: PaperInsight[], name: string) => ps.reduce((sum, p) => sum + (p.subjects.find((s) => s.name === name)?.count ?? 0), 0);
  const olderTotal = sumQuestions(olderPapers);
  const recentTotal = sumQuestions(recentPapers);

  const spreads: SubjectSpread[] = insights.weightage.map((w) => {
    const perPaper = papers.map((p) => p.subjects.find((s) => s.name === w.name)?.count ?? 0);
    return { name: w.name, count: w.count, share: w.share, papers: w.papers, min: Math.min(...perPaper), max: Math.max(...perPaper) };
  });

  const trends: SubjectTrend[] =
    olderTotal > 0 && recentTotal > 0
      ? spreads.map((s) => {
          const c1 = countIn(olderPapers, s.name);
          const c2 = countIn(recentPapers, s.name);
          const olderShare = c1 / olderTotal;
          const recentShare = c2 / recentTotal;
          const diff = recentShare - olderShare;
          const z = zScore(c1, olderTotal, c2, recentTotal);
          const signal = Math.abs(diff) >= MIN_TREND_DIFF && Math.abs(z) >= Z_95 ? (diff > 0 ? "up" : "down") : "steady";
          return { name: s.name, olderShare, recentShare, diff, signal };
        })
      : [];

  const leaders = papers.map((p) => {
    const top = p.subjects[0]?.count ?? 0;
    return { year: p.year, names: p.subjects.filter((s) => s.count === top).map((s) => s.name), count: top };
  });

  return {
    papers,
    totalQuestions: sumQuestions(papers),
    firstYear,
    lastYear,
    gapYears,
    older: { years: olderPapers.map((p) => p.year), questions: olderTotal },
    recent: { years: recentPapers.map((p) => p.year), questions: recentTotal },
    spreads,
    trends,
    inEveryPaper: spreads.filter((s) => s.papers === papers.length),
    rare: spreads.filter((s) => s.papers < papers.length / 2),
    leaders,
    questionsPerPaper: { min: Math.min(...papers.map((p) => p.questionCount)), max: Math.max(...papers.map((p) => p.questionCount)) },
    subjectsPerPaper: { min: Math.min(...papers.map((p) => p.subjects.length)), max: Math.max(...papers.map((p) => p.subjects.length)) },
  };
}

export interface PyqAnalysisMeta {
  /** ISO time of the most recent edit to any published PYQ of the exam ("data as of"). */
  dataAsOf: string | null;
  /** Subject name → id for the exam's linked subjects (Subject Test preselect). */
  subjectIds: Record<string, string>;
}

/** Uncached — exported for scripts; pages use getPyqAnalysisMeta. */
export async function computePyqAnalysisMeta(examId: string): Promise<PyqAnalysisMeta> {
  const [latest, subjects] = await Promise.all([
    prisma.question.aggregate({
      where: { previousYearPaper: { examId, isActive: true }, status: QuestionStatus.PUBLISHED },
      _max: { updatedAt: true },
    }),
    prisma.subject.findMany({ where: examSubjectWhere(examId), select: { id: true, name: true } }),
  ]);
  return {
    dataAsOf: latest._max.updatedAt?.toISOString() ?? null,
    subjectIds: Object.fromEntries(subjects.map((s) => [s.name, s.id])),
  };
}

/** Same cache tag as the PYQ insights, so an admin PYQ edit refreshes both. */
export const getPyqAnalysisMeta = unstable_cache(computePyqAnalysisMeta, ["exam-pyq-analysis-meta"], {
  tags: ["exam-pyq-insights"],
  revalidate: 3600,
});

/** "4 October 2026" (IST). */
export function formatDataDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
}

/** "+3.1 pts" / "−2.4 pts" for a share difference. */
export function formatShareDiff(diff: number): string {
  const pts = Math.round(Math.abs(diff) * 1000) / 10;
  return `${diff >= 0 ? "+" : "−"}${pts.toFixed(1)} pts`;
}

/**
 * Everything an analysis page needs, or null when the exam isn't public or
 * hasn't enough PYQ data (the page then 404s and stays out of the sitemap).
 */
export async function loadPublicExamAnalysis(slug: string) {
  const exam = await getPublicExamBySlug(slug);
  if (!exam?.publicSlug) return null;
  const insights = await getExamPyqInsights(exam.id);
  if (!hasPyqAnalysis(insights)) return null;
  const meta = await getPyqAnalysisMeta(exam.id);
  const name = displayExamName(exam.name);
  const baseName = name.replace(/\s\d{4}$/, "");
  return {
    exam,
    slug: exam.publicSlug,
    insights,
    analysis: analysePyqInsights(insights),
    meta,
    name,
    baseName,
    short: examShortName(exam.code, baseName),
  };
}
