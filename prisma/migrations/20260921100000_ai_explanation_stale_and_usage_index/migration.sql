-- AlterTable
ALTER TABLE "AIExplanation" ADD COLUMN     "isStale" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "StudentActivity_activity_createdAt_idx" ON "StudentActivity"("activity", "createdAt");
