-- Student Reviews / Testimonials. Purely additive: two new enums, one new
-- table, constraints and a trigger on that table only. No existing row changes.

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('STUDENT_SUBMITTED', 'ADMIN_ADDED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "source" "ReviewSource" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "displayName" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT NOT NULL,
    "examName" TEXT,
    "studentId" TEXT,
    "originalDisplayName" TEXT,
    "originalRating" INTEGER,
    "originalComment" TEXT,
    "createdById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "editedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Review_studentId_key" ON "Review"("studentId");

-- CreateIndex
CREATE INDEX "Review_status_isPublished_isFeatured_displayOrder_idx" ON "Review"("status", "isPublished", "isFeatured", "displayOrder");

-- CreateIndex
CREATE INDEX "Review_source_status_idx" ON "Review"("source", "status");

-- CreateIndex
CREATE INDEX "Review_createdAt_idx" ON "Review"("createdAt");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Provenance, enforced by the database rather than only by application code:
-- a STUDENT_SUBMITTED review always belongs to a student, an ADMIN_ADDED
-- testimonial never does (so it can never earn the "Verified Student" badge).
ALTER TABLE "Review" ADD CONSTRAINT "Review_source_student_check"
  CHECK (("source" = 'STUDENT_SUBMITTED') = ("studentId" IS NOT NULL));

-- Only an approved review may be published.
ALTER TABLE "Review" ADD CONSTRAINT "Review_published_requires_approved_check"
  CHECK (NOT "isPublished" OR "status" = 'APPROVED');

ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range_check"
  CHECK ("rating" BETWEEN 1 AND 5 AND ("originalRating" IS NULL OR "originalRating" BETWEEN 1 AND 5));

-- A review's source and owning student are fixed at creation: moderation can
-- never silently turn a student review into an admin one (or move it to
-- another student).
CREATE FUNCTION "review_provenance_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."source" IS DISTINCT FROM OLD."source" OR NEW."studentId" IS DISTINCT FROM OLD."studentId" THEN
    RAISE EXCEPTION 'Review source and studentId are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Review_provenance_immutable"
  BEFORE UPDATE ON "Review"
  FOR EACH ROW EXECUTE FUNCTION "review_provenance_immutable"();
