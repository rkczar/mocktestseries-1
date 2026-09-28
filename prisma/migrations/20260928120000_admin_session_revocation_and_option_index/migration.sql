-- Launch hardening. Additive only: one nullable column and one index; no
-- existing row is rewritten or removed.

-- Admin logout revocation: admin JWTs signed in before
-- AdminUser.sessionsValidAfter are rejected by lib/rbac.ts#getAdminSession
-- (stamped by the admin logout action).
-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN "sessionsValidAfter" TIMESTAMP(3);

-- Every attempt start / player load reads options by question; without this
-- index each lookup scans the whole table.
-- CreateIndex
CREATE INDEX "QuestionOption_questionId_idx" ON "QuestionOption"("questionId");
