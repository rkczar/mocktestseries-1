-- Question Insights (Admin → Analytics): submitted attempts by submission window.
-- Additive index only; no data change.
CREATE INDEX "TestAttempt_status_submittedAt_idx" ON "TestAttempt"("status", "submittedAt");
