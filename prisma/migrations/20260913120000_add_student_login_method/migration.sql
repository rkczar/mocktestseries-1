-- Additive, non-destructive: records the authentication channel (password/otp/google)
-- on each student login attempt so Admin > Monitoring > Authentication can group events.
ALTER TABLE "StudentLoginAttempt" ADD COLUMN "method" TEXT;

CREATE INDEX "StudentLoginAttempt_method_idx" ON "StudentLoginAttempt"("method");