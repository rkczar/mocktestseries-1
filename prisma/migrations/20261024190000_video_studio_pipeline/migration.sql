-- AI Video Studio: worker stages, validated output, uploaded assets, editor project, scene audio / regeneration.
-- Additive only (new nullable / defaulted columns on the Video Studio tables).

-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN "stage" TEXT,
ADD COLUMN "progressPct" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failedStage" TEXT,
ADD COLUMN "outputKey" TEXT,
ADD COLUMN "outputBytes" BIGINT,
ADD COLUMN "outputSec" DOUBLE PRECISION,
ADD COLUMN "renderMs" INTEGER,
ADD COLUMN "assets" JSONB,
ADD COLUMN "edit" JSONB;

-- AlterTable
ALTER TABLE "VideoScene" ADD COLUMN "audioHash" TEXT,
ADD COLUMN "assetKey" TEXT,
ADD COLUMN "regenQuoteId" TEXT,
ADD COLUMN "regenNote" TEXT;
