-- Additive, non-destructive: follows the same precedent as Step 4's
-- GRAND_TEST addition to this enum. Existing rows/values are unaffected;
-- this only makes LIVE_TEST a valid sourceType for new TestAttempt rows.
ALTER TYPE "AttemptSourceType" ADD VALUE 'LIVE_TEST';
