#!/usr/bin/env bash
# Off-VPS copy of /var/backups/mocktestseries (DB dumps, file mirrors, config
# archives) via rclone.
#
# OWNER CONFIGURATION REQUIRED (one time): create an ENCRYPTED rclone remote
# named "mts-offsite" (type = crypt) wrapping e.g. a Google Drive remote:
#     rclone config            # 1) add "gdrive" (drive)  2) add "mts-offsite" (crypt, remote = gdrive:mocktestseries-backups)
# Keep the crypt passwords in a password manager, NOT only on this server.
#
# Until that remote exists this script only records
# "OFF-VPS BACKUP: WAITING FOR OWNER CONFIGURATION" and exits 0. It refuses to
# upload to a remote that is not type crypt, because the config archives
# contain secrets.
# Installed at /usr/local/bin/mocktestseries-offsite-sync.sh (source: ops/backup/ in the repo).
set -euo pipefail

REMOTE="mts-offsite"
SRC="/var/backups/mocktestseries"
LOG="/var/log/mocktestseries/backup-offsite.log"
STATUS="/var/backups/mocktestseries/offsite-status.txt"

mkdir -p "$(dirname "$LOG")"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
status() { echo "$(date -u +%FT%TZ) $*" > "$STATUS"; }

if ! command -v rclone >/dev/null 2>&1; then
  log "OFF-VPS BACKUP: rclone not installed"; status "FAIL rclone not installed"; exit 1
fi
type=$(rclone config show "$REMOTE" 2>/dev/null | awk -F' = ' '$1=="type"{print $2}' || true)
if [ -z "$type" ]; then
  log "OFF-VPS BACKUP: WAITING FOR OWNER CONFIGURATION (rclone remote '$REMOTE' not configured)"
  status "WAITING FOR OWNER CONFIGURATION"
  exit 0
fi
if [ "$type" != "crypt" ]; then
  log "OFF-VPS BACKUP: REFUSED — remote '$REMOTE' is type '$type', must be 'crypt' (backups contain secrets)"
  status "FAIL remote not encrypted"
  exit 1
fi

log "Syncing $SRC -> $REMOTE: (copy, never deletes remote history)"
if rclone copy "$SRC" "$REMOTE:" \
     --include "postgres/**" --include "uploads/**" --include "storage/**" --include "config/**" \
     --transfers 2 >>"$LOG" 2>&1; then
  log "OFF-VPS BACKUP: OK"; status "OK"
else
  log "OFF-VPS BACKUP: FAILED"; status "FAIL rclone copy"; exit 1
fi
