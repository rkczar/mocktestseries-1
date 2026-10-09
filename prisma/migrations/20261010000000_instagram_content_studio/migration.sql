-- Instagram Content Studio (Admin → Instagram). Additive only: two new enums and two
-- new tables. No existing table, column, FK or row is touched.

-- CreateEnum
CREATE TYPE "InstagramPostStatus" AS ENUM ('DRAFT', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "InstagramPostSeries" AS ENUM ('PYQ', 'MOST_MISSED');

-- CreateTable
CREATE TABLE "InstagramPost" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "questionCode" TEXT NOT NULL,
    "series" "InstagramPostSeries" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "InstagramPostStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "content" JSONB NOT NULL,
    "design" JSONB NOT NULL,
    "sourceSnapshot" JSONB NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "seriesStats" JSONB,
    "questionNumber" INTEGER,
    "questionNumberVerified" BOOLEAN NOT NULL DEFAULT false,
    "review" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "igMediaId" TEXT,
    "igPermalink" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishError" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramPostRevision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "baseRevision" INTEGER,
    "content" JSONB NOT NULL,
    "design" JSONB NOT NULL,
    "note" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramPostRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstagramPost_status_idx" ON "InstagramPost"("status");

-- CreateIndex
CREATE INDEX "InstagramPost_series_status_idx" ON "InstagramPost"("series", "status");

-- CreateIndex
CREATE INDEX "InstagramPost_updatedAt_idx" ON "InstagramPost"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramPost_questionId_version_key" ON "InstagramPost"("questionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramPostRevision_postId_revision_key" ON "InstagramPostRevision"("postId", "revision");

-- AddForeignKey
ALTER TABLE "InstagramPostRevision" ADD CONSTRAINT "InstagramPostRevision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "InstagramPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One CURRENT post per question (any series). "Create New Version" sets
-- supersededAt on the old row first, so duplicates can't be created by a
-- double click or two admins at once.
CREATE UNIQUE INDEX "InstagramPost_one_current_per_question" ON "InstagramPost"("questionId") WHERE "supersededAt" IS NULL;

-- At most one post per question may be mid-publish (reserved for the publishing phase).
CREATE UNIQUE INDEX "InstagramPost_one_publishing_per_question" ON "InstagramPost"("questionId") WHERE "status" = 'PUBLISHING';
