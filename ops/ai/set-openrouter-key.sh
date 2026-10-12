#!/usr/bin/env bash
# Installs the OpenRouter API key for MockTestSeries from hidden input.
#
#   sudo ops/ai/set-openrouter-key.sh          # prompt for the key (hidden), store it encrypted in the DB
#   sudo ops/ai/set-openrouter-key.sh status   # key hint + provider status (never the key)
#   sudo ops/ai/set-openrouter-key.sh clear    # remove the key, disable OpenRouter
#
# The key is read with a hidden prompt (or from stdin), never echoed, never passed as a
# command-line argument and never written to shell history, logs or .env. It is
# encrypted with AES-256-GCM (key derived from AUTH_SECRET in the shared .env) and stored
# in Setting "api.openrouter" — the same scheme as the Claude key. No restart is needed.
# OpenRouter stays DISABLED until a Master Admin runs Test Connection and enables it in
# Admin → AI → Providers. Recommended: set a monthly credit limit on the key in the
# OpenRouter dashboard first.
set -euo pipefail
umask 077

ENV_FILE="${MTS_ENV_FILE:-/var/www/mocktestseries-shared/.env}"
APP_DIR="${MTS_APP_DIR:-/var/www/mocktestseries-current}"
MODE="${1:-key}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
[ -f "$APP_DIR/scripts/set-openrouter-key.ts" ] || { echo "The deployed release has no scripts/set-openrouter-key.ts (deploy the AI Engine release first)."; exit 1; }

run_node() { # <mode>  (stdin passes through)
  ( set -a; . "$ENV_FILE"; set +a; cd "$APP_DIR" && NODE_OPTIONS=--conditions=react-server ./node_modules/.bin/tsx scripts/set-openrouter-key.ts "$1" )
}

case "$MODE" in
  status) run_node status </dev/null ;;
  clear) run_node clear </dev/null ;;
  key)
    if [ -t 0 ]; then
      read -rsp "Paste the OpenRouter API key (input hidden): " SECRET
      echo
    else
      IFS= read -r SECRET || true
    fi
    [ -n "${SECRET:-}" ] || { echo "No key entered. Nothing changed."; exit 1; }
    case "$SECRET" in sk-or-*) ;; *) echo "That is not an OpenRouter key (it starts with sk-or-). Nothing changed."; unset SECRET; exit 1 ;; esac
    printf '%s' "$SECRET" | run_node key
    unset SECRET
    ;;
  *) echo "Usage: $0 [key|status|clear]"; exit 2 ;;
esac
