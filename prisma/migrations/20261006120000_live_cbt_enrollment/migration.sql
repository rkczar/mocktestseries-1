-- Live CBT enrollment. Additive only: four MockTest columns with constant
-- defaults (metadata-only on PostgreSQL 16; every existing mock keeps
-- enrollmentEnabled = false = unchanged behaviour) and one new table.
-- No existing row is updated.

-- AlterTable
ALTER TABLE "MockTest" ADD COLUMN     "enrollmentClosesAt" TIMESTAMP(3),
ADD COLUMN     "enrollmentEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "enrollmentOpensAt" TIMESTAMP(3),
ADD COLUMN     "showEnrolledCount" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MockTestEnrollment" (
    "id" TEXT NOT NULL,
    "mockTestId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockTestEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MockTestEnrollment_studentId_idx" ON "MockTestEnrollment"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "MockTestEnrollment_mockTestId_studentId_key" ON "MockTestEnrollment"("mockTestId", "studentId");

-- AddForeignKey
ALTER TABLE "MockTestEnrollment" ADD CONSTRAINT "MockTestEnrollment_mockTestId_fkey" FOREIGN KEY ("mockTestId") REFERENCES "MockTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MockTestEnrollment" ADD CONSTRAINT "MockTestEnrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

