import "server-only";
import type { Prisma, QuestionDifficulty } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { answerKeyIssue } from "@/lib/question-insights-format";
import { plainText } from "@/lib/instagram/layout";
import { stemLooksTruncated } from "@/lib/instagram/quality";
import { statusesFor, type QuestionStatusInfo } from "@/lib/instagram/posts";
import { eligibleExamIds } from "@/lib/instagram/scope";
import { getMostMissed, parseMostMissedFilters } from "@/lib/instagram/most-missed";
import { listPublishedPerformance } from "@/lib/instagram/metrics";
import { getTrendEvidence } from "@/lib/instagram/trends";

/**
 * Smart Question Selection for Instagram (Bulk Studio and the selector).
 * Candidates are previous-year-paper questions of in-scope exams. Each gets a
 * transparent Content Opportunity Score (0–100) whose every point is explained:
 * exam relevance, educational value, difficulty (real wrong-answer rates when
 * available), trend evidence and our own past Instagram performance. It ranks
 * what to post next; it is not a prediction of reach or virality.
 */

export interface SelectionFilters {
  examId: string;
  subjectId?: string;
  topicId?: string;
  year?: number;
  difficulty?: QuestionDifficulty;
  mostMissed?: boolean;
  published?: "unpublished" | "published" | "any";
  limit?: number;
}

export interface ScorePart {
  label: string;
  points: number;
  max: number;
  why: string;
}

export interface Candidate {
  id: string;
  code: string;
  preview: string;
  examName: string;
  subject: string;
  topic: string | null;
  year: number | null;
  paperTitle: string | null;
  difficulty: QuestionDifficulty;
  wrongPct: number | null;
  attempts: number | null;
  blockers: string[];
  instagram: QuestionStatusInfo;
  score: number;
  parts: ScorePart[];
}

export const SCORE_DISCLAIMER = "The Content Opportunity Score ranks questions by the evidence we have. It is not a guarantee of reach, engagement or virality.";

