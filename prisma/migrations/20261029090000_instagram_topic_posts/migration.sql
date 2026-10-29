-- Topic-based Instagram carousels (additive). Existing question posts are unchanged:
-- every existing row keeps its questionId, series and indexes.

-- New series value. Not used elsewhere in this migration (a new enum value
-- can't be referenced in the transaction that adds it), so checks compare as text.
ALTER TYPE "InstagramPostSeries" ADD VALUE IF NOT EXISTS 'TOPIC';

ALTER TABLE "InstagramPost" ALTER COLUMN "questionId" DROP NOT NULL;
ALTER TABLE "InstagramPost" ADD COLUMN "topicKey" TEXT;

-- A post is either about one question (PYQ / MOST_MISSED) or about one topic (TOPIC), never both or neither.
ALTER TABLE "InstagramPost" ADD CONSTRAINT "InstagramPost_source_check" CHECK (
  ("series"::text = 'TOPIC' AND "questionId" IS NULL AND "topicKey" IS NOT NULL)
  OR ("series"::text <> 'TOPIC' AND "questionId" IS NOT NULL AND "topicKey" IS NULL)
);

-- Versions per topic (mirrors InstagramPost_questionId_version_key).
CREATE UNIQUE INDEX "InstagramPost_topicKey_version_key" ON "InstagramPost"("topicKey", "version");

-- Same duplicate guards as for questions: one CURRENT post per topic, at most one PUBLISHING post per topic.
CREATE UNIQUE INDEX "InstagramPost_one_current_per_topic" ON "InstagramPost"("topicKey") WHERE "supersededAt" IS NULL AND "topicKey" IS NOT NULL;
CREATE UNIQUE INDEX "InstagramPost_one_publishing_per_topic" ON "InstagramPost"("topicKey") WHERE "status" = 'PUBLISHING' AND "topicKey" IS NOT NULL;
