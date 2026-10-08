-- Mandatory mobile OTP verification (additive only: no existing row is
-- changed; every existing student starts unverified).
ALTER TYPE "OtpPurpose" ADD VALUE 'VERIFY_MOBILE';

ALTER TABLE "Student" ADD COLUMN "mobileVerifiedAt" TIMESTAMP(3);
