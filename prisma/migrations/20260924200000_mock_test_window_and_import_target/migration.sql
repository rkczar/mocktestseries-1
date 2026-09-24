-- Additive only: Mock Test fixed window / result release / leaderboard
-- toggle, and a Mock Test target on Bulk Import runs. No drops, no
-- rewrites — every existing row keeps its current behavior via defaults
-- (availableUntil NULL = never closes, IMMEDIATE results, leaderboard on).

-- CreateEnum
CREATE TYPE "MockResultRelease" AS ENUM ('IMMEDIATE', 'AFTER_WINDOW', 'CUSTOM_DATE');

-- CreateEnum
CREATE TYPE "BulkImportSource" AS ENUM ('QUESTION_BANK', 'MOCK_TEST');

-- AlterTable
ALTER TABLE "BulkImportRun" ADD COLUMN     "attachedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "importSource" "BulkImportSource" NOT NULL DEFAULT 'QUESTION_BANK',
ADD COLUMN     "mockTestId" TEXT;

-- AlterTable
ALTER TABLE "MockTest" ADD COLUMN     "availableUntil" TIMESTAMP(3),
ADD COLUMN     "leaderboardEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "resultReleaseAt" TIMESTAMP(3),
ADD COLUMN     "resultReleaseMode" "MockResultRelease" NOT NULL DEFAULT 'IMMEDIATE';

-- CreateIndex
CREATE INDEX "BulkImportRun_mockTestId_idx" ON "BulkImportRun"("mockTestId");

-- AddForeignKey
ALTER TABLE "BulkImportRun" ADD CONSTRAINT "BulkImportRun_mockTestId_fkey" FOREIGN KEY ("mockTestId") REFERENCES "MockTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
