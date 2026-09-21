-- CreateTable
CREATE TABLE "AIExplanationVariant" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'anthropic',
    "status" "AiGenerationStatus" NOT NULL DEFAULT 'COMPLETED',
    "errorMessage" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIExplanationVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AIExplanationVariant_questionId_idx" ON "AIExplanationVariant"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "AIExplanationVariant_questionId_variantId_key" ON "AIExplanationVariant"("questionId", "variantId");

-- AddForeignKey
ALTER TABLE "AIExplanationVariant" ADD CONSTRAINT "AIExplanationVariant_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;
