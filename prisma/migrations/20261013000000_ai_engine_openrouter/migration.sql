-- AI Engine (OpenRouter): additive only — new nullable columns on AiGatewayCall, three new tables.
-- CreateEnum
CREATE TYPE "AiQuoteStatus" AS ENUM ('OPEN', 'USED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AiReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

-- AlterTable
ALTER TABLE "AiGatewayCall" ADD COLUMN     "actualCostInr" DOUBLE PRECISION,
ADD COLUMN     "actualCostUsd" DOUBLE PRECISION,
ADD COLUMN     "costStatus" TEXT,
ADD COLUMN     "estCostInr" DOUBLE PRECISION,
ADD COLUMN     "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fxAt" TIMESTAMP(3),
ADD COLUMN     "fxRate" DOUBLE PRECISION,
ADD COLUMN     "generationId" TEXT,
ADD COLUMN     "imageCount" INTEGER,
ADD COLUMN     "instagramPostId" TEXT,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "modelRequested" TEXT,
ADD COLUMN     "quoteId" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "routingMode" TEXT;

-- CreateTable
CREATE TABLE "AiModel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "contextLength" INTEGER,
    "maxCompletionTokens" INTEGER,
    "inputModalities" TEXT[],
    "outputModalities" TEXT[],
    "supportedParameters" TEXT[],
    "promptPrice" DOUBLE PRECISION,
    "completionPrice" DOUBLE PRECISION,
    "reasoningPrice" DOUBLE PRECISION,
    "requestPrice" DOUBLE PRECISION,
    "imageUnit" TEXT,
    "imageUnitCostUsd" DOUBLE PRECISION,
    "imageUnitsPerImage" DOUBLE PRECISION,
    "pricingRaw" JSONB,
    "isImageModel" BOOLEAN NOT NULL DEFAULT false,
    "expirationDate" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "medicallyApproved" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "missingSince" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCostQuote" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "routingMode" TEXT NOT NULL,
    "estInputTokens" INTEGER NOT NULL,
    "estOutputTokens" INTEGER NOT NULL,
    "estTextUsd" DOUBLE PRECISION,
    "estImageUsd" DOUBLE PRECISION,
    "maxCostUsd" DOUBLE PRECISION,
    "maxCostInr" DOUBLE PRECISION,
    "fxRate" DOUBLE PRECISION,
    "context" JSONB NOT NULL,
    "actorId" TEXT NOT NULL,
    "status" "AiQuoteStatus" NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCostQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiBudgetReservation" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "reservedInr" DOUBLE PRECISION NOT NULL,
    "settledInr" DOUBLE PRECISION,
    "costKnown" BOOLEAN NOT NULL DEFAULT false,
    "status" "AiReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "istDay" TEXT NOT NULL,
    "istMonth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "AiBudgetReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiModel_approved_isImageModel_idx" ON "AiModel"("approved", "isImageModel");

-- CreateIndex
CREATE INDEX "AiCostQuote_actorId_createdAt_idx" ON "AiCostQuote"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCostQuote_status_expiresAt_idx" ON "AiCostQuote"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiBudgetReservation_requestKey_key" ON "AiBudgetReservation"("requestKey");

-- CreateIndex
CREATE INDEX "AiBudgetReservation_istDay_status_idx" ON "AiBudgetReservation"("istDay", "status");

-- CreateIndex
CREATE INDEX "AiBudgetReservation_istMonth_status_idx" ON "AiBudgetReservation"("istMonth", "status");

-- CreateIndex
CREATE INDEX "AiBudgetReservation_status_createdAt_idx" ON "AiBudgetReservation"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiGatewayCall_generationId_key" ON "AiGatewayCall"("generationId");

-- CreateIndex
CREATE INDEX "AiGatewayCall_model_createdAt_idx" ON "AiGatewayCall"("model", "createdAt");

-- CreateIndex
CREATE INDEX "AiGatewayCall_instagramPostId_idx" ON "AiGatewayCall"("instagramPostId");

-- CreateIndex
CREATE INDEX "AiGatewayCall_costStatus_idx" ON "AiGatewayCall"("costStatus");

