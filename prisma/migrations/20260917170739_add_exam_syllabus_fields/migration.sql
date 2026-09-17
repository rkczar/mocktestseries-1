
-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "syllabusDescription" TEXT,
ADD COLUMN     "syllabusEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Subject" ADD COLUMN     "syllabusDescription" TEXT;

-- AlterTable
ALTER TABLE "Topic" ADD COLUMN     "syllabusDescription" TEXT;

