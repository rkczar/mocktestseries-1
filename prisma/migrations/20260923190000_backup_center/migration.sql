-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('FULL', 'CLEAN', 'DATABASE');

-- CreateEnum
CREATE TYPE "BackupJobStatus" AS ENUM ('RUNNING', 'READY', 'DOWNLOADED', 'SAVED', 'FAILED', 'EXPIRED', 'DELETED');

-- CreateEnum
CREATE TYPE "BackupVerifyStatus" AS ENUM ('VALID', 'LEGACY_VERIFIED', 'LEGACY_UNVERIFIED', 'INVALID', 'CORRUPT', 'INCOMPATIBLE');


-- CreateTable
CREATE TABLE "BackupJob" (
    "id" TEXT NOT NULL,
    "kind" "BackupKind" NOT NULL,
    "status" "BackupJobStatus" NOT NULL DEFAULT 'RUNNING',
    "lockKey" TEXT,
    "saveOnVps" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "summary" JSONB,
    "error" TEXT,
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "storageFreed" BIGINT,

    CONSTRAINT "BackupJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupArtifactCheck" (
    "artifactId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mtimeMs" BIGINT NOT NULL,
    "status" "BackupVerifyStatus" NOT NULL,
    "detail" TEXT,
    "sha256" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupArtifactCheck_pkey" PRIMARY KEY ("artifactId")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackupJob_lockKey_key" ON "BackupJob"("lockKey");

-- CreateIndex
CREATE INDEX "BackupJob_createdAt_idx" ON "BackupJob"("createdAt");

-- CreateIndex
CREATE INDEX "BackupJob_status_idx" ON "BackupJob"("status");


