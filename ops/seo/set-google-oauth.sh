#!/usr/bin/env bash
# Installs the DEDICATED SEO Intelligence Google OAuth client (Search Console + GA4, read-only)
# from hidden input. This is NOT the student "Sign in with Google" client — never reuse that one.
#
#   sudo ops/seo/set-google-oauth.sh          # prompt for Client ID + Client Secret (secret hidden)
#   sudo ops/seo/set-google-oauth.sh status   # installed? connected as? (never a secret)
#   sudo ops/seo/set-google-oauth.sh clear    # revoke + remove the connection and the client
#
# The secret is read with a hidden prompt (or from stdin), never echoed, never passed as a
# command-line argument and never written to shell history, logs or .env. It is encrypted
# with AES-256-GCM (key derived from AUTH_SECRET in the shared .env) and stored in Setting
# "seo.google.oauth". No restart is needed. A Master Admin then connects Google in
# Admin → SEO → Intelligence. The OAuth client's Authorized redirect URI must be exactly
# https://mocktestseries.in/api/admin/seo-intel/google/callback
set -euo pipefail
umask 077
ENV_FILE="${MTS_ENV_FILE:-/var/www/mocktestseries-shared/.env}"
APP_DIR="${MTS_APP_DIR:-/var/www/mocktestseries-current}"
MODE="${1:-set}"
[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
[ -f "$APP_DIR/scripts/set-seo-google-oauth.ts" ] || { echo "The deployed release has no scripts/set-seo-google-oauth.ts (deploy the SEO Intelligence release first)."; exit 1; }
run_node() { # <mode>  (stdin passes through)
  ( set -a; . "$ENV_FILE"; set +a; cd "$APP_DIR" && NODE_OPTIONS=--conditions=react-server ./node_modules/.bin/tsx scripts/set-seo-google-oauth.ts "$1" )
}
case "$MODE" in
  status) run_node status </dev/null ;;
  clear) run_node clear </dev/null ;;
  set)
    if [ -t 0 ]; then
      read -rp "SEO OAuth Client ID (…apps.googleusercontent.com): " CLIENT_ID
      read -rsp "SEO OAuth Client Secret (input hidden): " SECRET
      echo
    else
      IFS= read -r CLIENT_ID || true
      IFS= read -r SECRET || true
    fi
    [ -n "${CLIENT_ID:-}" ] && [ -n "${SECRET:-}" ] || { echo "Client ID and secret are both required. Nothing changed."; exit 1; }
    case "$CLIENT_ID" in *.apps.googleusercontent.com) ;; *) echo "That is not a Google OAuth client ID. Nothing changed."; unset SECRET; exit 1 ;; esac
    printf '%s\n%s\n' "$CLIENT_ID" "$SECRET" | run_node set
    unset SECRET
    ;;
  *) echo "Usage: $0 [set|status|clear]"; exit 2 ;;
esac
