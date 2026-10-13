-- Free Trial + Premium access (additive only: two new tables, five new email
-- template keys). No existing table, row or column is changed.

-- AlterEnum
ALTER TYPE "EmailTemplateKey" ADD VALUE 'TRIAL_STARTED';
ALTER TYPE "EmailTemplateKey" ADD VALUE 'TRIAL_ENDS_24H';
ALTER TYPE "EmailTemplateKey" ADD VALUE 'TRIAL_ENDS_6H';
ALTER TYPE "EmailTemplateKey" ADD VALUE 'TRIAL_ENDS_1H';
ALTER TYPE "EmailTemplateKey" ADD VALUE 'TRIAL_EXPIRED';

-- CreateTable
CREATE TABLE "StudentPremiumTrial" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "mobile" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentPremiumTrial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentTrialNotice" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudentTrialNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudentPremiumTrial_studentId_key" ON "StudentPremiumTrial"("studentId");
CREATE UNIQUE INDEX "StudentPremiumTrial_mobile_key" ON "StudentPremiumTrial"("mobile");
CREATE INDEX "StudentPremiumTrial_endsAt_idx" ON "StudentPremiumTrial"("endsAt");
CREATE UNIQUE INDEX "StudentTrialNotice_studentId_kind_bucket_key" ON "StudentTrialNotice"("studentId", "kind", "bucket");
CREATE INDEX "StudentTrialNotice_kind_createdAt_idx" ON "StudentTrialNotice"("kind", "createdAt");

-- AddForeignKey
ALTER TABLE "StudentPremiumTrial" ADD CONSTRAINT "StudentPremiumTrial_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentTrialNotice" ADD CONSTRAINT "StudentTrialNotice_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
