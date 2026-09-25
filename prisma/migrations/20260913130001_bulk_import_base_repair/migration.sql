-- Repair: BulkImportRun/BulkImportRow and their enums exist in production but were
-- created outside migration history (Step 2, 2026-09-13). Recreates their original
-- (pre-20260919) shape so a clean database can replay history. Idempotent: a no-op
-- on any database that already has them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkImportStatus') THEN
    CREATE TYPE "BulkImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkImportRowStatus') THEN
    CREATE TYPE "BulkImportRowStatus" AS ENUM ('PENDING', 'SUCCESS', 'SKIPPED', 'REPLACED', 'FAILED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkImportDuplicateStrategy') THEN
    CREATE TYPE "BulkImportDuplicateStrategy" AS ENUM ('SKIP', 'REPLACE', 'ADD_AS_NEW');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "BulkImportRun" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "replacedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateStrategy" "BulkImportDuplicateStrategy" NOT NULL,
    "status" "BulkImportStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BulkImportRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "BulkImportRow" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "BulkImportRowStatus" NOT NULL DEFAULT 'PENDING',
    "questionId" TEXT,
    "questionCode" TEXT,
    "errorMessage" TEXT,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BulkImportRow_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BulkImportRun_adminUserId_createdAt_idx" ON "BulkImportRun"("adminUserId", "createdAt");
CREATE INDEX IF NOT EXISTS "BulkImportRun_status_createdAt_idx" ON "BulkImportRun"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "BulkImportRow_runId_rowNumber_idx" ON "BulkImportRow"("runId", "rowNumber");
CREATE INDEX IF NOT EXISTS "BulkImportRow_runId_status_idx" ON "BulkImportRow"("runId", "status");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BulkImportRun_adminUserId_fkey') THEN
    ALTER TABLE "BulkImportRun" ADD CONSTRAINT "BulkImportRun_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BulkImportRow_runId_fkey') THEN
    ALTER TABLE "BulkImportRow" ADD CONSTRAINT "BulkImportRow_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BulkImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
