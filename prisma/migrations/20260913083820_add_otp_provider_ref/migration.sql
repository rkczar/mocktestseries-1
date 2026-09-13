-- DropIndex
DROP INDEX "StudentLoginAttempt_method_idx";

-- AlterTable
ALTER TABLE "OtpRequest" ADD COLUMN     "providerRef" TEXT;

-- CreateIndex
CREATE INDEX "StudentLoginAttempt_method_createdAt_idx" ON "StudentLoginAttempt"("method", "createdAt");
