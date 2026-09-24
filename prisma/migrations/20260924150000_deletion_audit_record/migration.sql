-- DeletionRequest becomes a deliberate, retained DELETION AUDIT RECORD.
--
-- The snapshot now keeps the student's real contact details (not just a
-- masked form) so an authorized Admin can identify who deleted their
-- account. It is historical data only: authentication never reads this
-- table (lib/auth-student.ts / app/login/actions.ts resolve identities from
-- "Student" and "StudentOAuthAccount" alone), so a retained email/phone
-- here never blocks the same person registering a NEW account.
-- No credential, OTP, OAuth token or session secret is ever copied here.

ALTER TABLE "DeletionRequest"
  ADD COLUMN "emailSnapshot" TEXT,
  ADD COLUMN "phoneSnapshot" TEXT,
  ADD COLUMN "authMethodsSnapshot" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "studentCreatedAtSnapshot" TIMESTAMP(3),
  ADD COLUMN "studentDbIdSnapshot" TEXT;

-- The record must outlive the Student row: if a Student row is ever hard-
-- deleted, the request keeps its snapshot and only loses the live link.
ALTER TABLE "DeletionRequest" DROP CONSTRAINT "DeletionRequest_studentId_fkey";
ALTER TABLE "DeletionRequest" ALTER COLUMN "studentId" DROP NOT NULL;
ALTER TABLE "DeletionRequest" ADD CONSTRAINT "DeletionRequest_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "DeletionRequest_requestedAt_idx" ON "DeletionRequest"("requestedAt");

-- Backfill. Original DB id + creation date are recoverable for every row
-- (the anonymized Student row still exists). Raw contact/auth methods are
-- only backfilled for PENDING requests — the account is still live, and
-- approval re-snapshots anyway. APPROVED rows from before this migration
-- were anonymized without a raw snapshot; that data no longer exists
-- anywhere, so they keep only what was captured at the time.
UPDATE "DeletionRequest" dr SET
  "studentDbIdSnapshot" = s."id",
  "studentCreatedAtSnapshot" = s."createdAt"
FROM "Student" s WHERE s."id" = dr."studentId";

UPDATE "DeletionRequest" dr SET
  "emailSnapshot" = s."email",
  "phoneSnapshot" = s."mobile",
  "studentNameSnapshot" = s."name",
  "authMethodsSnapshot" = ARRAY[s."authProvider"::TEXT]
FROM "Student" s WHERE s."id" = dr."studentId" AND dr."status" = 'PENDING';

-- Immutability. Once a request leaves PENDING it is a closed audit record:
-- no column may change except "studentId" going NULL (Student hard-delete),
-- and it cannot be deleted. The approval transaction writes the final
-- snapshot in the same UPDATE that moves PENDING -> APPROVED, so it is
-- allowed by this guard. A deliberate erasure (e.g. a legal order) needs a
-- DBA to disable this trigger explicitly — it can never happen by accident.
CREATE OR REPLACE FUNCTION "deletion_request_audit_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'PENDING' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DeletionRequest % is a retained audit record and cannot be deleted', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'studentId') IS DISTINCT FROM (to_jsonb(OLD) - 'studentId')
     OR (NEW."studentId" IS NOT NULL AND NEW."studentId" IS DISTINCT FROM OLD."studentId") THEN
    RAISE EXCEPTION 'DeletionRequest % is a closed audit record and cannot be modified', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DeletionRequest_audit_guard"
  BEFORE UPDATE OR DELETE ON "DeletionRequest"
  FOR EACH ROW EXECUTE FUNCTION "deletion_request_audit_guard"();
