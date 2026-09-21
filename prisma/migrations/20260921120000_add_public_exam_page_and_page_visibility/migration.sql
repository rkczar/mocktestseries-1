-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "conductingAuthority" TEXT,
ADD COLUMN     "eligibility" TEXT,
ADD COLUMN     "examMode" TEXT,
ADD COLUMN     "examPatternInfo" TEXT,
ADD COLUMN     "faqItems" JSONB,
ADD COLUMN     "importantDates" JSONB,
ADD COLUMN     "overview" TEXT,
ADD COLUMN     "publicPageEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicSlug" TEXT,
ADD COLUMN     "seoDescription" TEXT,
ADD COLUMN     "seoTitle" TEXT,
ADD COLUMN     "shortDescription" TEXT,
ADD COLUMN     "totalMarks" INTEGER,
ADD COLUMN     "totalQuestions" INTEGER;

-- CreateTable
CREATE TABLE "PageVisibility" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageVisibility_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PageVisibility_key_key" ON "PageVisibility"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Exam_publicSlug_key" ON "Exam"("publicSlug");
