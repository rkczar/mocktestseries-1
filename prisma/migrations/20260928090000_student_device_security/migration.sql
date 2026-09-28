-- Student device limit, session tracking and account-sharing protection.
-- Additive only: new tables + nullable columns. No existing row is rewritten.

-- CreateEnum
CREATE TYPE "DeviceSecurityEventType" AS ENUM ('DEVICE_REGISTERED', 'LOGIN_SUCCESS', 'DEVICE_LIMIT_REACHED', 'SESSION_REVOKED', 'DEVICE_REMOVED', 'ADMIN_DEVICE_RESET', 'LOGOUT_ALL', 'SUSPICIOUS_DEVICE_ACTIVITY', 'TEST_DEVICE_CONFLICT');

-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "deviceLimitResetAt" TIMESTAMP(3),
ADD COLUMN     "sessionsValidAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN     "activeDeviceId" TEXT,
ADD COLUMN     "activeSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StudentDevice" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "browser" TEXT,
    "os" TEXT,
    "userAgent" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "lastIpHash" TEXT,
    "lastIpMasked" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "registeredVia" TEXT NOT NULL DEFAULT 'LOGIN',
    "revokedAt" TIMESTAMP(3),
    "revokedByAdminId" TEXT,
    "revokeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentSession" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "revokedByAdminId" TEXT,

    CONSTRAINT "StudentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSecurityEvent" (
    "id" TEXT NOT NULL,
    "studentId" TEXT,
    "deviceId" TEXT,
    "sessionId" TEXT,
    "eventType" "DeviceSecurityEventType" NOT NULL,
    "actorAdminId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentDevice_studentId_active_idx" ON "StudentDevice"("studentId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "StudentDevice_studentId_deviceHash_key" ON "StudentDevice"("studentId", "deviceHash");

-- CreateIndex
CREATE UNIQUE INDEX "StudentSession_tokenHash_key" ON "StudentSession"("tokenHash");

-- CreateIndex
CREATE INDEX "StudentSession_studentId_revokedAt_idx" ON "StudentSession"("studentId", "revokedAt");

-- CreateIndex
CREATE INDEX "StudentSession_deviceId_revokedAt_idx" ON "StudentSession"("deviceId", "revokedAt");

-- CreateIndex
CREATE INDEX "DeviceSecurityEvent_studentId_createdAt_idx" ON "DeviceSecurityEvent"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecurityEvent_eventType_createdAt_idx" ON "DeviceSecurityEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "TestAttempt_activeDeviceId_idx" ON "TestAttempt"("activeDeviceId");

-- AddForeignKey
ALTER TABLE "StudentDevice" ADD CONSTRAINT "StudentDevice_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentDevice" ADD CONSTRAINT "StudentDevice_revokedByAdminId_fkey" FOREIGN KEY ("revokedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSession" ADD CONSTRAINT "StudentSession_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSession" ADD CONSTRAINT "StudentSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "StudentDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentSession" ADD CONSTRAINT "StudentSession_revokedByAdminId_fkey" FOREIGN KEY ("revokedByAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSecurityEvent" ADD CONSTRAINT "DeviceSecurityEvent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSecurityEvent" ADD CONSTRAINT "DeviceSecurityEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "StudentDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSecurityEvent" ADD CONSTRAINT "DeviceSecurityEvent_actorAdminId_fkey" FOREIGN KEY ("actorAdminId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAttempt" ADD CONSTRAINT "TestAttempt_activeDeviceId_fkey" FOREIGN KEY ("activeDeviceId") REFERENCES "StudentDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
