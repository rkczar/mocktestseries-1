-- CreateEnum
CREATE TYPE "TestSeriesStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AttemptPolicy" AS ENUM ('SINGLE_ATTEMPT', 'MULTIPLE_PRACTICE');

-- CreateEnum
CREATE TYPE "TestResourceType" AS ENUM ('PAPER_PDF', 'SOLUTION_PDF', 'OMR_TEMPLATE');

-- CreateEnum
CREATE TYPE "ResourceReleasePolicy" AS ENUM ('AFTER_AVAILABLE_FROM', 'AFTER_SUBMISSION', 'CUSTOM_DATE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AttemptEntryMode" AS ENUM ('ONLINE', 'OFFLINE_OMR_ENTRY');

-- AlterTable
ALTER TABLE "MockTest" ADD COLUMN     "attemptPolicy" "AttemptPolicy" NOT NULL DEFAULT 'MULTIPLE_PRACTICE',
ADD COLUMN     "availableFrom" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN     "entryMode" "AttemptEntryMode" NOT NULL DEFAULT 'ONLINE',
ADD COLUMN     "isLeaderboardAttempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TestSeries" ADD COLUMN     "coverImageUrl" TEXT,
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "status" "TestSeriesStatus" NOT NULL DEFAULT 'DRAFT';

-- DataMigration: backfill TestSeries.status from the existing isActive flag so
-- nothing currently live on the homepage (isActive = true) disappears from
-- the new Test Series Control Center's PUBLISHED bucket.
UPDATE "TestSeries" SET "status" = 'PUBLISHED' WHERE "isActive" = true;

-- CreateTable
CREATE TABLE "TestResource" (
    "id" TEXT NOT NULL,
    "type" "TestResourceType" NOT NULL,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "questionCount" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "releasePolicy" "ResourceReleasePolicy" NOT NULL DEFAULT 'AFTER_AVAILABLE_FROM',
    "releaseAt" TIMESTAMP(3),
    "examId" TEXT,
    "testSeriesId" TEXT,
    "mockTestId" TEXT,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestResource_type_isActive_idx" ON "TestResource"("type", "isActive");

-- CreateIndex
CREATE INDEX "TestResource_mockTestId_type_idx" ON "TestResource"("mockTestId", "type");

-- CreateIndex
CREATE INDEX "TestResource_testSeriesId_type_idx" ON "TestResource"("testSeriesId", "type");

-- CreateIndex
CREATE INDEX "TestResource_examId_type_idx" ON "TestResource"("examId", "type");

-- CreateIndex
CREATE INDEX "MockTest_testSeriesId_availableFrom_idx" ON "MockTest"("testSeriesId", "availableFrom");

-- CreateIndex
CREATE INDEX "TestAttempt_mockTestId_isLeaderboardAttempt_status_idx" ON "TestAttempt"("mockTestId", "isLeaderboardAttempt", "status");

-- AddForeignKey
ALTER TABLE "TestResource" ADD CONSTRAINT "TestResource_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResource" ADD CONSTRAINT "TestResource_testSeriesId_fkey" FOREIGN KEY ("testSeriesId") REFERENCES "TestSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResource" ADD CONSTRAINT "TestResource_mockTestId_fkey" FOREIGN KEY ("mockTestId") REFERENCES "MockTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestResource" ADD CONSTRAINT "TestResource_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
