-- Per-question exclusion from automatically generated practice + taxonomy academic-review status on import staging.
-- Additive only: two columns with a default false, four nullable columns. Existing rows: not excluded, nothing pending.
ALTER TABLE "Question" ADD COLUMN "excludeFromPractice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Question" ADD COLUMN "excludeFromPracticeReason" TEXT;
ALTER TABLE "AiImportQuestion" ADD COLUMN "excludeFromPractice" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiImportQuestion" ADD COLUMN "excludeFromPracticeReason" TEXT;
ALTER TABLE "AiImportQuestion" ADD COLUMN "academicReview" TEXT;
ALTER TABLE "AiImportQuestion" ADD COLUMN "academicReviewNote" TEXT;
