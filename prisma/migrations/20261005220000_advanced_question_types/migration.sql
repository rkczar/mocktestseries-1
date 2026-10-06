-- NEET Phase 4: advanced question types. Additive only: every existing Question becomes
-- SINGLE_CORRECT through the column default (no row rewrite in PostgreSQL 11+), every
-- existing Answer gets the empty selectedLabels default, and no snapshot is touched.

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('SINGLE_CORRECT', 'MULTIPLE_CORRECT', 'MATCH_THE_FOLLOWING');

-- AlterEnum
ALTER TYPE "QuestionAssetRole" ADD VALUE 'LIST_ITEM';

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "matchSpec" JSONB,
ADD COLUMN     "questionType" "QuestionType" NOT NULL DEFAULT 'SINGLE_CORRECT';

-- AlterTable
ALTER TABLE "QuestionAsset" ADD COLUMN     "listKey" TEXT;

-- AlterTable
ALTER TABLE "Answer" ADD COLUMN     "selectedLabels" TEXT[] DEFAULT ARRAY[]::TEXT[];

