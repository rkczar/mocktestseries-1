-- CreateEnum
CREATE TYPE "GrandTestStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LiveTestStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'LIVE', 'ENDED', 'RESULT_PUBLISHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TestType" AS ENUM ('FULL_MOCK', 'SUBJECT_TEST', 'GRAND_TEST', 'LIVE_TEST', 'PREVIOUS_YEAR_PAPER', 'CUSTOM_MODULE');

-- AlterTable
ALTER TABLE "AIExplanation" ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "generatedAt" TIMESTAMP(3),
ADD COLUMN     "promptVersion" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'anthropic',
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "AiGenerationStatus" NOT NULL DEFAULT 'COMPLETED';

-- AlterTable
ALTER TABLE "CustomModule" ADD COLUMN     "createdByStudentId" TEXT,
ADD COLUMN     "isStudentOwned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shareToken" TEXT;

-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN     "grandTestId" TEXT,
ADD COLUMN     "liveTestId" TEXT,
ADD COLUMN     "subjectId" TEXT,
ADD COLUMN     "testType" "TestType" NOT NULL DEFAULT 'FULL_MOCK',
ADD COLUMN     "topicIds" JSONB;

-- CreateTable
CREATE TABLE "GrandTest" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "durationMinutes" INTEGER NOT NULL,
    "negativeMarking" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "instructions" TEXT,
    "accessType" "AccessType" NOT NULL DEFAULT 'FREE',
    "status" "GrandTestStatus" NOT NULL DEFAULT 'DRAFT',
    "questionCount" INTEGER NOT NULL,
    "subjects" JSONB,
    "topics" JSONB,
    "difficulty" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrandTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrandTestQuestion" (
    "id" TEXT NOT NULL,
    "grandTestId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GrandTestQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveTest" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "studentDurationMinutes" INTEGER NOT NULL,
    "negativeMarking" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "instructions" TEXT,
    "accessType" "AccessType" NOT NULL DEFAULT 'FREE',
    "status" "LiveTestStatus" NOT NULL DEFAULT 'DRAFT',
    "questionCount" INTEGER NOT NULL,
    "subjects" JSONB,
    "topics" JSONB,
    "difficulty" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveTestQuestion" (
    "id" TEXT NOT NULL,
    "liveTestId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "LiveTestQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentExamEnrollment" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentExamEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GrandTest_examId_status_idx" ON "GrandTest"("examId", "status");

-- CreateIndex
CREATE INDEX "GrandTestQuestion_questionId_idx" ON "GrandTestQuestion"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "GrandTestQuestion_grandTestId_questionId_key" ON "GrandTestQuestion"("grandTestId", "questionId");

-- CreateIndex
CREATE INDEX "LiveTest_status_startAt_idx" ON "LiveTest"("status", "startAt");

-- CreateIndex
CREATE INDEX "LiveTest_examId_status_idx" ON "LiveTest"("examId", "status");

-- CreateIndex
CREATE INDEX "LiveTestQuestion_questionId_idx" ON "LiveTestQuestion"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "LiveTestQuestion_liveTestId_questionId_key" ON "LiveTestQuestion"("liveTestId", "questionId");

-- CreateIndex
CREATE INDEX "StudentExamEnrollment_examId_idx" ON "StudentExamEnrollment"("examId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentExamEnrollment_studentId_examId_key" ON "StudentExamEnrollment"("studentId", "examId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomModule_shareToken_key" ON "CustomModule"("shareToken");

-- CreateIndex
CREATE INDEX "CustomModule_createdByStudentId_idx" ON "CustomModule"("createdByStudentId");

-- CreateIndex
CREATE INDEX "TestAttempt_studentId_status_testType_idx" ON "TestAttempt"("studentId", "status", "testType");

-- CreateIndex
CREATE INDEX "TestAttempt_studentId_examId_status_idx" ON "TestAttempt"("studentId", "examId", "status");

-- CreateIndex
CREATE INDEX "TestAttempt_testType_status_idx" ON "TestAttempt"("testType", "status");

-- CreateIndex
CREATE INDEX "TestAttempt_examId_status_idx" ON "TestAttempt"("examId", "status");

-- CreateIndex
CREATE INDEX "TestAttempt_subjectId_idx" ON "TestAttempt"("subjectId");

-- CreateIndex
CREATE INDEX "TestAttempt_grandTestId_idx" ON "TestAttempt"("grandTestId");

-- CreateIndex
CREATE INDEX "TestAttempt_liveTestId_idx" ON "TestAttempt"("liveTestId");

-- CreateIndex
CREATE INDEX "TestAttemptQuestion_questionId_idx" ON "TestAttemptQuestion"("questionId");

-- AddForeignKey
ALTER TABLE "CustomModule" ADD CONSTRAINT "CustomModule_createdByStudentId_fkey" FOREIGN KEY ("createdByStudentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrandTest" ADD CONSTRAINT "GrandTest_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrandTest" ADD CONSTRAINT "GrandTest_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrandTestQuestion" ADD CONSTRAINT "GrandTestQuestion_grandTestId_fkey" FOREIGN KEY ("grandTestId") REFERENCES "GrandTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrandTestQuestion" ADD CONSTRAINT "GrandTestQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveTest" ADD CONSTRAINT "LiveTest_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveTest" ADD CONSTRAINT "LiveTest_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveTestQuestion" ADD CONSTRAINT "LiveTestQuestion_liveTestId_fkey" FOREIGN KEY ("liveTestId") REFERENCES "LiveTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveTestQuestion" ADD CONSTRAINT "LiveTestQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAttempt" ADD CONSTRAINT "TestAttempt_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAttempt" ADD CONSTRAINT "TestAttempt_grandTestId_fkey" FOREIGN KEY ("grandTestId") REFERENCES "GrandTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAttempt" ADD CONSTRAINT "TestAttempt_liveTestId_fkey" FOREIGN KEY ("liveTestId") REFERENCES "LiveTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentExamEnrollment" ADD CONSTRAINT "StudentExamEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentExamEnrollment" ADD CONSTRAINT "StudentExamEnrollment_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

