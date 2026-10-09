import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { SourceSnapshot } from "@/lib/instagram/types";

/**
 * Read-only access to the Question Bank for the Instagram studio. These are
 * the ONLY Question/Option/Paper reads the studio performs, and none of them
 * writes: a draft stores a frozen copy (SourceSnapshot) plus a hash, and the
 * hash is re-checked against the live row before a draft can become Ready.
 */

const questionSelect = {
  id: true,
  code: true,
  text: true,
  contentFormat: true,
  questionType: true,
  status: true,
  reviewRequired: true,
  reviewReason: true,
  imageUrl: true,
  createdAt: true,
  previousYearPaperId: true,
  options: { orderBy: [{ order: "asc" as const }, { label: "asc" as const }], select: { label: true, text: true, isCorrect: true, imageUrl: true } },
  _count: { select: { assets: true } },
  exam: { select: { id: true, name: true, code: true } },
  subject: { select: { name: true } },
  topic: { select: { name: true } },
  previousYearPaper: { select: { id: true, title: true, year: true, paperCode: true, examId: true } },
  aiExplanation: { select: { status: true, isStale: true, adminReviewedAt: true, content: true } },
};

type LoadedQuestion = NonNullable<Awaited<ReturnType<typeof loadQuestion>>>;

async function loadQuestion(questionId: string) {
  return prisma.question.findUnique({ where: { id: questionId }, select: questionSelect });
}

/** Hash of everything a published post states about the question. */
export function hashSource(q: { text: string; options: { label: string; text: string; isCorrect: boolean }[]; paperId: string | null; examName: string; paperYear: number | null; paperTitle: string | null }): string {
  const canonical = JSON.stringify({
    t: q.text,
    o: q.options.map((o) => [o.label, o.text, o.isCorrect]),
    p: q.paperId,
    e: q.examName,
    y: q.paperYear,
    pt: q.paperTitle,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/** Position of the question in its paper's stored order — the same order the PYQ test serves (lib/test-attempt.ts). */
async function importPosition(q: LoadedQuestion): Promise<number | null> {
  if (!q.previousYearPaperId) return null;
  const rows = await prisma.$queryRaw<{ pos: number }[]>`
    SELECT COUNT(*)::int AS pos FROM "Question"
    WHERE "previousYearPaperId" = ${q.previousYearPaperId}
      AND ("createdAt" < ${q.createdAt} OR ("createdAt" = ${q.createdAt} AND code <= ${q.code}))`;
  return rows[0]?.pos ?? null;
}

export async function buildSnapshot(questionId: string): Promise<{ snapshot: SourceSnapshot; hash: string; aiReference: AiReference | null } | null> {
  const q = await loadQuestion(questionId);
  if (!q) return null;
  const paper = q.previousYearPaper;
  const sameYear = paper ? await prisma.previousYearPaper.count({ where: { examId: paper.examId, year: paper.year } }) : 0;
  const snapshot: SourceSnapshot = {
    questionId: q.id,
    code: q.code,
    text: q.text,
    contentFormat: q.contentFormat,
    questionType: q.questionType,
    options: q.options.map((o) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect })),
    examId: q.exam.id,
    examName: q.exam.name,
    examCode: q.exam.code,
    paperId: paper?.id ?? null,
    paperTitle: paper?.title.trim() ?? null,
    paperYear: paper?.year ?? null,
    paperCode: paper?.paperCode ?? null,
    paperSharesYear: sameYear > 1,
    importPosition: await importPosition(q),
    subjectName: q.subject.name,
    topicName: q.topic?.name ?? null,
    hasImages: Boolean(q.imageUrl) || q.options.some((o) => Boolean(o.imageUrl)) || q._count.assets > 0,
    status: q.status,
    reviewRequired: q.reviewRequired,
    reviewReason: q.reviewReason,
    aiExplanation: q.aiExplanation
      ? { status: q.aiExplanation.status, isStale: q.aiExplanation.isStale, reviewed: Boolean(q.aiExplanation.adminReviewedAt) }
      : null,
    capturedAt: new Date().toISOString(),
  };
  return { snapshot, hash: hashOf(snapshot), aiReference: aiReferenceOf(q) };
}

export function hashOf(s: Pick<SourceSnapshot, "text" | "options" | "paperId" | "examName" | "paperYear" | "paperTitle">): string {
  return hashSource({ text: s.text, options: s.options, paperId: s.paperId, examName: s.examName, paperYear: s.paperYear, paperTitle: s.paperTitle });
}

/** Current hash of the live question (null = deleted). */
export async function currentSourceHash(questionId: string): Promise<string | null> {
  const q = await prisma.question.findUnique({
    where: { id: questionId },
    select: {
      text: true,
      options: { orderBy: [{ order: "asc" }, { label: "asc" }], select: { label: true, text: true, isCorrect: true } },
      exam: { select: { name: true } },
      previousYearPaper: { select: { id: true, year: true, title: true } },
    },
  });
  if (!q) return null;
  return hashSource({
    text: q.text,
    options: q.options,
    paperId: q.previousYearPaper?.id ?? null,
    examName: q.exam.name,
    paperYear: q.previousYearPaper?.year ?? null,
    paperTitle: q.previousYearPaper?.title.trim() ?? null,
  });
}

export interface AiReference {
  concept?: string;
  memoryTrick?: string;
  pointsToRemember?: string[];
  reviewed: boolean;
  isStale: boolean;
}

function aiReferenceOf(q: LoadedQuestion): AiReference | null {
  const ax = q.aiExplanation;
  if (!ax || ax.status !== "COMPLETED") return null;
  const c = (ax.content ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    concept: s(c.concept),
    memoryTrick: s(c.memoryTrick),
    pointsToRemember: Array.isArray(c.pointsToRemember) ? c.pointsToRemember.filter((x): x is string => typeof x === "string").slice(0, 5) : [],
    reviewed: Boolean(ax.adminReviewedAt),
    isStale: ax.isStale,
  };
}

export async function getAiReference(questionId: string): Promise<AiReference | null> {
  const q = await loadQuestion(questionId);
  return q ? aiReferenceOf(q) : null;
}
