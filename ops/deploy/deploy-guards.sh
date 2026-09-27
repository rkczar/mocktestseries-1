# shellcheck shell=bash
# Symlink / release guards for ops/deploy/mocktestseries-deploy.sh.
# Sourced, not executed. Every path is resolved with realpath before use.
#
# Why this exists: on 2026-09-27 a manual `ln -s <shared>/storage
# <release>/public/storage` ran against a release where git had ALREADY
# created public/storage (tracked symlink, mode 120000). `ln` dereferenced
# the existing link-to-directory and created <shared>/storage/storage ->
# <shared>/storage inside shared storage. That loop broke every release
# (ELOOP) and both PM2 workers crashed. The guards below make that
# impossible: links are created only with `ln -sfnT` (never into an
# existing directory), never inside shared storage, never pointing at an
# ancestor of themselves, current, or the release being assembled.
#
# Paths may be overridden via env (the self-test uses temp dirs):
#   RELEASES_DIR SHARED_DIR CURRENT_LINK

RELEASES_DIR="${RELEASES_DIR:-/var/www/mocktestseries-releases}"
SHARED_DIR="${SHARED_DIR:-/var/www/mocktestseries-shared}"
CURRENT_LINK="${CURRENT_LINK:-/var/www/mocktestseries-current}"

guard_fail() {
  echo "GUARD FAIL: $*" >&2
  return 1
}

