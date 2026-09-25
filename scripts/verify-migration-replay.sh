#!/usr/bin/env bash
# Regression check: the full Prisma migration history must rebuild a CLEAN,
# EMPTY PostgreSQL database, and the result must match schema.prisma (and,
# optionally, a reference database such as a restored production dump).
#
# Never point this at production: it creates and drops a throwaway database.
#
#   SCRATCH_PG=postgresql://user@127.0.0.1:55432 scripts/verify-migration-replay.sh
#   SCRATCH_PG=… REFERENCE_DB_URL=postgresql://…/restored_copy scripts/verify-migration-replay.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SCRATCH_PG:?set SCRATCH_PG to a disposable PostgreSQL server URL (no database name)}"
DB="mts_replay_$(date +%s)"
URL="$SCRATCH_PG/$DB"
cleanup() { psql "$SCRATCH_PG/postgres" -qc "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql "$SCRATCH_PG/postgres" -qc "CREATE DATABASE \"$DB\""

echo "1. prisma migrate deploy on an empty database"
DATABASE_URL="$URL" npx prisma migrate deploy >/tmp/"$DB".log 2>&1 || { cat /tmp/"$DB".log; echo "FAIL: clean replay"; exit 1; }
applied=$(psql "$URL" -Atc 'select count(*) from _prisma_migrations where finished_at is not null')
expected=$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | wc -l)
[ "$applied" = "$expected" ] || { echo "FAIL: $applied/$expected migrations applied"; exit 1; }
echo "   PASS  $applied/$expected migrations applied"

echo "2. replayed schema vs schema.prisma"
# Known, accepted drift present in production since 2026-09-19: BulkImportRow.updatedAt
# carries a DB default the model doesn't declare (harmless; never used by Prisma).
drift=$(DATABASE_URL="$URL" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script 2>/dev/null \
  | grep -vE '^\s*$|^--|^Loaded Prisma config' \
  | grep -v 'ALTER TABLE "BulkImportRow" ALTER COLUMN "updatedAt" DROP DEFAULT;' || true)
[ -z "$drift" ] || { echo "$drift"; echo "FAIL: replayed schema drifts from schema.prisma"; exit 1; }
echo "   PASS  no unexpected drift"

if [ -n "${REFERENCE_DB_URL:-}" ]; then
  echo "3. replayed schema vs reference database"
  norm() { pg_dump -s --no-owner --no-privileges "$1" | grep -vE '^(--|SET |SELECT pg_catalog|\\restrict|\\unrestrict)' | grep -v '^$'; }
  if ! diff <(norm "$URL") <(norm "$REFERENCE_DB_URL") >/tmp/"$DB".diff; then
    head -40 /tmp/"$DB".diff; echo "FAIL: schema differs from reference"; exit 1
  fi
  echo "   PASS  schema identical to reference"
fi
echo "MIGRATION REPLAY: PASS"
