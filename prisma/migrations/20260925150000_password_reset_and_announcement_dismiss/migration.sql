-- Forgot Password reuses the existing phone OTP infrastructure (OtpRequest)
-- with a dedicated purpose, then issues a short-lived single-use reset token
-- (hash only at rest).
ALTER TYPE "OtpPurpose" ADD VALUE 'RESET_PASSWORD';

CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_studentId_idx" ON "PasswordResetToken"("studentId");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-student Dashboard announcement dismissal (the Announcement row itself
-- is never modified by a student).
ALTER TABLE "StudentNotificationState" ADD COLUMN "dismissedAt" TIMESTAMP(3);
