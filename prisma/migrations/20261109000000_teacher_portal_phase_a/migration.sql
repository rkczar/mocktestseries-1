-- Teacher Portal Phase A (docs/TEACHER-PORTAL.md). Additive only: new enums,
-- new tables and nullable columns. No existing row is rewritten and no
-- existing enum gains a value.

-- CreateEnum
CREATE TYPE "TeacherStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "QuestionRevisionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'STALE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "TeacherRequestType" AS ENUM ('PUBLISH_QUESTION', 'REVISION', 'UNPUBLISH_NOTICE', 'UNPUBLISH_REQUEST', 'RESTORE_REQUEST', 'DELETE_REQUEST');

-- CreateEnum
CREATE TYPE "TeacherRequestStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "MockTestQuestion" ADD COLUMN     "excludedAt" TIMESTAMP(3),
ADD COLUMN     "excludedById" TEXT,
ADD COLUMN     "excludedReason" TEXT;

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "createdByAdminId" TEXT;

-- CreateTable
CREATE TABLE "TeacherProfile" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "status" "TeacherStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherExamAssignment" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "TeacherExamAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionRevision" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "lastEditedById" TEXT,
    "status" "QuestionRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "baseSnapshot" JSONB NOT NULL,
    "proposedSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "QuestionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherContentRequest" (
    "id" TEXT NOT NULL,
    "type" "TeacherRequestType" NOT NULL,
    "status" "TeacherRequestStatus" NOT NULL DEFAULT 'OPEN',
    "teacherId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "questionId" TEXT,
    "revisionId" TEXT,
    "targetKind" TEXT,
    "targetId" TEXT,
    "reason" TEXT NOT NULL,
    "impact" JSONB,
    "reviewerId" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherContentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherProfile_adminUserId_key" ON "TeacherProfile"("adminUserId");

-- CreateIndex
CREATE INDEX "TeacherExamAssignment_teacherId_revokedAt_idx" ON "TeacherExamAssignment"("teacherId", "revokedAt");

-- CreateIndex
CREATE INDEX "TeacherExamAssignment_examId_idx" ON "TeacherExamAssignment"("examId");

-- CreateIndex
CREATE INDEX "QuestionRevision_questionId_status_idx" ON "QuestionRevision"("questionId", "status");

-- CreateIndex
CREATE INDEX "TeacherContentRequest_status_createdAt_idx" ON "TeacherContentRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TeacherContentRequest_teacherId_createdAt_idx" ON "TeacherContentRequest"("teacherId", "createdAt");

-- CreateIndex
CREATE INDEX "TeacherContentRequest_questionId_idx" ON "TeacherContentRequest"("questionId");

-- CreateIndex
CREATE INDEX "TeacherContentRequest_examId_status_idx" ON "TeacherContentRequest"("examId", "status");

-- AddForeignKey
ALTER TABLE "TeacherProfile" ADD CONSTRAINT "TeacherProfile_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherExamAssignment" ADD CONSTRAINT "TeacherExamAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherExamAssignment" ADD CONSTRAINT "TeacherExamAssignment_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionRevision" ADD CONSTRAINT "QuestionRevision_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherContentRequest" ADD CONSTRAINT "TeacherContentRequest_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherContentRequest" ADD CONSTRAINT "TeacherContentRequest_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherContentRequest" ADD CONSTRAINT "TeacherContentRequest_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherContentRequest" ADD CONSTRAINT "TeacherContentRequest_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "QuestionRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one ACTIVE assignment per teacher + exam.
CREATE UNIQUE INDEX "TeacherExamAssignment_active_key" ON "TeacherExamAssignment"("teacherId", "examId") WHERE "revokedAt" IS NULL;

-- At most one open (DRAFT / SUBMITTED) revision per question.
CREATE UNIQUE INDEX "QuestionRevision_open_key" ON "QuestionRevision"("questionId") WHERE "status" IN ('DRAFT', 'SUBMITTED');

-- A teacher request always carries a real reason.
ALTER TABLE "TeacherContentRequest" ADD CONSTRAINT "TeacherContentRequest_reason_check" CHECK (char_length(btrim("reason")) >= 5);

-- An unpublished (excluded) test row always records who and why.
ALTER TABLE "MockTestQuestion" ADD CONSTRAINT "MockTestQuestion_exclusion_check" CHECK ("excludedAt" IS NULL OR ("excludedById" IS NOT NULL AND "excludedReason" IS NOT NULL));
