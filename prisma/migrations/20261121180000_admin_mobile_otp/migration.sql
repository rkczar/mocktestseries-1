-- Additive: Admin "Mobile OTP". New nullable columns + one OtpPurpose value. No data change.
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'ADMIN_LOGIN';
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "mobile" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "mobileVerifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "AdminUser_mobile_key" ON "AdminUser"("mobile");
