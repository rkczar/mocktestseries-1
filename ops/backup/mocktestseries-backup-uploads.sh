#!/usr/bin/env bash
# Nightly mirror of every persistent file store the app writes outside the DB:
#   /var/lib/mocktestseries/uploads          -> bulk-import uploads
#   /var/www/mocktestseries-shared/storage   -> question/option images, test resources (PDF/OMR)
#   /var/lib/mocktestseries/ai-import-vault  -> AI Importer originals, page renders, figures
#                                               (tmp/ and work/ are transient and skipped)
#   /var/lib/mocktestseries/import-staging   -> RICH bulk-import image bundles
# Never deletes from the backup copy, even if a file is later removed from the
# live source — errs toward over-retention, not data loss.
#
# After each mirror, every live file is verified in the copy by SHA-256 (the
# manifest is kept in manifests/<name>.sha256) and the file counts are logged.
# Any failure is logged as FAIL, recorded in files-status.txt (read by the
# watchdog) and makes the script exit 1; the other sources are still mirrored.
# Installed at /usr/local/bin/mocktestseries-backup-uploads.sh (source: ops/backup/ in the repo).
set -uo pipefail

BACKUP_ROOT="/var/backups/mocktestseries"
LOG="/var/log/mocktestseries/backup-uploads.log"
STATUS="$BACKUP_ROOT/files-status.txt"
MANIFESTS="$BACKUP_ROOT/manifests"
declare -A SOURCES=(
  ["uploads"]="/var/lib/mocktestseries/uploads"
  ["storage"]="/var/www/mocktestseries-shared/storage"
  ["ai-import-vault"]="/var/lib/mocktestseries/ai-import-vault"
  ["import-staging"]="/var/lib/mocktestseries/import-staging"
)
# Transient subfolders that are never mirrored or verified (paths relative to the source).
declare -A EXCLUDES=(
  ["ai-import-vault"]="tmp work"
)

mkdir -p "$(dirname "$LOG")" "$MANIFESTS"
chmod 700 "$MANIFESTS"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }

failures=()
for name in uploads storage ai-import-vault import-staging; do
  src="${SOURCES[$name]}"
  dest="$BACKUP_ROOT/$name"
  mkdir -p "$dest"
  chmod 700 "$dest"
  if [ ! -d "$src" ]; then
    log "FAIL: $src missing — skipped"
    failures+=("$name: source missing")
    continue
  fi

  rsync_ex=()
  find_ex=()
  for ex in ${EXCLUDES[$name]:-}; do
    rsync_ex+=(--exclude "/$ex/")
    find_ex+=(-path "./$ex" -prune -o)
  done

  log "Mirroring (rsync, no deletions) $src -> $dest"
  if ! rsync -a "${rsync_ex[@]}" "$src"/ "$dest"/ >>"$LOG" 2>&1; then
    log "FAIL: rsync $name"
    failures+=("$name: rsync failed")
    continue
  fi

  # Verify: every live file must be in the copy with the same SHA-256.
  manifest="$MANIFESTS/$name.sha256"
  if ! (cd "$src" && find . "${find_ex[@]}" -type f -print0 | sort -z | xargs -0 -r sha256sum) >"$manifest.new" 2>>"$LOG"; then
    log "FAIL: could not checksum live files of $name"
    failures+=("$name: live checksum failed")
    rm -f "$manifest.new"
    continue
  fi
  mv "$manifest.new" "$manifest"
  chmod 600 "$manifest"
  live_count=$(wc -l <"$manifest")
  backup_count=$(cd "$dest" && find . "${find_ex[@]}" -type f -print | wc -l)
  verify() { [ "$live_count" -eq 0 ] || (cd "$dest" && sha256sum -c --quiet "$manifest") >>"$LOG" 2>&1; }
  if ! verify; then
    # rsync's quick check (size + mtime) can miss a damaged copy: re-copy by checksum once.
    log "WARN: $name copy differs from the live files — re-copying with checksums"
    rsync -a -c "${rsync_ex[@]}" "$src"/ "$dest"/ >>"$LOG" 2>&1
    backup_count=$(cd "$dest" && find . "${find_ex[@]}" -type f -print | wc -l)
  fi
  if verify; then
    log "Done $name. Live files: $live_count, all verified by SHA-256. Files in backup: $backup_count"
  else
    log "FAIL: $name copy does not match the live files (see sha256sum output above)"
    failures+=("$name: checksum mismatch")
  fi
done

if [ ${#failures[@]} -gt 0 ]; then
  summary=$(printf '%s; ' "${failures[@]}")
  echo "$(date -u +%FT%TZ) FAIL ${summary%; }" >"$STATUS"
  log "FILE BACKUP FAILED: ${summary%; }"
  exit 1
fi
echo "$(date -u +%FT%TZ) OK" >"$STATUS"
log "File backup OK."
