-- Canonical reusable taxonomy (Subject -> Topic -> SubTopic linked to Exams
-- through ExamSubject / ExamTopic / ExamSubTopic) + Bulk Import rollback
-- audit columns. Strictly additive: no table or column is dropped, no
-- taxonomy row is renamed, merged or deleted. Subject.examId stays as
-- provenance ("origin exam"); only its FK moves from CASCADE to SET NULL so
-- deleting one exam can never delete taxonomy other exams share.

-- CreateEnum
CREATE TYPE "BulkImportRollbackAction" AS ENUM ('DELETED', 'ARCHIVED', 'PROTECTED', 'ALREADY_MISSING', 'FAILED');

-- Subject.examId: keep the column and its data, relax NOT NULL, FK -> SET NULL
ALTER TABLE "Subject" DROP CONSTRAINT "Subject_examId_fkey";
ALTER TABLE "Subject" ALTER COLUMN "examId" DROP NOT NULL;
ALTER TABLE "Subject" ADD CONSTRAINT "Subject_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Normalized name keys (trim + collapse whitespace + lower-case; mirrors
-- lib/exam-taxonomy.ts#taxonomyNameKey). Added nullable, backfilled, then
-- made NOT NULL. The unique indexes below fail the whole migration (nothing
-- applied) if production holds an unexpected duplicate — never a silent merge.
ALTER TABLE "Subject" ADD COLUMN "nameKey" TEXT;
ALTER TABLE "Topic" ADD COLUMN "nameKey" TEXT;
ALTER TABLE "SubTopic" ADD COLUMN "nameKey" TEXT;
UPDATE "Subject" SET "nameKey" = lower(btrim(regexp_replace("name", '\s+', ' ', 'g')));
UPDATE "Topic" SET "nameKey" = lower(btrim(regexp_replace("name", '\s+', ' ', 'g')));
UPDATE "SubTopic" SET "nameKey" = lower(btrim(regexp_replace("name", '\s+', ' ', 'g')));
ALTER TABLE "Subject" ALTER COLUMN "nameKey" SET NOT NULL;
ALTER TABLE "Topic" ALTER COLUMN "nameKey" SET NOT NULL;
ALTER TABLE "SubTopic" ALTER COLUMN "nameKey" SET NOT NULL;

-- AlterTable
ALTER TABLE "BulkImportRun" ADD COLUMN     "lastRollbackAt" TIMESTAMP(3),
ADD COLUMN     "lastRollbackById" TEXT;

-- AlterTable
ALTER TABLE "BulkImportRow" ADD COLUMN     "rollbackAction" "BulkImportRollbackAction",
ADD COLUMN     "rollbackAt" TIMESTAMP(3),
ADD COLUMN     "rollbackReason" TEXT;

-- CreateTable
CREATE TABLE "ExamSubject" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamTopic" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamTopic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamSubTopic" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "subTopicId" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamSubTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExamSubject_subjectId_idx" ON "ExamSubject"("subjectId");
CREATE UNIQUE INDEX "ExamSubject_examId_subjectId_key" ON "ExamSubject"("examId", "subjectId");
CREATE INDEX "ExamTopic_topicId_idx" ON "ExamTopic"("topicId");
CREATE UNIQUE INDEX "ExamTopic_examId_topicId_key" ON "ExamTopic"("examId", "topicId");
CREATE INDEX "ExamSubTopic_subTopicId_idx" ON "ExamSubTopic"("subTopicId");
CREATE UNIQUE INDEX "ExamSubTopic_examId_subTopicId_key" ON "ExamSubTopic"("examId", "subTopicId");
CREATE UNIQUE INDEX "Subject_nameKey_key" ON "Subject"("nameKey");
CREATE UNIQUE INDEX "Topic_subjectId_nameKey_key" ON "Topic"("subjectId", "nameKey");
CREATE UNIQUE INDEX "SubTopic_topicId_nameKey_key" ON "SubTopic"("topicId", "nameKey");
CREATE INDEX "BulkImportRow_questionId_idx" ON "BulkImportRow"("questionId");

-- AddForeignKey
ALTER TABLE "ExamSubject" ADD CONSTRAINT "ExamSubject_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamSubject" ADD CONSTRAINT "ExamSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamTopic" ADD CONSTRAINT "ExamTopic_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamTopic" ADD CONSTRAINT "ExamTopic_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamSubTopic" ADD CONSTRAINT "ExamSubTopic_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExamSubTopic" ADD CONSTRAINT "ExamSubTopic_subTopicId_fkey" FOREIGN KEY ("subTopicId") REFERENCES "SubTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill links so every exam keeps exactly the taxonomy it has today:
-- each existing Subject/Topic/SubTopic is linked to its (origin) exam, in its
-- current order. Deterministic ids ("es_"/"et_"/"est_" + source row id).
INSERT INTO "ExamSubject" ("id", "examId", "subjectId", "displayOrder")
SELECT 'es_' || s."id", s."examId", s."id", s."order" FROM "Subject" s WHERE s."examId" IS NOT NULL;

INSERT INTO "ExamTopic" ("id", "examId", "topicId", "displayOrder")
SELECT 'et_' || t."id", s."examId", t."id", t."order"
FROM "Topic" t JOIN "Subject" s ON s."id" = t."subjectId" WHERE s."examId" IS NOT NULL;

INSERT INTO "ExamSubTopic" ("id", "examId", "subTopicId", "displayOrder")
SELECT 'est_' || st."id", s."examId", st."id", st."order"
FROM "SubTopic" st JOIN "Topic" t ON t."id" = st."topicId" JOIN "Subject" s ON s."id" = t."subjectId" WHERE s."examId" IS NOT NULL;
