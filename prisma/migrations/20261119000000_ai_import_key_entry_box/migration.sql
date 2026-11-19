-- AI Importer P2 (review card): normalized box of an OCR-read answer-key cell, for the key crop. Additive, nullable, no backfill.
ALTER TABLE "AiImportKeyEntry" ADD COLUMN "box" JSONB;
