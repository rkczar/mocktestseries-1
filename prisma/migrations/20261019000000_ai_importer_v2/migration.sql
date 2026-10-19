-- AlterTable
ALTER TABLE "AiImportJob" ADD COLUMN     "expectedQuestions" INTEGER;

-- AlterTable
ALTER TABLE "AiImportQuestion" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT;

-- CreateTable
CREATE TABLE "AiImportQuestionVersion" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT,
    "data" JSONB NOT NULL,
    "figures" JSONB,
    "changes" JSONB,
    "model" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "AiImportQuestionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiImportQuestionVersion_questionId_createdAt_idx" ON "AiImportQuestionVersion"("questionId", "createdAt");

-- CreateIndex
CREATE INDEX "AiImportQuestionVersion_jobId_kind_status_idx" ON "AiImportQuestionVersion"("jobId", "kind", "status");

-- AddForeignKey
ALTER TABLE "AiImportQuestionVersion" ADD CONSTRAINT "AiImportQuestionVersion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "AiImportQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

