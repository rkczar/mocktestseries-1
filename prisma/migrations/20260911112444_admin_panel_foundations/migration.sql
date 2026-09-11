-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterTable
ALTER TABLE "Question" DROP COLUMN "coreConcept",
DROP COLUMN "correctKey",
DROP COLUMN "examPearl",
DROP COLUMN "memoryTrick",
DROP COLUMN "options",
DROP COLUMN "whyCorrect",
DROP COLUMN "whyOthersWrong",
ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "correctAnswer" TEXT NOT NULL,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "difficulty" TEXT,
ADD COLUMN     "examId" TEXT NOT NULL,
ADD COLUMN     "explanation" TEXT,
ADD COLUMN     "optionA" TEXT NOT NULL,
ADD COLUMN     "optionB" TEXT NOT NULL,
ADD COLUMN     "optionC" TEXT NOT NULL,
ADD COLUMN     "optionD" TEXT NOT NULL,
ADD COLUMN     "paperYear" INTEGER NOT NULL,
ADD COLUMN     "questionNumber" INTEGER,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "status" "QuestionStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "subTopic" TEXT,
ADD COLUMN     "topic" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Subject" ADD COLUMN     "isEnabledForCustomModule" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "replacedCount" INTEGER NOT NULL DEFAULT 0,
    "addedAnywayCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalName" TEXT NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppearanceSetting" (
    "id" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL DEFAULT '#0F4C81',
    "accentColor" TEXT NOT NULL DEFAULT '#F57C00',
    "successColor" TEXT NOT NULL DEFAULT '#2E7D32',
    "errorColor" TEXT NOT NULL DEFAULT '#C62828',
    "fontDisplay" TEXT NOT NULL DEFAULT 'Source Serif 4',
    "fontBody" TEXT NOT NULL DEFAULT 'Manrope',
    "buttonRadiusPx" INTEGER NOT NULL DEFAULT 10,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "AppearanceSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_examId_createdAt_idx" ON "ImportBatch"("examId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UploadedFile_key_key" ON "UploadedFile"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Question_code_key" ON "Question"("code");

-- CreateIndex
CREATE INDEX "Question_examId_paperYear_subjectId_topic_idx" ON "Question"("examId", "paperYear", "subjectId", "topic");

-- CreateIndex
CREATE INDEX "Question_status_idx" ON "Question"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Question_examId_paperYear_questionNumber_key" ON "Question"("examId", "paperYear", "questionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_examId_name_key" ON "Subject"("examId", "name");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

