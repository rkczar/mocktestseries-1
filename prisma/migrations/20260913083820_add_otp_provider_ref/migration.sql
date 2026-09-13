-- DropIndex (conditional - ignore if doesn't exist)
DROP INDEX IF EXISTS "StudentLoginAttempt_method_idx";

-- AlterTable
ALTER TABLE "OtpRequest" ADD COLUMN     "providerRef" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StudentLoginAttempt_method_createdAt_idx" ON "StudentLoginAttempt"("method", "createdAt");
