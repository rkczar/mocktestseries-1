-- Additive, non-destructive: adds the per-subject blueprint used to resolve
-- LiveTestQuestion when a Live Test is locked (see schema.prisma comment on
-- LiveTest). LiveTest has zero rows as of this migration, so no backfill is
-- needed.
ALTER TABLE "LiveTest" ADD COLUMN "blueprint" JSONB;
