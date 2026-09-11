#!/usr/bin/env bash
# Safe production deployment for mocktestseries.
#
# Usage:
#   ./deploy.sh              Deploy the latest commit on origin/main.
#   ./deploy.sh rollback     Roll back "current" to the previous release and reload PM2.
#
# Design:
#   - Only ever deploys the approved "main" branch, and only commits that are actually on
#     origin/main (never uncommitted local changes).
#   - Builds each release in an isolated `git worktree` under RELEASES_DIR, completely separate
#     from the live process's files (node_modules, .next). The live app is never touched while
#     the new release installs dependencies / migrates / builds.
#   - Health-checks the new release directly (on a scratch port) BEFORE it ever receives real
#     traffic, and again through the public domain AFTER cutover. A failure at either point
#     aborts (or auto-rolls-back) without leaving the site down.
#   - Cutover is an atomic symlink swap (CURRENT_LINK) + `pm2 reload` in cluster mode, which
#     starts new workers and waits for them before killing old ones — zero dropped connections.
#   - .env is never touched by git or copied from a release; every release symlinks the one real
#     file that lives in APP_DIR, so secrets can never be overwritten by repo content and are
#     never duplicated into a git-managed directory.

set -euo pipefail

APP_DIR="/var/www/mocktestseries"
RELEASES_DIR="/var/www/mocktestseries-releases"
CURRENT_LINK="/var/www/mocktestseries-current"
PM2_APP="mocktestseries"
BRANCH="main"
KEEP_RELEASES=5
SCRATCH_PORT=3099
LOG_DIR="/var/log/mocktestseries"
LOG_FILE="$LOG_DIR/deploy.log"
HEALTHCHECK="$APP_DIR/scripts/healthcheck.sh"
PUBLIC_URL="https://mocktestseries.in"

mkdir -p "$LOG_DIR"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG_FILE"; }
abort() { log "ABORT: $*"; exit 1; }

require_clean_scratch_port() {
  if ss -tln 2>/dev/null | grep -q ":$SCRATCH_PORT "; then
    abort "Scratch port $SCRATCH_PORT is already in use — a previous deploy may still be running."
  fi
}

# ---------------------------------------------------------------------------
cmd_rollback() {
  log "=== Rollback requested ==="
  local current_target prev
  current_target=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")
  [[ -n "$current_target" ]] || abort "No current release to roll back from."

  prev=""
  while IFS= read -r dir; do
    dir="${dir%/}"
    if [[ "$dir" != "$current_target" ]]; then
      prev="$dir"
      break
    fi
  done < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null)

  [[ -n "$prev" ]] || abort "No previous release available under $RELEASES_DIR to roll back to."

  log "Rolling back: $current_target -> $prev"
  ln -sfn "$prev" "$CURRENT_LINK"
  pm2 reload "$PM2_APP" --update-env
  sleep 2

  if BASE_URL="$PUBLIC_URL" "$HEALTHCHECK"; then
    log "Rollback SUCCESSFUL. Live at $(basename "$prev")."
  else
    log "WARNING: health check still failing after rollback. Investigate immediately — do not assume the site is healthy."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
