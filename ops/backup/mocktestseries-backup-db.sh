#!/usr/bin/env bash
# Nightly PostgreSQL backup for the mocktestseries database.
# Uses local peer auth as the `postgres` superuser (pg_dump only reads, never touches the live
# DB's data) so no credentials need to be parsed out of the app's .env. Output stored outside
# /var/www entirely, so Nginx can never serve it.
#
# A dump only counts as a backup after it is verified: written to a .part file, checked with
# `pg_restore --list` (must contain table data), then renamed and given a .sha256 sidecar
# (`sha256sum -c` compatible; the Backup Center checks it before every download). A failed or
# unverifiable dump is removed, logged as FAILED, recorded in db-status.txt and exits 1.
# Installed at /usr/local/bin/mocktestseries-backup-db.sh (source: ops/backup/ in the repo).
set -euo pipefail

DB_NAME="mocktestseries"
BACKUP_DIR="/var/backups/mocktestseries/postgres"
STATUS="/var/backups/mocktestseries/db-status.txt"
RETENTION_DAYS=14
LOG="/var/log/mocktestseries/backup-db.log"
TS=$(date -u +%Y%m%dT%H%M%SZ)
NAME="mocktestseries-$TS.dump"
DUMP_FILE="$BACKUP_DIR/$NAME"
PART="$BACKUP_DIR/.$NAME.part"

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG")"
chmod 700 "$BACKUP_DIR"

# Cron already appends stdout to $LOG: write each line once.
log() { echo "[$(date -u +%FT%TZ)] $*"; }
fail() {
  log "FAILED: $*"
  rm -f "$PART"
  echo "$(date -u +%FT%TZ) FAIL $*" >"$STATUS"
  exit 1
}

log "Starting DB backup -> $DUMP_FILE"
umask 077
sudo -u postgres pg_dump -Fc -d "$DB_NAME" >"$PART" || fail "pg_dump exited non-zero"
tables=$(pg_restore --list "$PART" 2>/dev/null | grep -c " TABLE DATA " || true)
[ "${tables:-0}" -gt 0 ] || fail "pg_restore --list could not read the dump (or it has no table data)"
mv "$PART" "$DUMP_FILE"
chmod 600 "$DUMP_FILE"
(cd "$BACKUP_DIR" && sha256sum "$NAME" >"$NAME.sha256" && chmod 600 "$NAME.sha256")
log "Backup complete ($(du -h "$DUMP_FILE" | cut -f1), $tables tables with data, sha256 $(cut -c1-16 "$DUMP_FILE.sha256")…)"
echo "$(date -u +%FT%TZ) OK $NAME" >"$STATUS"

# Nightly-format names only (mocktestseries-<UTC timestamp>.dump): never a pre-*/milestone dump copied here.
log "Pruning nightly dumps older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -maxdepth 1 -type f -regextype posix-extended \
  -regex '.*/mocktestseries-[0-9]{8}T[0-9]{6}Z\.dump(\.sha256)?' -mtime +"$RETENTION_DAYS" -print -delete || true
log "Done."
