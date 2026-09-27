#!/usr/bin/env bash
# Self-test for ops/deploy/deploy-guards.sh. Uses ONLY a throwaway mktemp
# tree (fake releases/shared/current) — never touches /var/www.
#   bash ops/deploy/test-deploy-guards.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T=$(mktemp -d /tmp/mts-deploy-guard-test.XXXXXX)
trap 'rm -rf -- "$T"' EXIT
export RELEASES_DIR="$T/releases" SHARED_DIR="$T/shared" CURRENT_LINK="$T/current"
# shellcheck source=ops/deploy/deploy-guards.sh
source "$HERE/deploy-guards.sh"

fails=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; fails=$((fails + 1)); }
expect_ok() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi; }
expect_reject() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$d (was accepted)"; else pass "$d"; fi; }

A=$(printf 'a%.0s' {1..40}); B=$(printf 'b%.0s' {1..40})
mkdir -p "$SHARED_DIR/storage/test-resources" "$RELEASES_DIR/$A/public" "$RELEASES_DIR/$B/public" "$RELEASES_DIR/$A/.next"
echo x >"$SHARED_DIR/.env"; echo keep >"$SHARED_DIR/storage/test-resources/file.pdf"; echo id >"$RELEASES_DIR/$A/.next/BUILD_ID"
ln -s "$SHARED_DIR/.env" "$RELEASES_DIR/$A/.env"; ln -s "$SHARED_DIR/storage" "$RELEASES_DIR/$A/public/storage"
ln -s "$RELEASES_DIR/$A" "$CURRENT_LINK"
ln -s "$SHARED_DIR/.env" "$RELEASES_DIR/$B/.env"

echo "1. The 2026-09-27 incident, reproduced safely"
# Candidate B already has public/storage from git (tracked symlink).
ln -s "$SHARED_DIR/storage" "$RELEASES_DIR/$B/public/storage"
expect_ok "baseline shared storage is clean" check_shared_clean
ln -s "$SHARED_DIR/storage" "$RELEASES_DIR/$B/public/storage" 2>/dev/null # the old manual command
[ -L "$SHARED_DIR/storage/storage" ] && pass "old 'ln -s' creates shared/storage/storage (bug reproduced)" || fail "could not reproduce the old bug"
expect_reject "check_shared_clean detects the loop" check_shared_clean
expect_ok "…while B's own links still look valid (why a shared-storage scan is required)" check_release_links "$RELEASES_DIR/$B"
expect_reject "full candidate validation (shared + release) rejects it" bash -c "source '$HERE/deploy-guards.sh'; check_shared_clean && check_release_links '$RELEASES_DIR/$B'"
rm "$SHARED_DIR/storage/storage"
expect_ok "safe_link on the pre-existing tracked link is a no-op" env ASSEMBLING_RELEASE="$RELEASES_DIR/$B" bash -c "source '$HERE/deploy-guards.sh'; safe_link '$SHARED_DIR/storage' '$RELEASES_DIR/$B/public/storage'"
[ ! -e "$SHARED_DIR/storage/storage" ] && pass "…and creates nothing inside shared storage" || fail "safe_link wrote into shared storage"
expect_ok "shared storage still clean" check_shared_clean

echo "2. Circular / unsafe link targets are rejected"
expect_reject "link inside shared storage" safe_link "$SHARED_DIR/storage" "$SHARED_DIR/storage/loop"
expect_reject "link inside its own target (loop)" safe_link "$RELEASES_DIR/$B" "$RELEASES_DIR/$B/public/self"
expect_reject "link pointing at its own parent chain" safe_link "$RELEASES_DIR" "$RELEASES_DIR/$B/public/up"
expect_reject "target inside the release being assembled" env ASSEMBLING_RELEASE="$RELEASES_DIR/$B" bash -c "source '$HERE/deploy-guards.sh'; safe_link '$RELEASES_DIR/$B/public' '$RELEASES_DIR/$B/pub2'"
expect_reject "target inside current" safe_link "$RELEASES_DIR/$A/public" "$RELEASES_DIR/$B/cur-pub"
expect_reject "missing target" safe_link "$T/nope" "$RELEASES_DIR/$B/nope"
ln -s "$SHARED_DIR/.env" "$RELEASES_DIR/$B/wrong"
expect_reject "existing link to a different target is not replaced silently" safe_link "$SHARED_DIR/storage" "$RELEASES_DIR/$B/wrong"
mkdir "$RELEASES_DIR/$B/realdir"
expect_reject "real directory at the link path is not replaced" safe_link "$SHARED_DIR/storage" "$RELEASES_DIR/$B/realdir"
expect_ok "valid new link is created and verified" safe_link "$SHARED_DIR/.env" "$RELEASES_DIR/$B/env-copy-link"
rm "$RELEASES_DIR/$B/env-copy-link"
rm "$RELEASES_DIR/$B/wrong"; rmdir "$RELEASES_DIR/$B/realdir"

echo "3. Release / current validation"
ln -s "$RELEASES_DIR/$B/public/loop2" "$RELEASES_DIR/$B/public/loop1"; ln -s "$RELEASES_DIR/$B/public/loop1" "$RELEASES_DIR/$B/public/loop2"
expect_reject "circular symlink pair inside a release" check_release_links "$RELEASES_DIR/$B"
rm "$RELEASES_DIR/$B/public/loop1" "$RELEASES_DIR/$B/public/loop2"
ln -s "$RELEASES_DIR/$B" "$RELEASES_DIR/$B/public/ancestor"
expect_reject "symlink pointing at its own ancestor" check_release_links "$RELEASES_DIR/$B"
rm "$RELEASES_DIR/$B/public/ancestor"
expect_ok "clean release B validates" check_release_links "$RELEASES_DIR/$B"
expect_reject "non-SHA release name" check_release_dir "$SHARED_DIR/storage"
expect_ok "current resolves to exactly one release" check_current_link

echo "4. Atomic switch + rollback"
expect_reject "switch to shared storage is refused" atomic_switch "$SHARED_DIR/storage"
[ "$(realpath -e "$CURRENT_LINK")" = "$RELEASES_DIR/$A" ] && pass "…current unchanged after refused switch" || fail "current changed"
expect_ok "switch to release B" atomic_switch "$RELEASES_DIR/$B"
[ "$(realpath -e "$CURRENT_LINK")" = "$RELEASES_DIR/$B" ] && [ -L "$CURRENT_LINK" ] && pass "…current -> B, still a symlink" || fail "switch result wrong"
expect_ok "rollback to release A" atomic_switch "$RELEASES_DIR/$A"
[ "$(cat "$SHARED_DIR/storage/test-resources/file.pdf")" = "keep" ] && pass "shared user files untouched" || fail "shared file changed"
[ -d "$RELEASES_DIR/$B" ] && pass "previous release kept after rollback" || fail "release removed"

echo "5. Layout guards"
mv "$CURRENT_LINK" "$T/current.bak"; mkdir "$CURRENT_LINK"
expect_reject "current as a real directory is rejected" check_current_link
rmdir "$CURRENT_LINK"; mv "$T/current.bak" "$CURRENT_LINK"
expect_reject "current link inside shared storage is rejected" env CURRENT_LINK="$SHARED_DIR/current" bash -c "ln -s '$RELEASES_DIR/$A' '$SHARED_DIR/current'; source '$HERE/deploy-guards.sh'; check_shared_clean"
rm -f "$SHARED_DIR/current"

echo
if [ $fails -eq 0 ]; then echo "ALL DEPLOY GUARD CHECKS PASSED"; else echo "$fails DEPLOY GUARD CHECK(S) FAILED"; exit 1; fi
