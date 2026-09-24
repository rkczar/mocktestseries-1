-- Additive only: existing rows keep today's behavior (FULL_SYLLABUS, no target, no slug).
CREATE TYPE "MockCoverageType" AS ENUM ('FULL_SYLLABUS', 'PARTIAL_SYLLABUS', 'SUBJECT_WISE');

ALTER TABLE "MockTest"
  ADD COLUMN "coverageType" "MockCoverageType" NOT NULL DEFAULT 'FULL_SYLLABUS',
  ADD COLUMN "coverageSubjectIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "coverageTopicIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "targetQuestionCount" INTEGER;

ALTER TABLE "TestSeries" ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "TestSeries_slug_key" ON "TestSeries"("slug");
