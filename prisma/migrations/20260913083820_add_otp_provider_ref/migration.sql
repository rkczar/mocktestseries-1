-- DropIndex (conditional - ignore if doesn't exist)
DROP INDEX IF EXISTS "StudentLoginAttempt_method_idx";

-- AlterTable
ALTER TABLE "OtpRequest" ADD COLUMN     "providerRef" TEXT;

-- Column originally added by 20260913120000 (applied earlier in production despite its later name)
ALTER TABLE "StudentLoginAttempt" ADD COLUMN IF NOT EXISTS "method" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StudentLoginAttempt_method_createdAt_idx" ON "StudentLoginAttempt"("method", "createdAt");
