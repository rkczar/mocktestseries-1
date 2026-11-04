-- Page-level processing outcome and OCR evidence for the AI Question Importer.
-- Additive only: nullable columns, no defaults, no data rewritten. Rollback (if ever needed):
--   ALTER TABLE "AiImportPage" DROP COLUMN "outcome", DROP COLUMN "outcomeReason", DROP COLUMN "inkCoverage",
--     DROP COLUMN "ocrEngine", DROP COLUMN "ocrConfidence", DROP COLUMN "ocrLowLines", DROP COLUMN "ocrLines";
ALTER TABLE "AiImportPage" ADD COLUMN "outcome" TEXT;
ALTER TABLE "AiImportPage" ADD COLUMN "outcomeReason" TEXT;
ALTER TABLE "AiImportPage" ADD COLUMN "inkCoverage" DOUBLE PRECISION;
ALTER TABLE "AiImportPage" ADD COLUMN "ocrEngine" TEXT;
ALTER TABLE "AiImportPage" ADD COLUMN "ocrConfidence" DOUBLE PRECISION;
ALTER TABLE "AiImportPage" ADD COLUMN "ocrLowLines" INTEGER;
ALTER TABLE "AiImportPage" ADD COLUMN "ocrLines" JSONB;
