#!/usr/bin/env bash
# Nightly PostgreSQL backup for the mocktestseries database.
# Uses local peer auth as the `postgres` superuser (pg_dump only reads, never touches the live
# DB's data) so no credentials need to be parsed out of the app's .env. Output stored outside
# /var/www entirely, so Nginx can never serve it.
set -euo pipefail

DB_NAME="mocktestseries"
BACKUP_DIR="/var/backups/mocktestseries/postgres"
RETENTION_DAYS=14
LOG="/var/log/mocktestseries/backup-db.log"
TS=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_FILE="$BACKUP_DIR/mocktestseries-$TS.dump"

mkdir -p "$BACKUP_DIR" "$(dirname "$LOG")"
chmod 700 "$BACKUP_DIR"

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

log "Starting DB backup -> $DUMP_FILE"
sudo -u postgres pg_dump -Fc -d "$DB_NAME" > "$DUMP_FILE"
chmod 600 "$DUMP_FILE"
log "Backup complete ($(du -h "$DUMP_FILE" | cut -f1))"

log "Pruning dumps older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name 'mocktestseries-*.dump' -mtime +"$RETENTION_DAYS" -print -delete >>"$LOG" 2>&1 || true
log "Done."
