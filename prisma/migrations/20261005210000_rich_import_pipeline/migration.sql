-- NEET Phase 3: rich import pipeline. Purely additive: two enums, one table,
-- nullable/defaulted columns. Every existing BulkImportRun becomes importMode=LEGACY.
-- CreateEnum
CREATE TYPE "BulkImportMode" AS ENUM ('LEGACY', 'RICH');

-- CreateEnum
CREATE TYPE "ImportBundleStatus" AS ENUM ('UPLOADING', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "BulkImportRow" ADD COLUMN     "infos" JSONB;

-- AlterTable
ALTER TABLE "BulkImportRun" ADD COLUMN     "assetCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bundleId" TEXT,
ADD COLUMN     "executingAt" TIMESTAMP(3),
ADD COLUMN     "formatCounts" JSONB,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "importMode" "BulkImportMode" NOT NULL DEFAULT 'LEGACY';

-- CreateTable
CREATE TABLE "ImportBundle" (
    "id" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "declaredBytes" INTEGER NOT NULL,
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "status" "ImportBundleStatus" NOT NULL DEFAULT 'UPLOADING',
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "expandedBytes" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "entries" JSONB,
    "errorMessage" TEXT,
    "processingAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportBundle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBundle_createdById_createdAt_idx" ON "ImportBundle"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkImportRun_idempotencyKey_key" ON "BulkImportRun"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "BulkImportRun_bundleId_key" ON "BulkImportRun"("bundleId");

-- AddForeignKey
ALTER TABLE "BulkImportRun" ADD CONSTRAINT "BulkImportRun_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "ImportBundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

