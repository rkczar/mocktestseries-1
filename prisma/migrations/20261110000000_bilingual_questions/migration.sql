-- Bilingual questions (additive, nullable / defaulted: existing exams stay ENGLISH, no row is rewritten).
-- CreateEnum
CREATE TYPE "ExamLanguageMode" AS ENUM ('ENGLISH', 'HINDI', 'BILINGUAL');

-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "languageMode" "ExamLanguageMode" NOT NULL DEFAULT 'ENGLISH';

-- AlterTable
ALTER TABLE "PreviousYearPaper" ADD COLUMN     "heldOn" DATE;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "textHi" TEXT;

-- AlterTable
ALTER TABLE "QuestionOption" ADD COLUMN     "textHi" TEXT;

