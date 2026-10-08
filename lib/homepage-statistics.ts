import "server-only";
import { LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import type { StatDynamicKey } from "@/lib/homepage-field-codec";

export interface HomepageStatsSnapshot {
  values: Record<StatDynamicKey, number>;
  computedAt: string;
}

/**
 * Successful student-initiated AI uses (Ask AI explanation, AI explanation
 * variants, AI question variants). Source: AI_EXPLANATION_VIEWED, which
 * app/student/ai-actions.ts writes only after a successful result — failures,
 * quota refusals and admin/background generation never write it — and which
 * includes explicit cache-served requests. A repeat of the same student +
 * question + feature within 60 s (double-click, client timeout retry) counts
 * once. Rows written before the `feature` tag fall back to student + question.
 */
export const AI_USE_DEDUPE_SECONDS = 60;
async function countStudentAiExplanationUses(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT "createdAt", lag("createdAt") OVER (
        PARTITION BY "studentId", coalesce(metadata->>'questionId', ''), coalesce(metadata->>'feature', '')
        ORDER BY "createdAt"
      ) AS prev
      FROM "StudentActivity" WHERE activity = 'AI_EXPLANATION_VIEWED'
    ) t
    WHERE prev IS NULL OR "createdAt" - prev > make_interval(secs => ${AI_USE_DEDUPE_SECONDS})`;
  return rows[0]?.n ?? 0;
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
    testsStarted,
    aiExplanationUses,
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
    // Platform-wide: every PUBLISHED question across all exams (active or not).
    // A row per Question id, so a question used by several tests counts once;
    // DRAFT / ARCHIVED never count, deleted questions no longer exist.
    prisma.question.count({ where: { status: "PUBLISHED" } }),
    // Every attempt a student started (TestAttempt is created once on Start;
    // resume/refresh reuse it), whatever its outcome.
    prisma.testAttempt.count(),
    countStudentAiExplanationUses(),
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
      testsStarted,
      aiExplanationUses,
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
