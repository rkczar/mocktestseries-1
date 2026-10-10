-- Direct Instagram publishing: the publish job state (stage, Meta container
-- IDs, media token, lease) of a post. Additive and nullable — existing rows
-- and the previous release are unaffected.
ALTER TABLE "InstagramPost" ADD COLUMN "publishJob" JSONB;
