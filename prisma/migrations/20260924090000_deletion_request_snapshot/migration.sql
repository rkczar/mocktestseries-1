-- Deletion-time audit snapshot on DeletionRequest (masked contact only).
ALTER TABLE "DeletionRequest" ADD COLUMN "studentCodeSnapshot" TEXT,
ADD COLUMN "studentNameSnapshot" TEXT,
ADD COLUMN "emailMaskedSnapshot" TEXT,
ADD COLUMN "phoneMaskedSnapshot" TEXT,
ADD COLUMN "reviewedByAdminNameSnapshot" TEXT;

CREATE INDEX "DeletionRequest_studentId_status_idx" ON "DeletionRequest"("studentId", "status");

-- Close stale PENDING requests the old lifecycle allowed: a request filed by
-- an already-DELETED account through its still-valid old session, and any
-- duplicate pending rows for the same student (the oldest one is kept).
-- Historical rows are closed with an explanatory note, never removed.
UPDATE "DeletionRequest" dr SET "status" = 'REJECTED', "reviewedAt" = NOW(),
  "notes" = 'Auto-closed: account was already deleted when this request was filed.'
FROM "Student" s WHERE s."id" = dr."studentId" AND s."status" = 'DELETED' AND dr."status" = 'PENDING';

UPDATE "DeletionRequest" dr SET "status" = 'REJECTED', "reviewedAt" = NOW(),
  "notes" = 'Auto-closed: duplicate pending request.'
WHERE dr."status" = 'PENDING' AND EXISTS (
  SELECT 1 FROM "DeletionRequest" o
  WHERE o."studentId" = dr."studentId" AND o."status" = 'PENDING'
    AND (o."requestedAt" < dr."requestedAt" OR (o."requestedAt" = dr."requestedAt" AND o."id" < dr."id"))
);

-- At most ONE pending deletion request per student, enforced by the database
-- (Prisma schema cannot express a partial unique index). Guards the
-- double-submit / concurrent-request race in requestAccountDeletion.
CREATE UNIQUE INDEX "DeletionRequest_one_pending_per_student"
  ON "DeletionRequest"("studentId") WHERE "status" = 'PENDING';

-- Backfill the code snapshot for every existing request (the human-readable
-- MTS code survives anonymization). Name/contact snapshots are only
-- backfilled for students that have not been anonymized yet; already
-- APPROVED legacy rows keep NULL name/contact because that data no longer
-- exists anywhere to snapshot.
UPDATE "DeletionRequest" dr SET "studentCodeSnapshot" = s."studentId"
FROM "Student" s WHERE s."id" = dr."studentId";

UPDATE "DeletionRequest" dr SET "studentNameSnapshot" = s."name"
FROM "Student" s WHERE s."id" = dr."studentId" AND s."status" <> 'DELETED';

UPDATE "DeletionRequest" dr SET "reviewedByAdminNameSnapshot" = a."name"
FROM "AdminUser" a WHERE a."id" = dr."reviewedByAdminId";
