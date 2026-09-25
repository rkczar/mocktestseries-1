#!/usr/bin/env bash
# Nightly archive of the configuration needed to rebuild the server (NOT code:
# code is in git; NOT node_modules/.next/releases/caches).
#   - shared .env (DATABASE_URL, AUTH_SECRET — AUTH_SECRET also decrypts the
#     provider credentials stored in the DB; without it they must be re-entered)
#   - nginx site config, PM2 process dump, backup cron + scripts
# SECRETS: this archive contains secrets. It is root-only (0600) and must only
# ever leave the server through an ENCRYPTED off-site remote
# (see mocktestseries-offsite-sync.sh).
# Installed at /usr/local/bin/mocktestseries-backup-config.sh (source: ops/backup/ in the repo).
set -euo pipefail

DEST="/var/backups/mocktestseries/config"
LOG="/var/log/mocktestseries/backup-config.log"
RETENTION_DAYS=30
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DEST/mocktestseries-config-$TS.tar.gz"

mkdir -p "$DEST" "$(dirname "$LOG")"
chmod 700 "$DEST"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

ITEMS=(
  /var/www/mocktestseries-shared/.env
  /etc/nginx/sites-available/mocktestseries.in
  /root/.pm2/dump.pm2
  /etc/cron.d/mocktestseries-backups
  /usr/local/bin/mocktestseries-backup-db.sh
  /usr/local/bin/mocktestseries-backup-uploads.sh
  /usr/local/bin/mocktestseries-backup-config.sh
  /usr/local/bin/mocktestseries-offsite-sync.sh
)
present=()
for f in "${ITEMS[@]}"; do [ -e "$f" ] && present+=("$f") || log "WARN: $f missing — skipped"; done

umask 077
tar -czf "$OUT" --absolute-names "${present[@]}"
chmod 600 "$OUT"
log "Config archive $OUT ($(du -h "$OUT" | cut -f1), ${#present[@]} items)"
find "$DEST" -name 'mocktestseries-config-*.tar.gz' -mtime +"$RETENTION_DAYS" -print -delete >>"$LOG" 2>&1 || true
