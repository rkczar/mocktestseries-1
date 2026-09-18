-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('CONTACT', 'GROW_WITH_US');

-- CreateEnum
CREATE TYPE "CommunicationStatus" AS ENUM ('NEW', 'READ', 'IN_PROGRESS', 'RESOLVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GrowWithUsInterest" AS ENUM ('TEACHER', 'TEST_SERIES_CREATOR', 'IT_SUPPORT', 'CONTENT_CONTRIBUTOR', 'OTHER');

-- AlterEnum
ALTER TYPE "HomepageSectionKey" ADD VALUE 'CONTACT_INFO';

-- CreateTable
CREATE TABLE "Communication" (
    "id" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "type" "CommunicationType" NOT NULL,
    "interestType" "GrowWithUsInterest",
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "status" "CommunicationStatus" NOT NULL DEFAULT 'NEW',
    "internalNote" TEXT,
    "studentId" TEXT,
    "assignedAdminId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "readAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Communication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Communication_referenceId_key" ON "Communication"("referenceId");

-- CreateIndex
CREATE INDEX "Communication_type_status_createdAt_idx" ON "Communication"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Communication_status_idx" ON "Communication"("status");

-- CreateIndex
CREATE INDEX "Communication_email_idx" ON "Communication"("email");

-- CreateIndex
CREATE INDEX "Communication_ipAddress_createdAt_idx" ON "Communication"("ipAddress", "createdAt");

-- AddForeignKey
ALTER TABLE "Communication" ADD CONSTRAINT "Communication_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Communication" ADD CONSTRAINT "Communication_assignedAdminId_fkey" FOREIGN KEY ("assignedAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

