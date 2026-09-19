-- NOTE: RoleName.ADMIN -> FULL_ADMIN is a Prisma-level rename only
-- (`@map("ADMIN")` in schema.prisma). The underlying enum value in the
-- database stays "ADMIN" — no ALTER TYPE needed here, and no existing row
-- needs to change.

-- CreateEnum
CREATE TYPE "ImportRowSeverity" AS ENUM ('VALID', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "ImportFileFormat" AS ENUM ('CSV', 'XLS', 'XLSX', 'DOCX');

-- AlterEnum (additive only; existing rows/values are untouched)
ALTER TYPE "BulkImportStatus" ADD VALUE 'UPLOADED';
ALTER TYPE "BulkImportStatus" ADD VALUE 'VALIDATING';
ALTER TYPE "BulkImportStatus" ADD VALUE 'READY';
ALTER TYPE "BulkImportStatus" ADD VALUE 'IMPORTED';
ALTER TYPE "BulkImportStatus" ADD VALUE 'PARTIALLY_IMPORTED';

-- AlterTable
ALTER TABLE "Question"
  ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewReason" TEXT,
  ADD COLUMN "importBatchId" TEXT;

-- AlterTable
ALTER TABLE "BulkImportRun"
  ADD COLUMN "format" "ImportFileFormat",
  ADD COLUMN "label" TEXT,
  ADD COLUMN "examId" TEXT,
  ADD COLUMN "examYear" INTEGER,
  ADD COLUMN "warningRows" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "draftCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewRequiredCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "BulkImportRow"
  ADD COLUMN "severity" "ImportRowSeverity" NOT NULL DEFAULT 'ERROR',
  ADD COLUMN "errors" JSONB,
  ADD COLUMN "warnings" JSONB,
  ADD COLUMN "editedData" JSONB,
  ADD COLUMN "removedFromImport" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "targetStatus" "QuestionStatus",
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Question_importBatchId_idx" ON "Question"("importBatchId");

-- CreateIndex
CREATE INDEX "Question_reviewRequired_idx" ON "Question"("reviewRequired");

-- CreateIndex
CREATE INDEX "BulkImportRun_examId_examYear_idx" ON "BulkImportRun"("examId", "examYear");

-- CreateIndex
CREATE INDEX "BulkImportRow_runId_severity_idx" ON "BulkImportRow"("runId", "severity");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "BulkImportRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkImportRun" ADD CONSTRAINT "BulkImportRun_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;