# is_within CHILD PARENT — both already realpath'd. True if CHILD == PARENT or below it.
is_within() {
  [ "$1" = "$2" ] || [[ "$1" == "$2"/* ]]
}

# Shared storage must be real directories with no symlinks anywhere inside,
# so nothing in it can ever resolve back into itself, current or a release.
check_shared_clean() {
  local shared_real links
  shared_real=$(realpath -e "$SHARED_DIR") || guard_fail "shared dir $SHARED_DIR does not resolve" || return 1
  [ -d "$shared_real" ] || guard_fail "shared dir $shared_real is not a directory" || return 1
  [ -L "$SHARED_DIR" ] && { guard_fail "shared dir $SHARED_DIR must not itself be a symlink"; return 1; }
  links=$(find "$shared_real" -type l 2>/dev/null)
  if [ -n "$links" ]; then
    guard_fail "symlinks found inside shared storage (possible loop):"$'\n'"$links"
    return 1
  fi
  local rel_real cur_real
  rel_real=$(realpath -e "$RELEASES_DIR") || guard_fail "releases dir does not resolve" || return 1
  if is_within "$shared_real" "$rel_real" || is_within "$rel_real" "$shared_real"; then
    guard_fail "shared ($shared_real) and releases ($rel_real) overlap"
    return 1
  fi
  if [ -e "$CURRENT_LINK" ] || [ -L "$CURRENT_LINK" ]; then
    cur_real=$(realpath -m "$(dirname "$CURRENT_LINK")")
    is_within "$cur_real" "$shared_real" && { guard_fail "current link lives inside shared storage"; return 1; }
  fi
  return 0
}

# safe_link TARGET LINK — create LINK -> TARGET, or accept it if it already
# resolves to exactly TARGET. Rejects: missing target; link inside shared
# storage; link inside (or equal to) its own target (a loop); target inside
# the release being assembled or inside current; replacing a real
# file/directory. Never dereferences an existing link (ln -sfnT).
safe_link() {
  local target="$1" link="$2" target_real link_parent_real shared_real cur_real link_real
  target_real=$(realpath -e "$target") || guard_fail "link target $target does not exist" || return 1
  link_parent_real=$(realpath -e "$(dirname "$link")") || guard_fail "link parent of $link does not exist" || return 1
  shared_real=$(realpath -e "$SHARED_DIR") || guard_fail "shared dir does not resolve" || return 1
  local link_abs="$link_parent_real/$(basename "$link")"

  is_within "$link_parent_real" "$shared_real" && { guard_fail "refusing to create a symlink inside shared storage: $link_abs"; return 1; }
  is_within "$link_abs" "$target_real" && { guard_fail "circular: $link_abs is inside its own target $target_real"; return 1; }
  [ "$link_abs" = "$target_real" ] && { guard_fail "circular: $link_abs points at itself"; return 1; }
  if [ -n "${ASSEMBLING_RELEASE:-}" ]; then
    local asm_real
    asm_real=$(realpath -e "$ASSEMBLING_RELEASE") || return 1
    is_within "$target_real" "$asm_real" && { guard_fail "target $target_real is inside the release being assembled"; return 1; }
  fi
  if [ -L "$CURRENT_LINK" ]; then
    cur_real=$(realpath -e "$CURRENT_LINK" 2>/dev/null || true)
    [ -n "$cur_real" ] && is_within "$target_real" "$cur_real" && { guard_fail "target $target_real is inside current ($cur_real)"; return 1; }
    [ "$target_real" = "$(realpath -m "$CURRENT_LINK")" ] && { guard_fail "target is the current link"; return 1; }
  fi

  if [ -L "$link_abs" ]; then
    link_real=$(realpath -e "$link_abs" 2>/dev/null) || guard_fail "existing link $link_abs is broken or looping" || return 1
    if [ "$link_real" = "$target_real" ]; then
      echo "ok: $link_abs already -> $target_real"
      return 0
    fi
    guard_fail "existing link $link_abs -> $link_real, expected $target_real (not replacing silently)"
    return 1
  fi
  [ -e "$link_abs" ] && { guard_fail "$link_abs exists and is not a symlink (refusing to replace a real file/dir)"; return 1; }

  ln -snT "$target_real" "$link_abs" || return 1
  link_real=$(realpath -e "$link_abs" 2>/dev/null) || guard_fail "new link $link_abs does not resolve" || return 1
  [ "$link_real" = "$target_real" ] || { guard_fail "new link $link_abs resolves to $link_real, expected $target_real"; return 1; }
  echo "linked: $link_abs -> $target_real"
}

# check_release_dir DIR — DIR is a real 40-hex directory directly under the
# releases dir, not current's target unless ALLOW_CURRENT=1.
check_release_dir() {
  local dir="$1" rel_real dir_real
  rel_real=$(realpath -e "$RELEASES_DIR") || return 1
  [ -L "$dir" ] && { guard_fail "release $dir must not be a symlink"; return 1; }
  dir_real=$(realpath -e "$dir") || guard_fail "release $dir does not exist" || return 1
  [ "$(dirname "$dir_real")" = "$rel_real" ] || { guard_fail "release $dir_real is not directly under $rel_real"; return 1; }
  [[ "$(basename "$dir_real")" =~ ^[0-9a-f]{40}$ ]] || { guard_fail "release name $(basename "$dir_real") is not a 40-hex SHA"; return 1; }
  return 0
}

# check_release_links DIR — the release's own symlinks (node_modules skipped)
# all resolve without loops, none points at an ancestor of itself, and the
# two shared links resolve to exactly the shared paths.
check_release_links() {
  local dir="$1" dir_real shared_real l l_real
  dir_real=$(realpath -e "$dir") || return 1
  shared_real=$(realpath -e "$SHARED_DIR") || return 1
  while IFS= read -r l; do
    [ -z "$l" ] && continue
    l_real=$(realpath -e "$l" 2>/dev/null) || { guard_fail "symlink $l is broken or circular"; return 1; }
    is_within "$(realpath -m "$(dirname "$l")")" "$l_real" && { guard_fail "symlink $l points at its own ancestor $l_real (loop)"; return 1; }
  done < <(find "$dir_real" -path "$dir_real/node_modules" -prune -o -type l -print)
  [ "$(realpath -e "$dir_real/.env" 2>/dev/null)" = "$shared_real/.env" ] || { guard_fail "$dir_real/.env does not resolve to $shared_real/.env"; return 1; }
  [ -L "$dir_real/public/storage" ] || { guard_fail "$dir_real/public/storage is not a symlink"; return 1; }
  [ "$(realpath -e "$dir_real/public/storage" 2>/dev/null)" = "$shared_real/storage" ] || { guard_fail "$dir_real/public/storage does not resolve to $shared_real/storage"; return 1; }
  return 0
}

# check_current_link — current is a symlink (not a dir), outside shared,
# resolving to exactly one release directory.
check_current_link() {
  [ -L "$CURRENT_LINK" ] || { guard_fail "$CURRENT_LINK is not a symlink"; return 1; }
  local t
  t=$(realpath -e "$CURRENT_LINK") || guard_fail "$CURRENT_LINK does not resolve" || return 1
  check_release_dir "$t"
}

# atomic_switch RELEASE — swap current with a same-directory rename (mv -T is atomic).
atomic_switch() {
  local rel_real tmp
  rel_real=$(realpath -e "$1") || return 1
  check_release_dir "$rel_real" || return 1
  tmp="$(dirname "$CURRENT_LINK")/.$(basename "$CURRENT_LINK").tmp.$$"
  ln -snT "$rel_real" "$tmp" || return 1
  mv -T "$tmp" "$CURRENT_LINK" || { rm -f "$tmp"; return 1; }
  [ "$(realpath -e "$CURRENT_LINK")" = "$rel_real" ] || { guard_fail "current does not resolve to $rel_real after switch"; return 1; }
}
