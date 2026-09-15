-- Step 3 — Subject Test engine.
--
-- 1. Give subject-test attempts their own legacy source-grouping so history
--    and analytics treat them like every other test source (the fine-grained
--    TestType was already added by the step3 grand/live migration).
-- 2. Persist the exact filters a student chose when generating an attempt
--    (year / source / difficulty / sub-topics). The question set itself is
--    already frozen in TestAttemptQuestion; the selection is kept so attempts
--    stay self-describing and resume never needs to re-resolve.

-- AddEnumValue
ALTER TYPE "AttemptSourceType" ADD VALUE 'SUBJECT_TEST';

-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN "selection" JSONB;