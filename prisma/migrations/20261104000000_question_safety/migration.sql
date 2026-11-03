-- Phase 1 question safety: question retirement, attempt invalidation,
-- per-answer statistics exclusion and replacement records. Additive only:
-- every new column is nullable, no existing enum gains a value, no row is rewritten.

-- CreateEnum
CREATE TYPE "QuestionReplacementKind" AS ENUM ('RETIRE', 'REPLACE');

-- CreateEnum
CREATE TYPE "QuestionReplacementStatus" AS ENUM ('APPLIED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "ReplacementContainerKind" AS ENUM ('MOCK_TEST', 'CUSTOM_MODULE', 'GRAND_TEST', 'LIVE_TEST');

-- CreateEnum
CREATE TYPE "ReplacementReferenceAction" AS ENUM ('SWAP', 'SKIP', 'HOLD');

-- AlterTable
ALTER TABLE "Answer" ADD COLUMN     "statsExcludedAt" TIMESTAMP(3),
ADD COLUMN     "statsExcludedByReplacementId" TEXT;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "paperQuestionNumber" INTEGER,
ADD COLUMN     "replacedByQuestionId" TEXT,
ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "retiredReason" TEXT;

-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN     "invalidatedAt" TIMESTAMP(3),
ADD COLUMN     "invalidatedByReplacementId" TEXT,
ADD COLUMN     "invalidationReason" TEXT,
ADD COLUMN     "statusBeforeInvalidation" "AttemptStatus";

-- CreateTable
CREATE TABLE "QuestionReplacement" (
    "id" TEXT NOT NULL,
    "kind" "QuestionReplacementKind" NOT NULL,
    "status" "QuestionReplacementStatus" NOT NULL DEFAULT 'APPLIED',
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdBySource" TEXT NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),
    "rolledBackById" TEXT,
    "summary" JSONB,

    CONSTRAINT "QuestionReplacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionReplacementItem" (
    "id" TEXT NOT NULL,
    "replacementId" TEXT NOT NULL,
    "oldQuestionId" TEXT NOT NULL,
    "oldStatus" "QuestionStatus" NOT NULL,
    "newQuestionId" TEXT,
    "newQuestionPrior" JSONB,
    "retiredVariants" JSONB,
    "paperId" TEXT,
    "paperQuestionNumber" INTEGER,

    CONSTRAINT "QuestionReplacementItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionReplacementReference" (
    "id" TEXT NOT NULL,
    "replacementId" TEXT NOT NULL,
    "containerKind" "ReplacementContainerKind" NOT NULL,
    "containerId" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "oldQuestionId" TEXT NOT NULL,
    "newQuestionId" TEXT,
    "order" INTEGER NOT NULL,
    "action" "ReplacementReferenceAction" NOT NULL,
    "priorContainerStatus" TEXT,
    "heldContainerStatus" TEXT,

    CONSTRAINT "QuestionReplacementReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionReplacement_createdAt_idx" ON "QuestionReplacement"("createdAt");

-- CreateIndex
CREATE INDEX "QuestionReplacementItem_replacementId_idx" ON "QuestionReplacementItem"("replacementId");

-- CreateIndex
CREATE INDEX "QuestionReplacementItem_oldQuestionId_idx" ON "QuestionReplacementItem"("oldQuestionId");

-- CreateIndex
CREATE INDEX "QuestionReplacementItem_newQuestionId_idx" ON "QuestionReplacementItem"("newQuestionId");

-- CreateIndex
CREATE INDEX "QuestionReplacementReference_replacementId_idx" ON "QuestionReplacementReference"("replacementId");

-- CreateIndex
CREATE INDEX "QuestionReplacementReference_containerKind_containerId_idx" ON "QuestionReplacementReference"("containerKind", "containerId");

-- CreateIndex
CREATE INDEX "Answer_statsExcludedByReplacementId_idx" ON "Answer"("statsExcludedByReplacementId");

-- CreateIndex
CREATE INDEX "Question_retiredAt_idx" ON "Question"("retiredAt");

-- CreateIndex
CREATE INDEX "Question_previousYearPaperId_paperQuestionNumber_idx" ON "Question"("previousYearPaperId", "paperQuestionNumber");

-- CreateIndex
CREATE INDEX "TestAttempt_invalidatedByReplacementId_idx" ON "TestAttempt"("invalidatedByReplacementId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_replacedByQuestionId_fkey" FOREIGN KEY ("replacedByQuestionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionReplacementItem" ADD CONSTRAINT "QuestionReplacementItem_replacementId_fkey" FOREIGN KEY ("replacementId") REFERENCES "QuestionReplacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionReplacementReference" ADD CONSTRAINT "QuestionReplacementReference_replacementId_fkey" FOREIGN KEY ("replacementId") REFERENCES "QuestionReplacement"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- An invalidated attempt is always ABANDONED (it can never be graded,
-- resumed or shown as a result); rollback clears invalidatedAt first.
ALTER TABLE "TestAttempt" ADD CONSTRAINT "TestAttempt_invalidated_is_abandoned"
  CHECK ("invalidatedAt" IS NULL OR "status" = 'ABANDONED');

-- A retired question is always ARCHIVED (never served, never re-published).
ALTER TABLE "Question" ADD CONSTRAINT "Question_retired_is_archived"
  CHECK ("retiredAt" IS NULL OR "status" = 'ARCHIVED');
