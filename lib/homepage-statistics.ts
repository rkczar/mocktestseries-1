import "server-only";
import { LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { StatDynamicKey } from "@/lib/homepage-field-codec";

export interface HomepageStatsSnapshot {
  values: Record<StatDynamicKey, number>;
  computedAt: string;
}

/** Uncached aggregation — exported for scripts/verify-homepage-stats.ts; pages use getHomepageStatistics. */
export async function computeHomepageStatistics(): Promise<HomepageStatsSnapshot> {
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
    mockTestsPublished,
    testsCompleted,
    questionsAvailable,
  ] = await Promise.all([
    prisma.answer.count({ where: { status: { in: ["ANSWERED", "ANSWERED_AND_MARKED"] } } }),
    prisma.aIExplanation.count(),
    prisma.exam.count({ where: { isActive: true } }),
    prisma.testSeries.count({ where: { isActive: true } }),
    prisma.question.count({ where: { status: "PUBLISHED" } }),
    // Deleted accounts are anonymized tombstones (lib/student-lifecycle.ts), not students.
    prisma.student.count({ where: { status: { not: "DELETED" } } }),
    prisma.student.count({ where: { status: "ACTIVE" } }),
    prisma.testAttempt.count({ where: { sourceType: "MOCK_TEST", status: "SUBMITTED" } }),
    prisma.previousYearPaper.count({ where: { isActive: true } }),
    prisma.mockTest.count({ where: LIVE_MOCK_TEST_WHERE }),
    // Every successfully submitted attempt, across all test types.
    prisma.testAttempt.count({ where: { status: "SUBMITTED" } }),
    // What a student can actually practise: published questions of exams that are live.
    prisma.question.count({ where: { status: "PUBLISHED", exam: { isActive: true } } }),
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
      mockTestsPublished,
      testsCompleted,
      questionsAvailable,
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
