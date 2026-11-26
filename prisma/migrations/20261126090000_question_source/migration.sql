-- QuestionSourceEvidence: source evidence of a Question (additive; no existing table changes).
CREATE TABLE "QuestionSourceEvidence" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "aiImportQuestionId" TEXT,
    "jobId" TEXT,
    "jobTitle" TEXT,
    "fileId" TEXT,
    "fileName" TEXT,
    "year" INTEGER,
    "paperTitle" TEXT,
    "section" TEXT NOT NULL DEFAULT '',
    "sourceNumber" INTEGER,
    "sourceLabel" TEXT,
    "pages" INTEGER[],
    "questionCrops" JSONB,
    "cropNote" TEXT,
    "sourceText" TEXT,
    "ocrEngine" TEXT,
    "ocrConfidence" DOUBLE PRECISION,
    "extraction" TEXT,
    "issueCodes" TEXT[],
    "issues" JSONB,
    "answerStatus" TEXT,
    "officialAnswerRaw" TEXT,
    "officialAnswer" TEXT[],
    "extractedAnswer" TEXT[],
    "aiAnswer" TEXT[],
    "keyFileId" TEXT,
    "keyFileName" TEXT,
    "keyPage" INTEGER,
    "keyCrop" JSONB,
    "keyStatus" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QuestionSourceEvidence_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuestionSourceEvidence_questionId_key" ON "QuestionSourceEvidence"("questionId");
CREATE INDEX "QuestionSourceEvidence_jobId_idx" ON "QuestionSourceEvidence"("jobId");
CREATE INDEX "QuestionSourceEvidence_aiImportQuestionId_idx" ON "QuestionSourceEvidence"("aiImportQuestionId");
ALTER TABLE "QuestionSourceEvidence" ADD CONSTRAINT "QuestionSourceEvidence_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
