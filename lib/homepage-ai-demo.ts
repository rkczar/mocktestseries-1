import "server-only";
import { prisma } from "@/lib/prisma";
import { getAiSettings, HOMEPAGE_DEMO_MAX } from "@/lib/ai-settings";
import type { ExplanationContent } from "@/lib/ai-explanation";

export interface AiDemoQuestion {
  questionId: string;
  code: string;
  text: string;
  options: { label: string; text: string; isCorrect: boolean }[];
  content: ExplanationContent;
}

const ELIGIBLE_WHERE = { status: "COMPLETED" as const, adminReviewedAt: { not: null }, isStale: false };

/**
 * Questions for the public homepage "Ask AI in Action" demo. Only ever reads
 * AIExplanation rows that are COMPLETED, admin-reviewed, and non-stale —
 * this function never calls an AI provider, so an anonymous homepage
 * visitor can never trigger live generation (Section: Homepage AI Demo).
 * Prefers the admin-curated ai.settings.homepageDemoQuestionIds list (in the
 * order the admin picked, filtered back down to still-eligible ones);
 * falls back to auto-selecting the most recently reviewed eligible
 * explanations when nothing is curated. Always capped at HOMEPAGE_DEMO_MAX
 * regardless of what's stored.
 */
export async function getHomepageAiDemoQuestions(): Promise<AiDemoQuestion[]> {
  const settings = await getAiSettings();
  if (!settings.homepageDemoEnabled) return [];

  const curatedIds = settings.homepageDemoQuestionIds.slice(0, HOMEPAGE_DEMO_MAX);

  const includeQuestion = {
    content: true,
    questionId: true,
    question: { select: { code: true, text: true, options: { orderBy: { order: "asc" as const } } } },
  };

  let rows;
  if (curatedIds.length > 0) {
    rows = await prisma.aIExplanation.findMany({
      where: { ...ELIGIBLE_WHERE, questionId: { in: curatedIds } },
      select: includeQuestion,
    });
    const byId = new Map(rows.map((r) => [r.questionId, r]));
    rows = curatedIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  } else {
    const take = Math.min(HOMEPAGE_DEMO_MAX, Math.max(0, settings.homepageDemoMaxQuestions));
    rows = await prisma.aIExplanation.findMany({
      where: ELIGIBLE_WHERE,
      orderBy: { adminReviewedAt: "desc" },
      take,
      select: includeQuestion,
    });
  }

  return rows.slice(0, HOMEPAGE_DEMO_MAX).map((r) => ({
    questionId: r.questionId,
    code: r.question.code,
    text: r.question.text,
    options: r.question.options.map((o) => ({ label: o.label, text: o.text, isCorrect: o.isCorrect })),
    content: r.content as unknown as ExplanationContent,
  }));
}
