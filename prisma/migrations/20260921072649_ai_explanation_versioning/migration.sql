-- AlterTable
ALTER TABLE "AIExplanation" ADD COLUMN     "adminReviewedAt" TIMESTAMP(3),
ADD COLUMN     "adminReviewedById" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "AIExplanationVersion" (
    "id" TEXT NOT NULL,
    "explanationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "promptVersion" TEXT,
    "generatedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIExplanationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIExplanationVersion_explanationId_version_idx" ON "AIExplanationVersion"("explanationId", "version");

-- AddForeignKey
ALTER TABLE "AIExplanation" ADD CONSTRAINT "AIExplanation_adminReviewedById_fkey" FOREIGN KEY ("adminReviewedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIExplanationVersion" ADD CONSTRAINT "AIExplanationVersion_explanationId_fkey" FOREIGN KEY ("explanationId") REFERENCES "AIExplanation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

