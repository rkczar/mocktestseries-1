#!/usr/bin/env bash
# Local watchdog for mocktestseries.in — installed via
# ops/monitoring/mocktestseries-watchdog.cron (every 5 minutes).
#
# Checks the things that previously failed silently: app/DB health, PM2
# workers stopped after a crash loop, disk filling with releases, TLS expiry
# and a stale nightly DB backup. Every run appends one line to watchdog.log;
# problems are logged as ALERT and the current state is kept in
# watchdog-status.txt (Admin/ops can read it, and an external monitor can
# watch /api/health).
#
# The only corrective action: when PM2 has given up on the app (stopped or
# errored — never while it is online or reloading), it is restarted, at most
# once every 30 minutes. It never touches releases, symlinks, the database or
# backups.
set -uo pipefail

PM2_APP="${PM2_APP:-mocktestseries}"
APP_PORT="${APP_PORT:-3002}"
DOMAIN="${DOMAIN:-mocktestseries.in}"
LOG_DIR="${LOG_DIR:-/var/log/mocktestseries}"
DUMP_DIR="${DUMP_DIR:-/var/backups/mocktestseries/postgres}"
DISK_WARN_PCT="${DISK_WARN_PCT:-85}"
CERT_WARN_DAYS="${CERT_WARN_DAYS:-14}"
DUMP_MAX_AGE_H="${DUMP_MAX_AGE_H:-26}"
STATE_DIR="${STATE_DIR:-/var/lib/mocktestseries-watchdog}"

mkdir -p "$LOG_DIR" "$STATE_DIR"
LOG="$LOG_DIR/watchdog.log"
alerts=()
notes=()

# 1. App + database.
health=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$APP_PORT/api/health" || echo 000)
[ "$health" = "200" ] || alerts+=("health endpoint returned $health")

# 2. PM2 workers.
pm2_states=$(pm2 jlist 2>/dev/null | APP="$PM2_APP" python3 -c '
import json, os, sys
try:
    procs = [p for p in json.load(sys.stdin) if p["name"] == os.environ["APP"]]
except Exception:
    procs = []
print(" ".join(p["pm2_env"]["status"] for p in procs) or "missing")' 2>/dev/null || echo "unknown")
case " $pm2_states " in
  *" stopped "*|*" errored "*|" missing ")
    alerts+=("pm2 workers: $pm2_states")
    last=$(cat "$STATE_DIR/last-restart" 2>/dev/null || echo 0)
    if [ $(( $(date +%s) - last )) -ge 1800 ]; then
      date +%s >"$STATE_DIR/last-restart"
      if pm2 restart "$PM2_APP" >/dev/null 2>&1; then notes+=("pm2 restart issued"); else alerts+=("pm2 restart FAILED"); fi
    else
      notes+=("pm2 restart skipped (one already issued in the last 30 min)")
    fi
    ;;
esac

# 3. Disk (releases are ~1.4 GB each; retention is Admin → Backup → Releases).
disk_pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ -n "$disk_pct" ] && [ "$disk_pct" -ge "$DISK_WARN_PCT" ] && alerts+=("root disk ${disk_pct}% used")

# 4. TLS certificate.
if expiry=$(echo | timeout 10 openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2); then
  if [ -n "$expiry" ]; then
    days=$(( ($(date -d "$expiry" +%s) - $(date +%s)) / 86400 ))
    [ "$days" -lt "$CERT_WARN_DAYS" ] && alerts+=("TLS certificate expires in $days days")
  fi
fi

# 5. Nightly DB backup freshness.
newest=$(find "$DUMP_DIR" -maxdepth 1 -name 'mocktestseries-*.dump' -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
if [ -z "$newest" ]; then
  alerts+=("no database dump found in $DUMP_DIR")
else
  age_h=$(( ($(date +%s) - ${newest%.*}) / 3600 ))
  [ "$age_h" -ge "$DUMP_MAX_AGE_H" ] && alerts+=("newest database dump is ${age_h}h old")
fi

ts=$(date -u +%FT%TZ)
summary="health=$health pm2=[$pm2_states] disk=${disk_pct:-?}% cert_days=${days:-?}"
if [ ${#alerts[@]} -gt 0 ]; then
  line="[$ts] ALERT $(IFS='; '; echo "${alerts[*]}") | $summary"
else
  line="[$ts] OK $summary"
fi
[ ${#notes[@]} -gt 0 ] && line="$line | $(IFS='; '; echo "${notes[*]}")"
echo "$line" >>"$LOG"
echo "$line" >"$LOG_DIR/watchdog-status.txt"
[ ${#alerts[@]} -eq 0 ]
