-- Ranking & Leaderboard Phase 1. Purely additive: one enum, one new table,
-- its constraints, and two plain indexes on TestAttempt. No existing column
-- is altered and no TestAttempt / Answer / MockTest / PreviousYearPaper row
-- is updated. Ranks are derived on read (lib/leaderboard.ts), never stored.

-- CreateEnum
CREATE TYPE "RankingTestKind" AS ENUM ('MOCK_TEST', 'PREVIOUS_YEAR_PAPER');

-- CreateTable
CREATE TABLE "TestRankingConfig" (
    "id" TEXT NOT NULL,
    "kind" "RankingTestKind" NOT NULL,
    "mockTestId" TEXT,
    "previousYearPaperId" TEXT,
    "leaderboardEnabled" BOOLEAN NOT NULL DEFAULT true,
    "countsTowardOverall" BOOLEAN NOT NULL DEFAULT false,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestRankingConfig_pkey" PRIMARY KEY ("id"),
    -- Exactly one target, matching kind. A Previous Year Paper never counts
    -- toward Overall Rank, enforced by the database, not only by the UI.
    CONSTRAINT "TestRankingConfig_target_check" CHECK (
        ("kind" = 'MOCK_TEST' AND "mockTestId" IS NOT NULL AND "previousYearPaperId" IS NULL)
        OR ("kind" = 'PREVIOUS_YEAR_PAPER' AND "previousYearPaperId" IS NOT NULL AND "mockTestId" IS NULL AND "countsTowardOverall" = false)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "TestRankingConfig_mockTestId_key" ON "TestRankingConfig"("mockTestId");

-- CreateIndex
CREATE UNIQUE INDEX "TestRankingConfig_previousYearPaperId_key" ON "TestRankingConfig"("previousYearPaperId");

-- CreateIndex (ranking: one test's attempts per student in start order)
CREATE INDEX "TestAttempt_mockTestId_studentId_startedAt_idx" ON "TestAttempt"("mockTestId", "studentId", "startedAt");

-- CreateIndex
CREATE INDEX "TestAttempt_previousYearPaperId_studentId_startedAt_idx" ON "TestAttempt"("previousYearPaperId", "studentId", "startedAt");

-- AddForeignKey
ALTER TABLE "TestRankingConfig" ADD CONSTRAINT "TestRankingConfig_mockTestId_fkey" FOREIGN KEY ("mockTestId") REFERENCES "MockTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRankingConfig" ADD CONSTRAINT "TestRankingConfig_previousYearPaperId_fkey" FOREIGN KEY ("previousYearPaperId") REFERENCES "PreviousYearPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry over the existing per-mock switch (MockTest.leaderboardEnabled) so no
-- mock changes visibility. Inserts into the NEW table only.
INSERT INTO "TestRankingConfig" ("id", "kind", "mockTestId", "leaderboardEnabled", "countsTowardOverall", "updatedAt")
SELECT 'trc_' || md5(m."id"), 'MOCK_TEST', m."id", m."leaderboardEnabled", false, CURRENT_TIMESTAMP
FROM "MockTest" m
WHERE m."leaderboardEnabled" = false;
