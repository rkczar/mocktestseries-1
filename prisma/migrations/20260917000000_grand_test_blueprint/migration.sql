-- Additive, non-destructive: adds the per-subject blueprint used to resolve
-- GrandTestQuestion at publish time (see schema.prisma comment on GrandTest).
-- GrandTest has zero rows as of this migration, so no backfill is needed.
ALTER TABLE "GrandTest" ADD COLUMN "blueprint" JSONB;
