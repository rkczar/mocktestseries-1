#!/usr/bin/env bash
# Installs the SEO Intelligence PageSpeed Insights / Chrome UX Report API key from hidden input.
#
#   sudo ops/seo/set-pagespeed-key.sh          # prompt for the key (hidden), store it encrypted in the DB
#   sudo ops/seo/set-pagespeed-key.sh status   # installed? 8-char fingerprint + last check (never the key)
#   sudo ops/seo/set-pagespeed-key.sh clear    # remove the key
#
# The key is read with a hidden prompt (or from stdin), never echoed, never passed as a command-line
# argument and never written to shell history, logs or .env. It is encrypted with AES-256-GCM (key
# derived from AUTH_SECRET in the shared .env) and stored in Setting "seo.pagespeed.key". The app
# sends it only in the X-goog-api-key header, never in a URL. No restart is needed.
# In Google Cloud the key should be restricted to: APIs = PageSpeed Insights API + Chrome UX Report
# API; Application restriction = IP addresses (this server's public IP).
set -euo pipefail
umask 077
ENV_FILE="${MTS_ENV_FILE:-/var/www/mocktestseries-shared/.env}"
APP_DIR="${MTS_APP_DIR:-/var/www/mocktestseries-current}"
MODE="${1:-set}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
[ -f "$APP_DIR/scripts/set-seo-pagespeed-key.ts" ] || { echo "The deployed release has no scripts/set-seo-pagespeed-key.ts (deploy the PageSpeed release first)."; exit 1; }
run_node() { # <mode>  (stdin passes through)
  ( set -a; . "$ENV_FILE"; set +a; cd "$APP_DIR" && NODE_OPTIONS=--conditions=react-server ./node_modules/.bin/tsx scripts/set-seo-pagespeed-key.ts "$1" )
}
case "$MODE" in
  status) run_node status </dev/null ;;
  clear) run_node clear </dev/null ;;
  set)
    if [ -t 0 ]; then
      read -rsp "Paste the PageSpeed API key (input hidden): " SECRET
      echo
    else
      IFS= read -r SECRET || true
    fi
    [ -n "${SECRET:-}" ] || { echo "No key entered. Nothing changed."; exit 1; }
    case "$SECRET" in AIza*) ;; *) echo "That is not a Google Cloud API key (it starts with AIza). Nothing changed."; unset SECRET; exit 1 ;; esac
    printf '%s\n' "$SECRET" | run_node set
    unset SECRET
    ;;
  *) echo "Usage: $0 [set|status|clear]"; exit 2 ;;
esac
