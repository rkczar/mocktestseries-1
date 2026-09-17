-- Additive, non-destructive: follows the same precedent as Step 3's
-- SUBJECT_TEST addition to this enum. Existing rows/values are unaffected;
-- this only makes GRAND_TEST a valid sourceType for new TestAttempt rows.
ALTER TYPE "AttemptSourceType" ADD VALUE 'GRAND_TEST';
