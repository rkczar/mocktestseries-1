import "server-only";
import { Prisma, type InstagramPostStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { answerKeyIssue } from "@/lib/question-insights-format";
import { plainText } from "@/lib/instagram/layout";
import { statusesFor, type QuestionStatusInfo } from "@/lib/instagram/posts";
import { stemLooksTruncated } from "@/lib/instagram/quality";
import type { SourceSnapshot } from "@/lib/instagram/types";

/** Read-only list queries for Admin → Instagram. No writes anywhere in this file. */

export interface ExamOption {
  id: string;
  name: string;
  isActive: boolean;
  paperCount: number;
}

export async function listPyqExams(): Promise<ExamOption[]> {
  const exams = await prisma.exam.findMany({
    orderBy: [{ isActive: "desc" }, { order: "asc" }, { name: "asc" }],
    select: { id: true, name: true, isActive: true, _count: { select: { previousYearPapers: true } } },
  });
  return exams.filter((e) => e._count.previousYearPapers > 0).map((e) => ({ id: e.id, name: e.name, isActive: e.isActive, paperCount: e._count.previousYearPapers }));
}

export interface PaperRow {
  id: string;
  title: string;
  year: number;
  paperCode: string | null;
  isActive: boolean;
  questionCount: number;
  posted: number;
  inProgress: number;
}

export interface YearGroup {
  year: number;
  papers: PaperRow[];
}

export async function listPapersByYear(examId: string): Promise<YearGroup[]> {
  const papers = await prisma.previousYearPaper.findMany({
    where: { examId },
    orderBy: [{ year: "desc" }, { order: "asc" }, { title: "asc" }],
    select: { id: true, title: true, year: true, paperCode: true, isActive: true, _count: { select: { questions: true } } },
  });
  const ids = papers.map((p) => p.id);
  const postCounts = ids.length
    ? await prisma.$queryRaw<{ paper_id: string; posted: number; in_progress: number }[]>`
        SELECT q."previousYearPaperId" AS paper_id,
               COUNT(DISTINCT ip."questionId") FILTER (WHERE ip.status = 'PUBLISHED')::int AS posted,
               COUNT(DISTINCT ip."questionId") FILTER (WHERE ip."supersededAt" IS NULL AND ip.status IN ('DRAFT','READY','FAILED'))::int AS in_progress
        FROM "InstagramPost" ip JOIN "Question" q ON q.id = ip."questionId"
        WHERE q."previousYearPaperId" IN (${Prisma.join(ids)})
        GROUP BY 1`
    : [];
  const counts = new Map(postCounts.map((c) => [c.paper_id, c]));
  const groups = new Map<number, PaperRow[]>();
  for (const p of papers) {
    const c = counts.get(p.id);
    const row: PaperRow = {
      id: p.id,
      title: p.title.trim(),
      year: p.year,
      paperCode: p.paperCode,
      isActive: p.isActive,
      questionCount: p._count.questions,
      posted: c?.posted ?? 0,
      inProgress: c?.in_progress ?? 0,
    };
    groups.set(p.year, [...(groups.get(p.year) ?? []), row]);
  }
  return [...groups.entries()].map(([year, list]) => ({ year, papers: list }));
}

export type ContentReview = "OK" | "CHECK_TEXT" | "ANSWER_KEY" | "HAS_IMAGE" | "QB_REVIEW";

export interface PaperQuestionRow {
  id: string;
  /** Stored order (createdAt, code — the PYQ test order). Not the printed question number. */
  position: number;
  code: string;
  preview: string;
  subject: string;
  topic: string | null;
  qbStatus: string;
  reviewRequired: boolean;
  reviewReason: string | null;
  flags: ContentReview[];
  aiExplanation: "NONE" | "UNREVIEWED" | "REVIEWED" | "STALE";
  instagram: QuestionStatusInfo;
}

export interface PaperDetail {
  id: string;
  title: string;
  year: number;
  paperCode: string | null;
  examId: string;
  examName: string;
  questions: PaperQuestionRow[];
}

function preview(text: string): string {
  const s = plainText(text);
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export async function getPaperDetail(paperId: string): Promise<PaperDetail | null> {
  const paper = await prisma.previousYearPaper.findUnique({
    where: { id: paperId },
    select: { id: true, title: true, year: true, paperCode: true, examId: true, exam: { select: { name: true } } },
  });
  if (!paper) return null;
  const questions = await prisma.question.findMany({
    where: { previousYearPaperId: paperId },
    // Same order the PYQ test engine serves (lib/test-attempt.ts).
    orderBy: [{ createdAt: "asc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      text: true,
      status: true,
      questionType: true,
      reviewRequired: true,
      reviewReason: true,
      imageUrl: true,
      subject: { select: { name: true } },
      topic: { select: { name: true } },
      options: { select: { isCorrect: true, imageUrl: true } },
      _count: { select: { assets: true } },
      aiExplanation: { select: { status: true, isStale: true, adminReviewedAt: true } },
    },
  });
  const statuses = await statusesFor(questions.map((q) => q.id));
  return {
    id: paper.id,
    title: paper.title.trim(),
    year: paper.year,
    paperCode: paper.paperCode,
    examId: paper.examId,
    examName: paper.exam.name,
    questions: questions.map((q, i) => {
      const flags: ContentReview[] = [];
      if (stemLooksTruncated(q.text)) flags.push("CHECK_TEXT");
      if (answerKeyIssue(q.options, q.questionType)) flags.push("ANSWER_KEY");
      if (q.imageUrl || q.options.some((o) => o.imageUrl) || q._count.assets > 0) flags.push("HAS_IMAGE");
      if (q.reviewRequired) flags.push("QB_REVIEW");
      const ax = q.aiExplanation;
      return {
        id: q.id,
        position: i + 1,
        code: q.code,
        preview: preview(q.text),
        subject: q.subject.name,
        topic: q.topic?.name ?? null,
        qbStatus: q.status,
        reviewRequired: q.reviewRequired,
        reviewReason: q.reviewReason,
        flags,
        aiExplanation: !ax || ax.status !== "COMPLETED" ? "NONE" : ax.isStale ? "STALE" : ax.adminReviewedAt ? "REVIEWED" : "UNREVIEWED",
        instagram: statuses.get(q.id)!,
      };
    }),
  };
}

export interface PostListRow {
  id: string;
  questionId: string;
  questionCode: string;
  series: "PYQ" | "MOST_MISSED";
  version: number;
  status: InstagramPostStatus;
  preview: string;
  examName: string;
  paperLabel: string | null;
  updatedAt: string;
  reviewedAt: string | null;
  publishedAt: string | null;
  igPermalink: string | null;
  igMediaId: string | null;
  publishError: string | null;
  isCurrent: boolean;
}

function toListRow(p: { id: string; questionId: string; questionCode: string; series: "PYQ" | "MOST_MISSED"; version: number; status: InstagramPostStatus; sourceSnapshot: unknown; updatedAt: Date; reviewedAt: Date | null; publishedAt: Date | null; igPermalink: string | null; igMediaId: string | null; publishError: string | null; supersededAt: Date | null }): PostListRow {
  const s = p.sourceSnapshot as SourceSnapshot;
  return {
    id: p.id,
    questionId: p.questionId,
    questionCode: p.questionCode,
    series: p.series,
    version: p.version,
    status: p.status,
    preview: preview(s.text ?? ""),
    examName: s.examName,
    paperLabel: s.paperYear ? `${s.paperYear}${s.paperSharesYear && s.paperTitle ? ` · ${s.paperTitle}` : ""}` : null,
    updatedAt: p.updatedAt.toISOString(),
    reviewedAt: p.reviewedAt?.toISOString() ?? null,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    igPermalink: p.igPermalink,
    igMediaId: p.igMediaId,
    publishError: p.publishError,
    isCurrent: p.supersededAt === null,
  };
}

const listSelect = {
  id: true,
  questionId: true,
  questionCode: true,
  series: true,
  version: true,
  status: true,
  sourceSnapshot: true,
  updatedAt: true,
  reviewedAt: true,
  publishedAt: true,
  igPermalink: true,
  igMediaId: true,
  publishError: true,
  supersededAt: true,
} as const;

export async function listDrafts(): Promise<PostListRow[]> {
  const rows = await prisma.instagramPost.findMany({
    where: { supersededAt: null, status: { in: ["DRAFT", "READY", "FAILED"] } },
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: listSelect,
  });
  return rows.map(toListRow);
}

export async function listHistory(): Promise<PostListRow[]> {
  const rows = await prisma.instagramPost.findMany({ orderBy: { updatedAt: "desc" }, take: 300, select: listSelect });
  return rows.map(toListRow);
}

/** Published History: everything that is on Instagram (newest first), plus posts being published or failed. */
export async function listPublishActivity(): Promise<{ published: PostListRow[]; active: PostListRow[] }> {
  const [published, active] = await Promise.all([
    prisma.instagramPost.findMany({ where: { status: "PUBLISHED" }, orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }], take: 300, select: listSelect }),
    prisma.instagramPost.findMany({ where: { status: { in: ["PUBLISHING", "FAILED"] } }, orderBy: { updatedAt: "desc" }, take: 100, select: listSelect }),
  ]);
  return { published: published.map(toListRow), active: active.map(toListRow) };
}

export async function studioCounts(): Promise<Record<"DRAFT" | "READY" | "PUBLISHED" | "FAILED", number>> {
  const rows = await prisma.instagramPost.groupBy({ by: ["status"], where: { supersededAt: null }, _count: true });
  const published = await prisma.instagramPost.count({ where: { status: "PUBLISHED" } });
  const get = (s: InstagramPostStatus) => rows.find((r) => r.status === s)?._count ?? 0;
  return { DRAFT: get("DRAFT"), READY: get("READY"), PUBLISHED: published, FAILED: get("FAILED") };
}
