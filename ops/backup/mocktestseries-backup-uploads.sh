#!/usr/bin/env bash
# Nightly mirror of every persistent file store the app writes outside the DB:
#   /var/lib/mocktestseries/uploads          -> bulk-import uploads
#   /var/www/mocktestseries-shared/storage   -> question/option images, test resources (PDF/OMR)
# Never deletes from the backup copy, even if a file is later removed from the
# live source — errs toward over-retention, not data loss.
# Installed at /usr/local/bin/mocktestseries-backup-uploads.sh (source: ops/backup/ in the repo).
set -euo pipefail

BACKUP_ROOT="/var/backups/mocktestseries"
LOG="/var/log/mocktestseries/backup-uploads.log"
declare -A SOURCES=(
  ["uploads"]="/var/lib/mocktestseries/uploads"
  ["storage"]="/var/www/mocktestseries-shared/storage"
)

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

for name in "${!SOURCES[@]}"; do
  src="${SOURCES[$name]}"
  dest="$BACKUP_ROOT/$name"
  mkdir -p "$dest"
  chmod 700 "$dest"
  if [ ! -d "$src" ]; then
    log "WARN: $src missing — skipped"
    continue
  fi
  log "Mirroring (rsync, no deletions) $src -> $dest"
  rsync -a "$src"/ "$dest"/ >>"$LOG" 2>&1
  log "Done $name. Files in backup: $(find "$dest" -type f | wc -l)"
done
