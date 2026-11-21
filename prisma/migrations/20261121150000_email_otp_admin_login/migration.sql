-- Additive: a new EmailOtpPurpose value for the optional Admin "Login with OTP". No data change.
ALTER TYPE "EmailOtpPurpose" ADD VALUE IF NOT EXISTS 'ADMIN_LOGIN';
