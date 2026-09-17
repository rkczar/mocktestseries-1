-- Additive, non-destructive. Zero Question rows have parentQuestionId set as
-- of this migration (confirmed before writing it), so the new unique index
-- has nothing pre-existing to conflict with.
ALTER TABLE "Question" ADD COLUMN "aiProvider" TEXT;
ALTER TABLE "Question" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "Question" ADD COLUMN "aiPromptVersion" TEXT;
ALTER TABLE "Question" ADD COLUMN "aiGeneratedAt" TIMESTAMP(3);
ALTER TABLE "Question" ADD COLUMN "aiErrorMessage" TEXT;

-- Server-side max-5-variants-per-question enforcement: aiSlot has exactly 5
-- enum values (AI01..AI05), so one row per (parentQuestionId, aiSlot) pair
-- caps a parent at 5 variants by construction, and doubles as the
-- concurrency guard against two admins claiming the same slot at once.
CREATE UNIQUE INDEX "Question_parentQuestionId_aiSlot_key" ON "Question"("parentQuestionId", "aiSlot");

CREATE INDEX "Question_aiGenerationStatus_idx" ON "Question"("aiGenerationStatus");
