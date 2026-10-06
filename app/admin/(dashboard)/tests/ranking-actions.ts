"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import { clearOverallRankingCache } from "@/lib/leaderboard";

export interface RankingFormState {
  error?: string;
  success?: boolean;
}

/**
 * Ranking & Leaderboard settings for one Mock Test or Previous Year Paper
 * (TestRankingConfig). TEST_SERIES_MANAGE (MASTER_ADMIN) for both kinds —
 * not EXAMS_MANAGE, which TEACHER holds. A Previous Year Paper can never
 * count toward Overall Rank: the posted value is ignored here and the DB
 * CHECK constraint refuses it anyway. For a Mock Test the legacy
 * MockTest.leaderboardEnabled column is kept in step so a rollback to the
 * pre-ranking release shows the same leaderboard state.
 */
export async function updateTestRankingAction(
  kind: "MOCK_TEST" | "PREVIOUS_YEAR_PAPER",
  testId: string,
  _prev: RankingFormState,
  formData: FormData
): Promise<RankingFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  if (kind !== "MOCK_TEST" && kind !== "PREVIOUS_YEAR_PAPER") return { error: "Invalid test type." };
  const leaderboardEnabled = formData.get("leaderboardEnabled") === "on";
  const countsTowardOverall = kind === "MOCK_TEST" && formData.get("countsTowardOverall") === "on";

  if (kind === "MOCK_TEST") {
    const mock = await prisma.mockTest.findUnique({ where: { id: testId }, select: { id: true } });
    if (!mock) return { error: "Mock test not found." };
    await prisma.$transaction([
      prisma.testRankingConfig.upsert({
        where: { mockTestId: testId },
        create: { kind, mockTestId: testId, leaderboardEnabled, countsTowardOverall, updatedByAdminId: session.user.id },
        update: { leaderboardEnabled, countsTowardOverall, updatedByAdminId: session.user.id },
      }),
      prisma.mockTest.update({ where: { id: testId }, data: { leaderboardEnabled } }),
    ]);
  } else {
    const paper = await prisma.previousYearPaper.findUnique({ where: { id: testId }, select: { id: true } });
    if (!paper) return { error: "Paper not found." };
    await prisma.testRankingConfig.upsert({
      where: { previousYearPaperId: testId },
      create: { kind, previousYearPaperId: testId, leaderboardEnabled, countsTowardOverall: false, updatedByAdminId: session.user.id },
      update: { leaderboardEnabled, updatedByAdminId: session.user.id },
    });
  }

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "TEST_RANKING_UPDATED",
      entityType: kind === "MOCK_TEST" ? "MockTest" : "PreviousYearPaper",
      entityId: testId,
      metadata: { leaderboardEnabled, countsTowardOverall },
    },
  });

  // Overall Rank memo: this process now; other instances within OVERALL_CACHE_MS.
  clearOverallRankingCache();
  if (kind === "MOCK_TEST") revalidateMockSeriesSurfaces(`/admin/tests/mock/${testId}`, "/student/analytics");
  else revalidatePath(`/admin/exams/previous-year-papers/${testId}`);
  return { success: true };
}
