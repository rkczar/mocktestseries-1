-- Additive: backoff state for the scheduled payment reconciliation job.
ALTER TABLE "PaymentOrder" ADD COLUMN "reconcileCheckedAt" TIMESTAMP(3),
ADD COLUMN "reconcileChecks" INTEGER NOT NULL DEFAULT 0;
