-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "aiExplanation" TEXT,
ADD COLUMN     "aiExplanationGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "aiExplanationModel" TEXT;
