-- Step 1 — Question Bank foundation (database-only; no UI/API yet)
-- Additive, non-destructive. Adds Question source / examYear / AI-variant fields,
-- the canonical-code counter table, and targeted indexes. Nothing is dropped.

-- CreateEnum
CREATE TYPE "QuestionSource" AS ENUM ('QUESTION_BANK', 'PYQ');

-- CreateEnum
CREATE TYPE "AiVariantType" AS ENUM ('CANONICAL', 'AI_SIMILAR', 'AI_TRAP');

-- CreateEnum
CREATE TYPE "AiSlot" AS ENUM ('AI01', 'AI02', 'AI03', 'AI04', 'AI05');

-- CreateEnum
CREATE TYPE "AiGenerationStatus" AS ENUM ('NONE', 'PENDING', 'GENERATING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "aiGenerationStatus" "AiGenerationStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "aiSlot" "AiSlot",
ADD COLUMN     "aiVariantType" "AiVariantType",
ADD COLUMN     "examYear" INTEGER,
ADD COLUMN     "parentQuestionId" TEXT,
ADD COLUMN     "source" "QuestionSource" NOT NULL DEFAULT 'QUESTION_BANK';

-- CreateTable
CREATE TABLE "QuestionCodeCounter" (
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuestionCodeCounter_pkey" PRIMARY KEY ("scope")
);

-- CreateIndex
CREATE INDEX "Question_examId_examYear_idx" ON "Question"("examId", "examYear");
CREATE INDEX "Question_topicId_subTopicId_idx" ON "Question"("topicId", "subTopicId");
CREATE INDEX "Question_previousYearPaperId_status_idx" ON "Question"("previousYearPaperId", "status");
CREATE INDEX "Question_source_status_idx" ON "Question"("source", "status");
CREATE INDEX "Question_parentQuestionId_idx" ON "Question"("parentQuestionId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_parentQuestionId_fkey" FOREIGN KEY ("parentQuestionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill (idempotent, non-destructive): questions linked to a previous-year
-- paper become source = PYQ and inherit the paper's year. Questions without a
-- paper keep the QUESTION_BANK default. Re-running changes nothing.
UPDATE "Question" SET "source" = 'PYQ' WHERE "previousYearPaperId" IS NOT NULL AND "source" <> 'PYQ';
UPDATE "Question" q SET "examYear" = p."year" FROM "PreviousYearPaper" p
WHERE q."previousYearPaperId" = p."id" AND q."examYear" IS DISTINCT FROM p."year";