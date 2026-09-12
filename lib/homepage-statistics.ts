import "server-only";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { StatDynamicKey } from "@/lib/homepage-field-codec";

export interface HomepageStatsSnapshot {
  values: Record<StatDynamicKey, number>;
  computedAt: string;
}

async function computeHomepageStatistics(): Promise<HomepageStatsSnapshot> {
  const [
    questionsAnswered,
    aiExplanations,
    examsActive,
    testSeriesCount,
    questionBank,
    registeredStudents,
    activeStudents,
    mockTestsAttempted,
    previousYearPapers,
  ] = await Promise.all([
    prisma.answer.count({ where: { status: { in: ["ANSWERED", "ANSWERED_AND_MARKED"] } } }),
    prisma.aIExplanation.count(),
    prisma.exam.count({ where: { isActive: true } }),
    prisma.testSeries.count({ where: { isActive: true } }),
    prisma.question.count({ where: { status: "PUBLISHED" } }),
    prisma.student.count(),
    prisma.student.count({ where: { status: "ACTIVE" } }),
    prisma.testAttempt.count({ where: { sourceType: "MOCK_TEST", status: "SUBMITTED" } }),
    prisma.previousYearPaper.count({ where: { isActive: true } }),
  ]);

  return {
    values: {
      questionsAnswered,
      aiExplanations,
      examsActive,
      testSeriesCount,
      questionBank,
      registeredStudents,
      activeStudents,
      mockTestsAttempted,
      previousYearPapers,
    },
    computedAt: new Date().toISOString(),
  };
}

/**
 * Single cached aggregation for every homepage statistic (Section 21) — one
 * batched query set instead of one query per card, revalidated on a 5-minute
 * timer or on demand via refreshHomepageStatisticsAction's revalidateTag.
 */
export const getHomepageStatistics = unstable_cache(computeHomepageStatistics, ["homepage-statistics"], {
  tags: ["homepage-statistics"],
  revalidate: 300,
});
