-- Additive, non-destructive: records the authentication channel (password/otp/google)
-- on each student login attempt so Admin > Monitoring > Authentication can group events.
ALTER TABLE "StudentLoginAttempt" ADD COLUMN IF NOT EXISTS "method" TEXT;

-- superseded by StudentLoginAttempt_method_createdAt_idx (20260913083820); not recreated