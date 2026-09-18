-- CreateEnum
CREATE TYPE "AnnouncementType" AS ENUM ('GENERAL', 'IMPORTANT', 'EXAM_UPDATE', 'NEW_TEST', 'LIVE_TEST', 'RESULT', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "AnnouncementPriority" AS ENUM ('NORMAL', 'IMPORTANT');

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL_STUDENTS', 'EXAM_STUDENTS', 'ACTIVE_STUDENTS', 'SELECTED_STUDENTS');

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "content" TEXT,
    "type" "AnnouncementType" NOT NULL DEFAULT 'GENERAL',
    "priority" "AnnouncementPriority" NOT NULL DEFAULT 'NORMAL',
    "audience" "AnnouncementAudience" NOT NULL DEFAULT 'ALL_STUDENTS',
    "examId" TEXT,
    "mockTestId" TEXT,
    "grandTestId" TEXT,
    "liveTestId" TEXT,
    "ctaLabel" TEXT,
    "ctaRoute" TEXT,
    "showOnDashboard" BOOLEAN NOT NULL DEFAULT false,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "publishAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementRecipient" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentNotificationState" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentNotificationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Announcement_status_publishAt_idx" ON "Announcement"("status", "publishAt");

-- CreateIndex
CREATE INDEX "Announcement_status_expiresAt_idx" ON "Announcement"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Announcement_audience_examId_idx" ON "Announcement"("audience", "examId");

-- CreateIndex
CREATE INDEX "Announcement_examId_idx" ON "Announcement"("examId");

-- CreateIndex
CREATE INDEX "Announcement_showOnDashboard_status_idx" ON "Announcement"("showOnDashboard", "status");

-- CreateIndex
CREATE INDEX "AnnouncementRecipient_studentId_idx" ON "AnnouncementRecipient"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRecipient_announcementId_studentId_key" ON "AnnouncementRecipient"("announcementId", "studentId");

-- CreateIndex
CREATE INDEX "StudentNotificationState_studentId_readAt_idx" ON "StudentNotificationState"("studentId", "readAt");

-- CreateIndex
CREATE INDEX "StudentNotificationState_announcementId_idx" ON "StudentNotificationState"("announcementId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentNotificationState_studentId_announcementId_key" ON "StudentNotificationState"("studentId", "announcementId");

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_mockTestId_fkey" FOREIGN KEY ("mockTestId") REFERENCES "MockTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_grandTestId_fkey" FOREIGN KEY ("grandTestId") REFERENCES "GrandTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_liveTestId_fkey" FOREIGN KEY ("liveTestId") REFERENCES "LiveTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Announcement" ADD CONSTRAINT "Announcement_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRecipient" ADD CONSTRAINT "AnnouncementRecipient_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRecipient" ADD CONSTRAINT "AnnouncementRecipient_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentNotificationState" ADD CONSTRAINT "StudentNotificationState_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentNotificationState" ADD CONSTRAINT "StudentNotificationState_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "Announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

