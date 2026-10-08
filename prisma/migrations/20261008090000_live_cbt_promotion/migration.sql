-- Live CBT dashboard promotion + sharing. Additive only: three MockTest
-- columns; the two flags default to false (metadata-only on PostgreSQL 16),
-- so every existing mock keeps exactly its current behaviour. No existing
-- row is updated.

-- AlterTable
ALTER TABLE "MockTest" ADD COLUMN     "allowSharing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "promoText" TEXT,
ADD COLUMN     "promoteOnDashboard" BOOLEAN NOT NULL DEFAULT false;
