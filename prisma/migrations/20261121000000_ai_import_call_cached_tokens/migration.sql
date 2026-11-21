-- Additive, nullable: cached input tokens of an importer AI request (prompt caching). No data change.
ALTER TABLE "AiImportAiCall" ADD COLUMN "cachedTokens" INTEGER;
