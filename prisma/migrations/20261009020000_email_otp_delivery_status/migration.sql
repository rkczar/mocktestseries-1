-- AlterTable
ALTER TABLE "EmailOtpRequest" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "deliveryFailure" TEXT,
ADD COLUMN     "deliveryStatus" "EmailStatus",
ADD COLUMN     "lastEventType" TEXT;

-- CreateIndex
CREATE INDEX "EmailOtpRequest_providerMessageId_idx" ON "EmailOtpRequest"("providerMessageId");
