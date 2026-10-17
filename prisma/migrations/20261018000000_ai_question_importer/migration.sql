-- AI Question Importer: new tables/enums only, plus one nullable column on Question
-- (answerVerification). Additive: no existing data is changed; rolling the code
-- back needs no database change.

-- CreateEnum
CREATE TYPE "AiImportJobStatus" AS ENUM ('DRAFT', 'ANALYZING', 'AWAITING_CONFIRMATION', 'QUEUED', 'PROCESSING', 'NEEDS_REVIEW', 'PAUSED', 'PAUSED_BUDGET', 'IMPORTING', 'COMPLETED', 'COMPLETED_WITH_ISSUES', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AiImportPaperType" AS ENUM ('FULL_PAPER', 'SINGLE_SUBJECT', 'MIXED');

-- CreateEnum
CREATE TYPE "AiImportFileRole" AS ENUM ('PAPER', 'ANSWER_KEY');

-- CreateEnum
CREATE TYPE "AiImportFileStatus" AS ENUM ('UPLOADING', 'UPLOADED', 'ANALYZED', 'REJECTED', 'PROCESSED', 'PURGED');

-- CreateEnum
CREATE TYPE "AiImportPageStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AiImportQuestionStatus" AS ENUM ('EXTRACTED', 'READY', 'NEEDS_CORRECTION', 'NOT_IMPORTABLE', 'DUPLICATE', 'REJECTED', 'IMPORTED', 'PUBLISHED', 'IMPORT_FAILED');

-- CreateEnum
CREATE TYPE "AiImportAnswerStatus" AS ENUM ('OFFICIAL_MATCHED', 'INDEPENDENTLY_VERIFIED', 'UNVERIFIED', 'KEY_MISSING', 'KEY_MISMATCH', 'AMBIGUOUS_MAPPING', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Question" ADD COLUMN     "answerVerification" TEXT;

-- CreateTable
CREATE TABLE "AiImportJob" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AiImportJobStatus" NOT NULL DEFAULT 'DRAFT',
    "examId" TEXT NOT NULL,
    "paperType" "AiImportPaperType" NOT NULL DEFAULT 'FULL_PAPER',
    "subjectId" TEXT,
    "year" INTEGER,
    "paperCode" TEXT,
    "previousYearPaperId" TEXT,
    "createdById" TEXT NOT NULL,
    "budgetInr" DOUBLE PRECISION NOT NULL,
    "estCostInr" DOUBLE PRECISION,
    "estCostUsd" DOUBLE PRECISION,
    "estimate" JSONB,
    "spentInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "spentUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "config" JSONB,
    "analysis" JSONB,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "errorMessage" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportFile" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "role" "AiImportFileRole" NOT NULL DEFAULT 'PAPER',
    "paperFileId" TEXT,
    "originalName" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "mime" TEXT,
    "declaredBytes" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "storageKey" TEXT,
    "status" "AiImportFileStatus" NOT NULL DEFAULT 'UPLOADING',
    "detected" JSONB,
    "pageCount" INTEGER,
    "errorMessage" TEXT,
    "uploadedById" TEXT NOT NULL,
    "retainUntil" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiImportFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportPage" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "status" "AiImportPageStatus" NOT NULL DEFAULT 'PENDING',
    "kind" TEXT,
    "textChars" INTEGER NOT NULL DEFAULT 0,
    "textLayer" TEXT,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "renderKey" TEXT,
    "renderWidth" INTEGER,
    "renderHeight" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "rawOutput" JSONB,
    "ocrText" TEXT,
    "errorMessage" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiImportPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportQuestion" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceNumber" INTEGER,
    "sourceLabel" TEXT NOT NULL,
    "pages" INTEGER[],
    "orderIndex" INTEGER NOT NULL,
    "status" "AiImportQuestionStatus" NOT NULL DEFAULT 'EXTRACTED',
    "issueCodes" TEXT[],
    "issues" JSONB,
    "data" JSONB NOT NULL,
    "editedData" JSONB,
    "questionType" TEXT NOT NULL,
    "optionCount" INTEGER NOT NULL DEFAULT 0,
    "contentFormat" TEXT NOT NULL DEFAULT 'PLAIN',
    "confidence" DOUBLE PRECISION,
    "subjectId" TEXT,
    "topicId" TEXT,
    "subTopicId" TEXT,
    "taxonomyConfidence" DOUBLE PRECISION,
    "taxonomySource" TEXT,
    "answerStatus" "AiImportAnswerStatus" NOT NULL DEFAULT 'KEY_MISSING',
    "officialAnswerRaw" TEXT,
    "officialAnswer" TEXT[],
    "officialKeyPage" INTEGER,
    "sourceAnswer" TEXT[],
    "aiAnswer" TEXT[],
    "aiAnswerModel" TEXT,
    "aiAnswerConfidence" DOUBLE PRECISION,
    "finalAnswer" TEXT[],
    "answerConfirmedById" TEXT,
    "duplicateOfQuestionId" TEXT,
    "duplicateKind" TEXT,
    "duplicateScore" DOUBLE PRECISION,
    "allowDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "bulkImportRunId" TEXT,
    "bulkImportRowId" TEXT,
    "questionId" TEXT,
    "importedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "costInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiImportQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportFigure" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "questionId" TEXT,
    "owner" TEXT NOT NULL,
    "optionLabel" TEXT,
    "sharedGroup" TEXT,
    "box" JSONB,
    "source" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "originalSha256" TEXT NOT NULL,
    "originalMime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "mediaSha256" TEXT,
    "description" TEXT,
    "confidence" DOUBLE PRECISION,
    "mappingStatus" TEXT NOT NULL DEFAULT 'OK',
    "confirmedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiImportFigure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportKeyEntry" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "keyFileId" TEXT NOT NULL,
    "paperFileId" TEXT,
    "sourceNumber" INTEGER NOT NULL,
    "section" TEXT NOT NULL DEFAULT '',
    "rawValue" TEXT NOT NULL,
    "labels" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'OK',
    "page" INTEGER,
    "matchedQuestionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiImportKeyEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportCheck" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "severity" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "model" TEXT,
    "detail" TEXT,
    "costInr" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiImportCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiImportEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportAiCall" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "pageId" TEXT,
    "questionId" TEXT,
    "requestId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estCostInr" DOUBLE PRECISION,
    "costUsd" DOUBLE PRECISION,
    "costInr" DOUBLE PRECISION,
    "costStatus" TEXT NOT NULL,
    "fxRate" DOUBLE PRECISION,
    "errorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiImportAiCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiImportCleanup" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "categories" TEXT[],
    "fileCount" INTEGER NOT NULL,
    "bytes" BIGINT NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiImportCleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiImportJob_status_updatedAt_idx" ON "AiImportJob"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "AiImportJob_createdById_createdAt_idx" ON "AiImportJob"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "AiImportFile_jobId_idx" ON "AiImportFile"("jobId");

-- CreateIndex
CREATE INDEX "AiImportFile_sha256_idx" ON "AiImportFile"("sha256");

-- CreateIndex
CREATE INDEX "AiImportFile_retainUntil_idx" ON "AiImportFile"("retainUntil");

-- CreateIndex
CREATE INDEX "AiImportPage_jobId_status_idx" ON "AiImportPage"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiImportPage_fileId_pageNumber_key" ON "AiImportPage"("fileId", "pageNumber");

-- CreateIndex
CREATE INDEX "AiImportQuestion_jobId_status_idx" ON "AiImportQuestion"("jobId", "status");

-- CreateIndex
CREATE INDEX "AiImportQuestion_questionId_idx" ON "AiImportQuestion"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "AiImportQuestion_fileId_sourceKey_key" ON "AiImportQuestion"("fileId", "sourceKey");

-- CreateIndex
CREATE INDEX "AiImportFigure_jobId_idx" ON "AiImportFigure"("jobId");

-- CreateIndex
CREATE INDEX "AiImportFigure_questionId_idx" ON "AiImportFigure"("questionId");

-- CreateIndex
CREATE INDEX "AiImportFigure_originalSha256_idx" ON "AiImportFigure"("originalSha256");

-- CreateIndex
CREATE INDEX "AiImportKeyEntry_jobId_idx" ON "AiImportKeyEntry"("jobId");

-- CreateIndex
CREATE INDEX "AiImportKeyEntry_keyFileId_idx" ON "AiImportKeyEntry"("keyFileId");

-- CreateIndex
CREATE INDEX "AiImportCheck_questionId_stage_idx" ON "AiImportCheck"("questionId", "stage");

-- CreateIndex
CREATE INDEX "AiImportEvent_jobId_createdAt_idx" ON "AiImportEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "AiImportAiCall_jobId_createdAt_idx" ON "AiImportAiCall"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "AiImportAiCall_createdAt_idx" ON "AiImportAiCall"("createdAt");

-- CreateIndex
CREATE INDEX "AiImportCleanup_createdAt_idx" ON "AiImportCleanup"("createdAt");

-- AddForeignKey
ALTER TABLE "AiImportFile" ADD CONSTRAINT "AiImportFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportPage" ADD CONSTRAINT "AiImportPage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportPage" ADD CONSTRAINT "AiImportPage_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "AiImportFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportQuestion" ADD CONSTRAINT "AiImportQuestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportFigure" ADD CONSTRAINT "AiImportFigure_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportFigure" ADD CONSTRAINT "AiImportFigure_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "AiImportQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportKeyEntry" ADD CONSTRAINT "AiImportKeyEntry_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportCheck" ADD CONSTRAINT "AiImportCheck_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "AiImportQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportEvent" ADD CONSTRAINT "AiImportEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiImportAiCall" ADD CONSTRAINT "AiImportAiCall_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AiImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

