-- Importer call diagnostics (owner decision 8, 2026-11-05): additive, nullable columns only.
ALTER TABLE "AiImportAiCall" ADD COLUMN "stage" TEXT;
ALTER TABLE "AiImportAiCall" ADD COLUMN "promptVersion" TEXT;
ALTER TABLE "AiImportAiCall" ADD COLUMN "provider" TEXT;
ALTER TABLE "AiImportAiCall" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "AiImportAiCall" ADD COLUMN "errorCategory" TEXT;