cmd_deploy() {
  cd "$APP_DIR"
  log "=== Deployment started ==="

  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  [[ "$current_branch" == "$BRANCH" ]] || abort "Control checkout is on '$current_branch', expected '$BRANCH'."

  # Only tracked-file modifications matter here: a `git worktree add <sha>` checkout contains
  # committed content only, so untracked scaffolding sitting in the control checkout (this very
  # script, ecosystem.config.cjs, scripts/) can never leak into a release and is not a risk.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    log "Uncommitted modifications to tracked files present in $APP_DIR:"
    git status --porcelain --untracked-files=no | tee -a "$LOG_FILE"
    abort "Refusing to deploy — tracked files have local modifications that differ from HEAD. Commit, stash, or discard them first."
  fi

  log "Fetching origin/$BRANCH..."
  git fetch origin "$BRANCH"
  local target_sha current_sha current_target
  target_sha=$(git rev-parse "origin/$BRANCH")

  # Ask git what commit is actually checked out at the "current" target, rather than parsing the
  # directory name — this works whether it points at a SHA-named release worktree (the normal
  # case after the first real deploy) or, as at bootstrap, directly at the control checkout.
  current_target=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")
  if [[ -n "$current_target" && -d "$current_target" ]]; then
    current_sha=$(git -C "$current_target" rev-parse HEAD 2>/dev/null || echo "none")
  else
    current_sha="none"
  fi

  if [[ "$current_sha" == "$target_sha" ]]; then
    log "Already up to date at $target_sha. Nothing to deploy."
    exit 0
  fi

  git merge --ff-only origin/"$BRANCH" >>"$LOG_FILE" 2>&1 \
    || abort "Fast-forward of control checkout failed — local history has diverged from origin/$BRANCH. Resolve manually."

  # Refuse to deploy backwards or sideways relative to what is actually LIVE right now (not just
  # relative to the control checkout's HEAD, which can legitimately be ahead of origin/main, e.g.
  # right after this deployment system was first set up before anything had been pushed yet).
  if [[ "$current_sha" != "none" ]] && ! git merge-base --is-ancestor "$current_sha" "$target_sha" 2>/dev/null; then
    abort "origin/$BRANCH ($target_sha) is not a descendant of the currently deployed commit ($current_sha) — refusing to deploy backwards or sideways."
  fi

  log "Target commit: $target_sha"
  require_clean_scratch_port

  local release_dir="$RELEASES_DIR/$target_sha"
  if [[ -d "$release_dir" ]]; then
    log "Removing stale partial release at $release_dir"
    git worktree remove --force "$release_dir" 2>/dev/null || rm -rf "$release_dir"
  fi

  log "Creating isolated worktree: $release_dir"
  git worktree add --detach "$release_dir" "$target_sha" >>"$LOG_FILE" 2>&1

  local scratch_pid=""
  cleanup() {
    if [[ -n "$scratch_pid" ]] && kill -0 "$scratch_pid" 2>/dev/null; then
      kill "$scratch_pid" 2>/dev/null || true
      wait "$scratch_pid" 2>/dev/null || true
    fi
  }
  fail_cleanup() {
    cleanup
    log "Deployment FAILED. Live app is untouched. Removing failed release."
    git worktree remove --force "$release_dir" 2>/dev/null || rm -rf "$release_dir"
  }
  trap fail_cleanup ERR

  # .env is never part of git and never copied — every release symlinks the one real file.
  ln -sf "$APP_DIR/.env" "$release_dir/.env"

  cd "$release_dir"

  log "Installing dependencies (npm ci)..."
  npm ci >>"$LOG_FILE" 2>&1

  log "Checking Prisma migration status..."
  npx prisma migrate status >>"$LOG_FILE" 2>&1 || true
  log "Applying pending migrations (prisma migrate deploy — never resets or drops)..."
  npx prisma migrate deploy >>"$LOG_FILE" 2>&1
  npx prisma generate >>"$LOG_FILE" 2>&1

  log "Building production bundle..."
  npm run build >>"$LOG_FILE" 2>&1

  log "Starting isolated instance on 127.0.0.1:$SCRATCH_PORT for pre-cutover health check..."
  (PORT="$SCRATCH_PORT" NODE_ENV=production nohup node_modules/.bin/next start -p "$SCRATCH_PORT" -H 127.0.0.1 \
    >>"$LOG_DIR/precheck.log" 2>&1 & echo $! > /tmp/mocktestseries-precheck.pid)
  scratch_pid=$(cat /tmp/mocktestseries-precheck.pid)

  local up=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$SCRATCH_PORT/" >/dev/null 2>&1; then
      up=1
      break
    fi
    sleep 1
  done
  [[ "$up" == "1" ]] || abort "New release never came up on scratch port $SCRATCH_PORT — see $LOG_DIR/precheck.log"

  if ! BASE_URL="http://127.0.0.1:$SCRATCH_PORT" "$HEALTHCHECK" | tee -a "$LOG_FILE"; then
    abort "Pre-cutover health check FAILED. Live app was never touched."
  fi
  log "Pre-cutover health check PASSED."

  cleanup
  scratch_pid=""

  local previous_release
  previous_release=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")

  log "Cutover: pointing 'current' at $release_dir"
  ln -sfn "$release_dir" "$CURRENT_LINK"

  log "Reloading PM2 (zero-downtime cluster reload)..."
  pm2 reload "$PM2_APP" --update-env >>"$LOG_FILE" 2>&1

  sleep 2
  if ! BASE_URL="$PUBLIC_URL" "$HEALTHCHECK" | tee -a "$LOG_FILE"; then
    log "POST-CUTOVER health check FAILED. Rolling back to $previous_release"
    if [[ -n "$previous_release" ]]; then
      ln -sfn "$previous_release" "$CURRENT_LINK"
      pm2 reload "$PM2_APP" --update-env >>"$LOG_FILE" 2>&1
      sleep 2
      BASE_URL="$PUBLIC_URL" "$HEALTHCHECK" | tee -a "$LOG_FILE" || log "WARNING: site still unhealthy after rollback — investigate immediately."
    fi
    trap - ERR
    abort "Deployment failed post-cutover and was rolled back to the previous release."
  fi

  trap - ERR
  log "Deployment SUCCESSFUL. Live at $target_sha."

  log "Pruning old releases (keeping last $KEEP_RELEASES)..."
  local kept=0
  while IFS= read -r dir; do
    dir="${dir%/}"
    kept=$((kept + 1))
    if [[ $kept -gt $KEEP_RELEASES ]]; then
      git -C "$APP_DIR" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
      log "Pruned $dir"
    fi
  done < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null)

  log "=== Deployment finished ==="
}

# ---------------------------------------------------------------------------
case "${1:-deploy}" in
  deploy) cmd_deploy ;;
  rollback) cmd_rollback ;;
  *) echo "Usage: $0 [deploy|rollback]"; exit 2 ;;
esac
