-- NEET Phase 1: rich scientific content foundation. ADDITIVE ONLY: new enums,
-- three new Question columns (contentFormat defaults to PLAIN, the others are
-- nullable) and a new QuestionAsset table. No existing column or row is changed.

-- CreateEnum
CREATE TYPE "QuestionContentFormat" AS ENUM ('PLAIN', 'RICH_V1');

-- CreateEnum
CREATE TYPE "QuestionAssetRole" AS ENUM ('QUESTION', 'OPTION', 'EXPLANATION');

-- CreateEnum
CREATE TYPE "EditorialStage" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'VERIFIED', 'READY_TO_PUBLISH');

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "contentFormat" "QuestionContentFormat" NOT NULL DEFAULT 'PLAIN',
ADD COLUMN     "editorialStage" "EditorialStage",
ADD COLUMN     "explanation" TEXT;

-- CreateTable
CREATE TABLE "QuestionAsset" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "role" "QuestionAssetRole" NOT NULL,
    "optionLabel" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "alt" TEXT NOT NULL,
    "caption" TEXT,
    "darkBacking" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionAsset_questionId_role_order_idx" ON "QuestionAsset"("questionId", "role", "order");

-- CreateIndex
CREATE INDEX "QuestionAsset_sha256_idx" ON "QuestionAsset"("sha256");

-- AddForeignKey
ALTER TABLE "QuestionAsset" ADD CONSTRAINT "QuestionAsset_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

