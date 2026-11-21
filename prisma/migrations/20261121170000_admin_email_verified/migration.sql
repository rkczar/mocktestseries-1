-- Additive: when an admin proved their email (Admin "Login with OTP" needs a verified email). No data change.
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
