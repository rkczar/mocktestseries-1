-- AlterTable
ALTER TABLE "BulkImportRun" ADD COLUMN     "previousYearPaperId" TEXT;

-- AlterTable
ALTER TABLE "Exam" ADD COLUMN     "examDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PreviousYearPaper" ADD COLUMN     "paperCode" TEXT;

-- CreateIndex
CREATE INDEX "BulkImportRun_previousYearPaperId_idx" ON "BulkImportRun"("previousYearPaperId");

-- AddForeignKey
ALTER TABLE "BulkImportRun" ADD CONSTRAINT "BulkImportRun_previousYearPaperId_fkey" FOREIGN KEY ("previousYearPaperId") REFERENCES "PreviousYearPaper"("id") ON DELETE SET NULL ON UPDATE CASCADE;
