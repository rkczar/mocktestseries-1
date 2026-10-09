#!/usr/bin/env bash
# Installs the Instagram API credentials in the MockTestSeries shared .env from hidden input.
#
#   sudo ops/instagram/set-instagram-token.sh              # INSTAGRAM_ACCESS_TOKEN (+ INSTAGRAM_USER_ID, INSTAGRAM_TOKEN_SET_AT)
#   sudo ops/instagram/set-instagram-token.sh app-secret   # INSTAGRAM_APP_SECRET (only if "Require App Secret" is on)
#   sudo ops/instagram/set-instagram-token.sh clear        # removes the token + app secret (e.g. after a leak)
#   sudo ops/instagram/set-instagram-token.sh status       # shows which variables are set (never their values)
#
# Secrets are read with a hidden prompt (or from stdin), never echoed, never passed
# as a command-line argument and never written to shell history or logs. The
# rollback copy of .env left behind has every Instagram and Resend secret
# blanked, so no secret piles up in backups. Run `pm2 reload mocktestseries`
# afterwards, then Admin → Instagram → Settings → Test connection.
set -euo pipefail
umask 077

ENV_FILE="${MTS_ENV_FILE:-/var/www/mocktestseries-shared/.env}"
MODE="${1:-token}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }

# Rewrites <src> into <dst> with VAR set to stdin's value (empty stdin = blanked),
# dropping duplicate entries. The value reaches python on stdin only.
rewrite() { # <var> <src> <dst>
  python3 -c '
import re, sys
var, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
value = sys.stdin.read()
out, done = [], False
for line in open(src).read().splitlines():
    if re.match(r"\s*(export\s+)?" + re.escape(var) + r"\s*=", line):
        if not done:
            out.append(var + "=" + value)
            done = True
        continue
    out.append(line)
if not done:
    out.append(var + "=" + value)
open(dst, "w").write("\n".join(out) + "\n")
' "$1" "$2" "$3"
}

is_set() { grep -Eq "^$1=.+" "$ENV_FILE" && echo yes || echo no; }

status() {
  echo "INSTAGRAM_ACCESS_TOKEN set: $(is_set INSTAGRAM_ACCESS_TOKEN)"
  echo "INSTAGRAM_APP_SECRET set:   $(is_set INSTAGRAM_APP_SECRET)"
  echo "INSTAGRAM_USER_ID:          $(grep -E '^INSTAGRAM_USER_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  echo "INSTAGRAM_TOKEN_SET_AT:     $(grep -E '^INSTAGRAM_TOKEN_SET_AT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  for v in INSTAGRAM_ACCESS_TOKEN INSTAGRAM_APP_SECRET INSTAGRAM_USER_ID INSTAGRAM_TOKEN_SET_AT; do
    n=$(grep -c "^$v=" "$ENV_FILE" || true)
    [ "$n" -le 1 ] || echo "WARNING: $v appears $n times."
  done
  echo "Permissions: $(stat -c '%a %U:%G' "$ENV_FILE")"
}

# Rollback copy of the current file with all Instagram + Resend secrets blanked.
backup() {
  BACKUP="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)-$$"
  cp "$ENV_FILE" "$BACKUP"
  chmod 600 "$BACKUP"
  for v in INSTAGRAM_ACCESS_TOKEN INSTAGRAM_APP_SECRET RESEND_API_KEY RESEND_WEBHOOK_SECRET; do
    if grep -Eq "^\s*(export\s+)?$v\s*=" "$BACKUP"; then printf '' | rewrite "$v" "$BACKUP" "$BACKUP"; fi
  done
}

# Atomically writes a staged copy over the live file.
commit() { # <tmp>
  chmod 600 "$1"
  chown root:root "$1"
  mv -f "$1" "$ENV_FILE"
}

read_secret() { # <prompt>  → SECRET
  if [ -t 0 ]; then
    read -rsp "$1" SECRET
    echo
  else
    IFS= read -r SECRET || true
  fi
  SECRET="$(printf '%s' "$SECRET" | tr -d '[:space:]')"
}

case "$MODE" in
  status)
    status
    exit 0
    ;;
  token)
    read_secret "Paste the NEW Instagram access token (input hidden), then press Enter: "
    if ! printf '%s' "$SECRET" | grep -Eq '^IG[A-Za-z0-9._-]{40,1024}$'; then
      unset SECRET
      echo "That does not look like an Instagram User access token (starts with IG, 42+ characters). Nothing changed."
      exit 1
    fi
    CURRENT_ID="$(grep -E '^INSTAGRAM_USER_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
    if [ -t 0 ]; then
      read -rp "Instagram User ID (numbers only; Enter keeps '${CURRENT_ID:-not set}'): " USER_ID
    else
      IFS= read -r USER_ID || true
    fi
    USER_ID="$(printf '%s' "${USER_ID:-}" | tr -d '[:space:]')"
    if [ -n "$USER_ID" ] && ! printf '%s' "$USER_ID" | grep -Eq '^[0-9]{5,25}$'; then
      unset SECRET
      echo "The Instagram User ID must be digits only. Nothing changed."
      exit 1
    fi
    backup
    TMP="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
    printf '%s' "$SECRET" | rewrite INSTAGRAM_ACCESS_TOKEN "$ENV_FILE" "$TMP"
    unset SECRET
    date -u +%Y-%m-%dT%H:%M:%SZ | tr -d '\n' | rewrite INSTAGRAM_TOKEN_SET_AT "$TMP" "$TMP"
    if [ -n "$USER_ID" ]; then printf '%s' "$USER_ID" | rewrite INSTAGRAM_USER_ID "$TMP" "$TMP"; fi
    commit "$TMP"
    ;;
  app-secret)
    read_secret "Paste the Instagram app secret (input hidden), then press Enter: "
    if ! printf '%s' "$SECRET" | grep -Eq '^[a-f0-9]{32}$'; then
      unset SECRET
      echo "That does not look like a Meta app secret (32 hex characters). Nothing changed."
      exit 1
    fi
    backup
    TMP="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
    printf '%s' "$SECRET" | rewrite INSTAGRAM_APP_SECRET "$ENV_FILE" "$TMP"
    unset SECRET
    commit "$TMP"
    ;;
  clear)
    backup
    TMP="$(mktemp "$ENV_FILE.tmp.XXXXXX")"
    printf '' | rewrite INSTAGRAM_ACCESS_TOKEN "$ENV_FILE" "$TMP"
    printf '' | rewrite INSTAGRAM_APP_SECRET "$TMP" "$TMP"
    printf '' | rewrite INSTAGRAM_TOKEN_SET_AT "$TMP" "$TMP"
    commit "$TMP"
    ;;
  *)
    echo "Usage: $0 [token|app-secret|clear|status]"
    exit 1
    ;;
esac

echo "Done."
status
echo "Rollback copy (Instagram + Resend secrets blanked): $BACKUP"
echo "Next: pm2 reload mocktestseries, then Admin → Instagram → Settings → Test connection."
echo "Do NOT paste the token into chat, tickets or commits."
