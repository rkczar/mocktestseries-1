-- AI Gateway call log + Instagram AI Studio (Bulk Studio batches/queue, post metrics,
-- Trends & Competitors references, saved insight reports). Additive only: new
-- enums and tables; no existing table or column is changed.

-- CreateEnum
CREATE TYPE "InstagramBatchStatus" AS ENUM ('DRAFTING', 'QUEUE_RUNNING', 'QUEUE_PAUSED', 'QUEUE_STOPPED', 'COMPLETE');

-- CreateEnum
CREATE TYPE "InstagramQueueState" AS ENUM ('NONE', 'QUEUED', 'PUBLISHING', 'DONE', 'FAILED', 'UNCERTAIN', 'SKIPPED');

-- CreateEnum
CREATE TYPE "InstagramReferenceKind" AS ENUM ('HANDLE', 'POST');

-- CreateTable
CREATE TABLE "AiGatewayCall" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "errorCategory" TEXT,
    "errorSummary" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "estCostUsd" DOUBLE PRECISION,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGatewayCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramBatch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "examId" TEXT,
    "status" "InstagramBatchStatus" NOT NULL DEFAULT 'DRAFTING',
    "createdById" TEXT NOT NULL,
    "queueConfirmedById" TEXT,
    "queueConfirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramBatchItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "queueState" "InstagramQueueState" NOT NULL DEFAULT 'NONE',
    "requestKey" TEXT,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramPostMetric" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "igMediaId" TEXT NOT NULL,
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "saves" INTEGER,
    "shares" INTEGER,
    "unavailable" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramPostMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramReference" (
    "id" TEXT NOT NULL,
    "kind" "InstagramReferenceKind" NOT NULL,
    "handle" TEXT NOT NULL,
    "examTags" TEXT[],
    "url" TEXT,
    "topic" TEXT,
    "subject" TEXT,
    "format" TEXT,
    "captionStyle" TEXT,
    "keywords" TEXT[],
    "likes" INTEGER,
    "comments" INTEGER,
    "views" INTEGER,
    "observedAt" TIMESTAMP(3),
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramInsightReport" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "evidence" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramInsightReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiGatewayCall_feature_createdAt_idx" ON "AiGatewayCall"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "AiGatewayCall_provider_createdAt_idx" ON "AiGatewayCall"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "AiGatewayCall_createdAt_idx" ON "AiGatewayCall"("createdAt");

-- CreateIndex
CREATE INDEX "InstagramBatch_createdAt_idx" ON "InstagramBatch"("createdAt");

-- CreateIndex
CREATE INDEX "InstagramBatchItem_postId_idx" ON "InstagramBatchItem"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramBatchItem_batchId_postId_key" ON "InstagramBatchItem"("batchId", "postId");

-- CreateIndex
CREATE INDEX "InstagramPostMetric_postId_fetchedAt_idx" ON "InstagramPostMetric"("postId", "fetchedAt");

-- CreateIndex
CREATE INDEX "InstagramReference_kind_active_idx" ON "InstagramReference"("kind", "active");

-- CreateIndex
CREATE INDEX "InstagramReference_handle_idx" ON "InstagramReference"("handle");

-- CreateIndex
CREATE INDEX "InstagramInsightReport_kind_createdAt_idx" ON "InstagramInsightReport"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "InstagramBatchItem" ADD CONSTRAINT "InstagramBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "InstagramBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

