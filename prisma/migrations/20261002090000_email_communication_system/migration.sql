-- Email Communication System (Admin → Communications → Email). Additive only:
-- new enums/tables plus one nullable Student column. No existing data is changed
-- except the firstLoginEmailAt backfill below.

-- CreateEnum
CREATE TYPE "EmailTemplateKey" AS ENUM ('WELCOME', 'FIRST_LOGIN', 'PAYMENT_SUCCESS', 'INVOICE', 'PASSWORD_RESET', 'FORGOT_PASSWORD', 'TEST_ANNOUNCEMENT', 'GENERAL_ANNOUNCEMENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('TRANSACTIONAL', 'PROMOTIONAL');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmailCampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmailAudience" AS ENUM ('INDIVIDUAL', 'SELECTED', 'ALL', 'PAID', 'FREE', 'EXAM');

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "firstLoginEmailAt" TIMESTAMP(3);

-- Backfill: every account that exists before the email system has already
-- had its first login, so it must never receive the FIRST_LOGIN email.
UPDATE "Student" SET "firstLoginEmailAt" = COALESCE("lastLoginAt", "createdAt") WHERE "firstLoginEmailAt" IS NULL;

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "key" "EmailTemplateKey" NOT NULL,
    "subject" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "ctaText" TEXT,
    "ctaUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateKey" "EmailTemplateKey" NOT NULL DEFAULT 'CUSTOM',
    "subject" TEXT NOT NULL,
    "heading" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "ctaText" TEXT,
    "ctaUrl" TEXT,
    "audience" "EmailAudience" NOT NULL,
    "examId" TEXT,
    "studentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "EmailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdByAdminId" TEXT,
    "queuedByAdminId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDeliveryLog" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "templateKey" "EmailTemplateKey" NOT NULL,
    "category" "EmailCategory" NOT NULL,
    "campaignId" TEXT,
    "studentId" TEXT,
    "toEmail" TEXT,
    "subject" TEXT,
    "variables" JSONB,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "provider" TEXT,
    "providerMessageId" TEXT,
    "failureReason" TEXT,
    "lastEventType" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdByAdminId" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailPreference" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "promotionalOptOut" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" TIMESTAMP(3),
    "suppressedAt" TIMESTAMP(3),
    "suppressionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_key_key" ON "EmailTemplate"("key");

-- CreateIndex
CREATE INDEX "EmailCampaign_status_createdAt_idx" ON "EmailCampaign"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeliveryLog_idempotencyKey_key" ON "EmailDeliveryLog"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDeliveryLog_providerMessageId_key" ON "EmailDeliveryLog"("providerMessageId");

-- CreateIndex
CREATE INDEX "EmailDeliveryLog_status_nextAttemptAt_idx" ON "EmailDeliveryLog"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryLog_campaignId_status_idx" ON "EmailDeliveryLog"("campaignId", "status");

-- CreateIndex
CREATE INDEX "EmailDeliveryLog_studentId_createdAt_idx" ON "EmailDeliveryLog"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryLog_createdAt_idx" ON "EmailDeliveryLog"("createdAt");

-- CreateIndex
CREATE INDEX "EmailDeliveryLog_toEmail_idx" ON "EmailDeliveryLog"("toEmail");

-- CreateIndex
CREATE UNIQUE INDEX "EmailPreference_studentId_key" ON "EmailPreference"("studentId");

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDeliveryLog" ADD CONSTRAINT "EmailDeliveryLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDeliveryLog" ADD CONSTRAINT "EmailDeliveryLog_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailPreference" ADD CONSTRAINT "EmailPreference_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

