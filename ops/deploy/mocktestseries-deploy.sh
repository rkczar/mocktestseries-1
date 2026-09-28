#!/usr/bin/env bash
# Release-directory deploy for mocktestseries.in — the existing process
# (git archive → releases/<sha> → build → atomic current switch → pm2 reload),
# scripted with guards so a bad release or a symlink loop can't take
# production down. See ops/DISASTER-RECOVERY.md → "Deploying a release".
#
#   ops/deploy/mocktestseries-deploy.sh <sha>          full deploy of a pushed commit
#   ops/deploy/mocktestseries-deploy.sh --check <dir>  validate a built release only (no switch)
#
# Production is untouched until the candidate is built, validated and has
# passed a boot test on a spare port. Post-switch health failure restores
# the previous current target automatically. Nothing is ever deleted from
# shared storage, and old releases are never removed here (retention is the
# Admin → Backup → Releases manager, which always keeps current + rollback).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ops/deploy/deploy-guards.sh
source "$HERE/deploy-guards.sh"

REPO_DIR="${REPO_DIR:-/var/www/mocktestseries}"
PM2_APP="${PM2_APP:-mocktestseries}"
APP_PORT="${APP_PORT:-3002}"
BOOT_PORT="${BOOT_PORT:-3199}"
PUBLIC_URL="${PUBLIC_URL:-https://mocktestseries.in}"
LOG_DIR="${LOG_DIR:-/var/log/mocktestseries}"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
die() { log "ABORT: $*"; exit 1; }

http_code() { curl -s -o /dev/null -m 15 -w "%{http_code}" "$1" || echo 000; }

validate_candidate() {
  local r="$1"
  check_shared_clean || return 1
  check_release_dir "$r" || return 1
  check_release_links "$r" || return 1
  [ -s "$r/.next/BUILD_ID" ] || { guard_fail "$r has no .next/BUILD_ID (not built)"; return 1; }
  log "candidate $r passed validation"
}

