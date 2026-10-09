-- Additive only: new columns/tables/enums. No existing row is changed.

-- CreateEnum
CREATE TYPE "EmailOtpPurpose" AS ENUM ('VERIFY_EMAIL', 'RECOVERY_PROOF', 'ADMIN_TEST');

-- CreateEnum
CREATE TYPE "AccountRecoveryStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailOtpRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "EmailOtpPurpose" NOT NULL,
    "studentId" TEXT,
    "recoveryRequestId" TEXT,
    "otpHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "consumedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "providerMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOtpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountRecoveryRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT,
    "holderId" TEXT,
    "mobile" TEXT NOT NULL,
    "mobileProvedAt" TIMESTAMP(3) NOT NULL,
    "holderEmailProvedAt" TIMESTAMP(3),
    "studentNote" TEXT,
    "status" "AccountRecoveryStatus" NOT NULL DEFAULT 'DRAFT',
    "conflictingAccounts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByAdminId" TEXT,
    "reviewedByName" TEXT,
    "adminNotes" TEXT,
    "holderPreviousMobile" TEXT,

    CONSTRAINT "AccountRecoveryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailOtpRequest_email_purpose_createdAt_idx" ON "EmailOtpRequest"("email", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOtpRequest_studentId_purpose_createdAt_idx" ON "EmailOtpRequest"("studentId", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOtpRequest_ipAddress_createdAt_idx" ON "EmailOtpRequest"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "EmailOtpRequest_createdAt_idx" ON "EmailOtpRequest"("createdAt");

-- CreateIndex
CREATE INDEX "AccountRecoveryRequest_status_createdAt_idx" ON "AccountRecoveryRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AccountRecoveryRequest_requesterId_idx" ON "AccountRecoveryRequest"("requesterId");

-- CreateIndex
CREATE INDEX "AccountRecoveryRequest_holderId_idx" ON "AccountRecoveryRequest"("holderId");

-- AddForeignKey
ALTER TABLE "AccountRecoveryRequest" ADD CONSTRAINT "AccountRecoveryRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountRecoveryRequest" ADD CONSTRAINT "AccountRecoveryRequest_holderId_fkey" FOREIGN KEY ("holderId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- One open (DRAFT or PENDING) recovery request per requester; closed ones are history.
CREATE UNIQUE INDEX "AccountRecoveryRequest_one_open_per_requester" ON "AccountRecoveryRequest"("requesterId") WHERE "status" IN ('DRAFT', 'PENDING');
