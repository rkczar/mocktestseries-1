-- CreateEnum
CREATE TYPE "VideoJobKind" AS ENUM ('GENERATE', 'EDIT');

-- CreateEnum
CREATE TYPE "VideoJobStatus" AS ENUM ('DRAFT', 'CONFIGURING', 'AWAITING_CONFIRMATION', 'QUEUED', 'GENERATING_SCRIPT', 'GENERATING_AUDIO', 'RENDERING', 'REVIEW_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELLED', 'CLEANUP_PENDING');

-- CreateTable
CREATE TABLE "VideoJob" (
    "id" TEXT NOT NULL,
    "kind" "VideoJobKind" NOT NULL DEFAULT 'GENERATE',
    "title" TEXT NOT NULL,
    "status" "VideoJobStatus" NOT NULL DEFAULT 'DRAFT',
    "source" JSONB NOT NULL,
    "config" JSONB,
    "skills" JSONB,
    "customPrompt" TEXT,
    "examLabel" TEXT,
    "examId" TEXT,
    "estimate" JSONB,
    "estTotalInr" DOUBLE PRECISION,
    "actualInr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unknownCostCalls" INTEGER NOT NULL DEFAULT 0,
    "quoteIds" TEXT[],
    "createdById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "storageBytes" BIGINT NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "mediaDeletedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoScene" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "narration" TEXT NOT NULL DEFAULT '',
    "onScreenText" TEXT NOT NULL DEFAULT '',
    "visual" JSONB,
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "audioKey" TEXT,
    "audioSec" DOUBLE PRECISION,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoScene_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoSkillPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "skillKeys" TEXT[],
    "instructions" TEXT NOT NULL DEFAULT '',
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoSkillPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VideoJob_status_updatedAt_idx" ON "VideoJob"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "VideoJob_createdById_createdAt_idx" ON "VideoJob"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "VideoJob_expiresAt_idx" ON "VideoJob"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "VideoScene_jobId_index_key" ON "VideoScene"("jobId", "index");

-- CreateIndex
CREATE INDEX "VideoJobEvent_jobId_createdAt_idx" ON "VideoJobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoSkillPreset_createdById_updatedAt_idx" ON "VideoSkillPreset"("createdById", "updatedAt");

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "VideoJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoJobEvent" ADD CONSTRAINT "VideoJobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "VideoJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