export async function selectCandidates(f: SelectionFilters): Promise<{ candidates: Candidate[]; evidenceCount: number; perfPosts: number }> {
  const scope = await eligibleExamIds();
  if (!scope.has(f.examId)) return { candidates: [], evidenceCount: 0, perfPosts: 0 };

  const where: Prisma.QuestionWhereInput = {
    examId: f.examId,
    status: "PUBLISHED",
    previousYearPaperId: { not: null },
    parentQuestionId: null,
    ...(f.subjectId ? { subjectId: f.subjectId } : {}),
    ...(f.topicId ? { topicId: f.topicId } : {}),
    ...(f.difficulty ? { difficulty: f.difficulty } : {}),
    ...(f.year ? { previousYearPaper: { year: f.year } } : {}),
  };

  // Real wrong-answer rates (last 7 days) from Question Insights.
  const missed = new Map<string, { wrongPct: number; attempts: number }>();
  try {
    const mm = await getMostMissed(parseMostMissedFilters({ range: "7d", examId: f.examId, min: "5" }));
    for (const r of mm.rows) missed.set(r.id, { wrongPct: r.wrongPct, attempts: r.attempts });
  } catch {
    // no insights → difficulty falls back to the stored difficulty level
  }
  if (f.mostMissed) where.id = { in: [...missed.keys()] };

  const rows = await prisma.question.findMany({
    where,
    take: 400,
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      code: true,
      text: true,
      difficulty: true,
      questionType: true,
      imageUrl: true,
      reviewRequired: true,
      exam: { select: { name: true } },
      subject: { select: { name: true } },
      topic: { select: { name: true } },
      previousYearPaper: { select: { year: true, title: true } },
      options: { select: { isCorrect: true, imageUrl: true } },
      _count: { select: { assets: true } },
      aiExplanation: { select: { status: true, isStale: true, adminReviewedAt: true } },
    },
  });
  const statuses = await statusesFor(rows.map((r) => r.id));
  const evidence = await getTrendEvidence({ examId: f.examId, limit: 60 });
  const perf = (await listPublishedPerformance()).filter((p) => p.engagement !== null);
  const overall = perf.length ? perf.reduce((a, p) => a + (p.engagement ?? 0), 0) / perf.length : null;

  const out: Candidate[] = [];
  for (const q of rows) {
    const ig = statuses.get(q.id)!;
    if (f.published === "unpublished" && ig.posted) continue;
    if (f.published === "published" && !ig.posted) continue;
    const blockers: string[] = [];
    if (q.imageUrl || q.options.some((o) => o.imageUrl) || q._count.assets > 0) blockers.push("Has images (slides can't show them)");
    if (answerKeyIssue(q.options, q.questionType)) blockers.push("Answer key problem");
    if (stemLooksTruncated(q.text)) blockers.push("Text may be cut off");
    if (q.questionType === "MATCH_THE_FOLLOWING") blockers.push("Match the Following not supported");

    const parts: ScorePart[] = [];
    parts.push({ label: "Exam relevance", points: 20, max: 20, why: `${q.exam.name} is in Instagram Studio's exam scope (previous-year paper ${q.previousYearPaper?.year ?? ""}).` });
    const ax = q.aiExplanation;
    const edu = (ax?.status === "COMPLETED" && !ax.isStale ? (ax.adminReviewedAt ? 15 : 8) : 0) + (q.topic ? 5 : 0) + (blockers.length ? 0 : 5);
    parts.push({
      label: "Educational value",
      points: edu,
      max: 25,
      why: [ax?.status === "COMPLETED" ? (ax.adminReviewedAt ? "reviewed AI explanation exists" : "AI explanation exists (not reviewed)") : "no AI explanation yet", q.topic ? "topic tagged" : "no topic", blockers.length ? "has blockers" : "slide-ready"].join(", "),
    });
    const m = missed.get(q.id);
    const diff = m ? (m.wrongPct >= 50 ? 20 : m.wrongPct >= 30 ? 14 : 8) : q.difficulty === "HARD" ? 16 : q.difficulty === "MEDIUM" ? 12 : 6;
    parts.push({ label: "Difficulty", points: diff, max: 20, why: m ? `${Math.round(m.wrongPct)}% of ${m.attempts} answers were wrong on MockTestSeries (last 7 days).` : `Stored difficulty: ${q.difficulty.toLowerCase()} (no recent answer data).` });
    const needles = [q.topic?.name, q.subject.name].filter(Boolean).map((x) => x!.toLowerCase());
    const hits = evidence.filter((e) => e.kind !== "OWN_PERFORMANCE" && needles.some((n) => e.summary.toLowerCase().includes(n)));
    parts.push({ label: "Trend evidence", points: Math.min(20, hits.length * 7), max: 20, why: hits.length ? `${hits.length} evidence item(s) mention ${q.topic?.name ?? q.subject.name}.` : "No trend evidence mentions this topic." });
    const same = perf.filter((p) => (q.topic && p.topic === q.topic.name) || p.subject === q.subject.name);
    let perfPts = 5;
    let perfWhy = "No performance data for this subject/topic yet (neutral).";
    if (same.length && overall !== null) {
      const a = same.reduce((x, p) => x + (p.engagement ?? 0), 0) / same.length;
      perfPts = a > overall * 1.1 ? 15 : a >= overall * 0.9 ? 8 : 2;
      perfWhy = `Our ${same.length} post(s) on this ${q.topic && same.some((p) => p.topic === q.topic!.name) ? "topic" : "subject"} averaged ${a.toFixed(1)}% engagement vs ${overall.toFixed(1)}% overall.`;
    }
    parts.push({ label: "Previous Instagram performance", points: perfPts, max: 15, why: perfWhy });
    const text = plainText(q.text);
    out.push({
      id: q.id,
      code: q.code,
      preview: text.length > 160 ? `${text.slice(0, 157)}…` : text,
      examName: q.exam.name,
      subject: q.subject.name,
      topic: q.topic?.name ?? null,
      year: q.previousYearPaper?.year ?? null,
      paperTitle: q.previousYearPaper?.title ?? null,
      difficulty: q.difficulty,
      wrongPct: m?.wrongPct ?? null,
      attempts: m?.attempts ?? null,
      blockers,
      instagram: ig,
      score: Math.max(0, parts.reduce((a, p) => a + p.points, 0) - (blockers.length ? 30 : 0)),
      parts,
    });
  }
  out.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return { candidates: out.slice(0, Math.min(100, f.limit ?? 50)), evidenceCount: evidence.length, perfPosts: perf.length };
}

export async function selectionFilterOptions(examId: string | null) {
  const scope = await eligibleExamIds();
  const exams = await prisma.exam.findMany({ where: { id: { in: [...scope] } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const active = examId && scope.has(examId) ? examId : (exams[0]?.id ?? null);
  if (!active) return { exams, examId: null, subjects: [], topics: [], years: [] as number[] };
  const [subjects, topics, papers] = await Promise.all([
    prisma.subject.findMany({ where: { questions: { some: { examId: active, previousYearPaperId: { not: null } } } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.topic.findMany({ where: { questions: { some: { examId: active, previousYearPaperId: { not: null } } } }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 300 }),
    prisma.previousYearPaper.findMany({ where: { examId: active }, select: { year: true }, distinct: ["year"], orderBy: { year: "desc" } }),
  ]);
  return { exams, examId: active, subjects, topics, years: papers.map((p) => p.year) };
}