boot_test() {
  local r="$1" pid ok=1 logf="$LOG_DIR/deploy-boottest.log"
  ss -ltn | grep -q ":$BOOT_PORT " && die "boot-test port $BOOT_PORT is busy"
  mkdir -p "$LOG_DIR"
  (cd "$r" && exec node node_modules/next/dist/bin/next start -p "$BOOT_PORT" -H 127.0.0.1) >"$logf" 2>&1 &
  pid=$!
  for _ in $(seq 1 40); do
    [ "$(http_code "http://127.0.0.1:$BOOT_PORT/login")" = "200" ] && { ok=0; break; }
    sleep 1
  done
  if [ $ok -eq 0 ]; then
    for p in /login / /exams; do
      [ "$(http_code "http://127.0.0.1:$BOOT_PORT$p")" = "200" ] || { log "boot test: $p not 200"; ok=1; }
    done
    grep -q "ELOOP" "$logf" && { log "boot test: ELOOP in log"; ok=1; }
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return $ok
}

pm2_all_online() {
  pm2 jlist 2>/dev/null | APP="$PM2_APP" python3 -c '
import json, os, sys
procs = [p for p in json.load(sys.stdin) if p["name"] == os.environ["APP"]]
sys.exit(0 if procs and all(p["pm2_env"]["status"] == "online" for p in procs) else 1)'
}

post_switch_healthy() {
  for _ in $(seq 1 30); do
    if pm2_all_online && [ "$(http_code "http://127.0.0.1:$APP_PORT/login")" = "200" ] && [ "$(http_code "$PUBLIC_URL/login")" = "200" ]; then
      sleep 10 # still up after workers settle → not a crash loop
      pm2_all_online && [ "$(http_code "http://127.0.0.1:$APP_PORT/login")" = "200" ] && return 0
    fi
    sleep 2
  done
  return 1
}

if [ "${1:-}" = "--check" ]; then
  [ -n "${2:-}" ] || die "usage: $0 --check <release-dir>"
  validate_candidate "$2" && check_current_link && log "CHECK OK"
  exit $?
fi

SHA_ARG="${1:-}"
[ -n "$SHA_ARG" ] || die "usage: $0 <sha>"
# One deploy at a time: two runs would race on the switch and rollback target.
exec 9>"${LOCK_FILE:-/var/lock/mocktestseries-deploy.lock}"
flock -n 9 || die "another deploy is already running"
cd "$REPO_DIR"
git fetch -q origin
SHA=$(git rev-parse --verify "$SHA_ARG^{commit}") || die "unknown commit $SHA_ARG"
git merge-base --is-ancestor "$SHA" origin/main || die "$SHA is not on origin/main (push first)"
R="$RELEASES_DIR/$SHA"

# 1. Preflight — record state, refuse anything suspicious before writing.
check_shared_clean || die "shared storage failed validation"
check_current_link || die "current link failed validation"
PREV=$(realpath -e "$CURRENT_LINK")
log "current SHA:        $(basename "$PREV")"
log "current target:     $PREV"
log "shared storage:     $(realpath -e "$SHARED_DIR/storage")"
[ "$PREV" = "$(realpath -m "$R")" ] && die "$SHA is already current"
[ -e "$R" ] && die "$R already exists — inspect it (or remove it if it is a failed, non-current build) and rerun"

# 2. Assemble + build. Production is not touched.
mkdir "$R"
cleanup_failed() {
  # Only ever removes the candidate this run created, and never current.
  if [ -n "${R:-}" ] && [ -d "$R" ] && [ "$(realpath -e "$R")" != "$(realpath -e "$CURRENT_LINK")" ] && check_release_dir "$R" 2>/dev/null; then
    log "removing failed candidate $R"
    rm -rf --one-file-system -- "$R"
  fi
}
trap 'log "failed before switch"; cleanup_failed' ERR
git archive "$SHA" | tar -x -C "$R"
export ASSEMBLING_RELEASE="$R"
safe_link "$SHARED_DIR/.env" "$R/.env"
# public/storage is a tracked symlink (git archive already created it);
# safe_link accepts it only if it resolves exactly to shared storage.
safe_link "$SHARED_DIR/storage" "$R/public/storage"
unset ASSEMBLING_RELEASE
check_shared_clean
log "installing + building $R"
(cd "$R" && npm ci --no-audit --no-fund >"$LOG_DIR/deploy-npm.log" 2>&1 && npx prisma generate >/dev/null 2>&1)
# Server Action ids are salted with the build's encryption key, which Next
# otherwise randomizes per build: every deploy then renamed every action and
# a student mid-test got "Server Action not found" (404) on each answer save
# until reloading. A key derived from AUTH_SECRET is stable across releases
# (ids only change when an action itself changes) and adds no new secret.
# Never logged.
ACTIONS_KEY=$(cd "$R" && node -e '
require("dotenv").config({ path: ".env", quiet: true });
const s = process.env.AUTH_SECRET;
if (!s) process.exit(1);
process.stdout.write(require("crypto").createHmac("sha256", s).update("mts-server-actions-key-v1").digest("base64"));
') || die "could not derive the server actions key (AUTH_SECRET missing from shared .env?)"
(cd "$R" && NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$ACTIONS_KEY" npx next build >"$LOG_DIR/deploy-build.log" 2>&1)
unset ACTIONS_KEY
validate_candidate "$R"
log "candidate realpath:  $(realpath -e "$R")"

# New migrations are applied only on explicit request, before the boot test.
NEW_MIGRATIONS=$(comm -13 <(ls "$PREV/prisma/migrations" 2>/dev/null | sort) <(ls "$R/prisma/migrations" 2>/dev/null | sort) | grep -v migration_lock || true)
if [ -n "$NEW_MIGRATIONS" ]; then
  log "new migrations: $(echo $NEW_MIGRATIONS)"
  [ "${APPLY_MIGRATIONS:-}" = "1" ] || { log "rerun with APPLY_MIGRATIONS=1 to apply them (current untouched)"; trap - ERR; cleanup_failed; exit 1; }
  log "pre-migration database dump"
  bash "$HERE/../backup/mocktestseries-backup-db.sh" >/dev/null
  (cd "$R" && npx prisma migrate deploy)
fi

# 3. Boot test on a spare port.
boot_test "$R" || { log "boot test failed"; false; }
log "boot test passed on :$BOOT_PORT"
trap - ERR

# 4. Atomic switch, then reload.
check_shared_clean || die "shared storage changed during build — not switching"
atomic_switch "$R" || die "atomic switch failed (current unchanged: $(readlink "$CURRENT_LINK"))"
log "current -> $(realpath -e "$CURRENT_LINK")"
# A failed reload must still reach the health check (and so the rollback).
pm2 reload "$PM2_APP" >/dev/null || log "pm2 reload returned an error"

# 5. Post-switch health; automatic rollback.
if post_switch_healthy; then
  check_current_link && check_shared_clean
  log "DEPLOYED $SHA (previous known-good release kept: $PREV)"
  exit 0
fi
log "post-switch health FAILED — rolling back to $PREV"
atomic_switch "$PREV"
pm2 reload "$PM2_APP" >/dev/null || log "pm2 reload (rollback) returned an error"
if post_switch_healthy; then
  log "ROLLED BACK to $(basename "$PREV"); candidate $R left in place for inspection"
else
  log "ROLLBACK HEALTH ALSO FAILING — manual attention needed (current: $(readlink "$CURRENT_LINK"))"
fi
exit 1
