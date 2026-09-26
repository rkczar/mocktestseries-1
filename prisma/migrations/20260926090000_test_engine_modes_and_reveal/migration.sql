-- TEST ENGINE CORE (P0 2026-09-26): additive only. New enums + defaulted
-- columns; every existing row keeps its exact behavior (FIXED duration,
-- EXAM answer mode, never revealed, saveSeq 0). No data is rewritten.

-- CreateEnum
CREATE TYPE "AttemptDurationMode" AS ENUM ('FIXED', 'PER_QUESTION', 'CUSTOM', 'UNLIMITED');

-- CreateEnum
CREATE TYPE "AttemptAnswerMode" AS ENUM ('EXAM', 'INSTANT');

-- AlterTable
ALTER TABLE "Answer" ADD COLUMN     "revealedAt" TIMESTAMP(3),
ADD COLUMN     "saveSeq" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CustomModule" ADD COLUMN     "answerMode" "AttemptAnswerMode" NOT NULL DEFAULT 'EXAM',
ADD COLUMN     "durationMode" "AttemptDurationMode" NOT NULL DEFAULT 'FIXED';

-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN     "answerMode" "AttemptAnswerMode" NOT NULL DEFAULT 'EXAM',
ADD COLUMN     "durationMode" "AttemptDurationMode" NOT NULL DEFAULT 'FIXED';

