-- Per-exam download switches (lib/exam-features.ts). Data-only, no schema change.
-- Keep today's behaviour: every exam that already has an ACTIVE practice OMR (global = not tied to a
-- mock test) gets omrDownloadEnabled=true. Paper downloads start OFF everywhere. Exams without a row
-- (e.g. Rajasthan FSO) read as both OFF. Never overwrites a row an admin already saved.
INSERT INTO "Setting" ("key", "value", "updatedAt")
SELECT DISTINCT 'exam.features.' || tr."examId",
       jsonb_build_object('omrDownloadEnabled', true, 'paperDownloadEnabled', false, 'updatedBy', 'migration:20261113000100'),
       NOW()
FROM "TestResource" tr
WHERE tr."type" = 'OMR_TEMPLATE' AND tr."isActive" = true AND tr."mockTestId" IS NULL AND tr."examId" IS NOT NULL
ON CONFLICT ("key") DO NOTHING;
