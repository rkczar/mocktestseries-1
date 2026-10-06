#!/usr/bin/env bash
# One Live CBT load step (ops/load-test/k6/live-cbt.js) against the ISOLATED
# stack — a separate PM2 daemon (PM2_HOME_LT) running the current build on a
# loadtest database behind a temporary local nginx listener — while sampling
# every second: app CPU/RSS, PostgreSQL CPU, load, RAM, loadtest DB
# connections, isolated PM2 restarts, nginx 5xx, and the LIVE site's
# /api/health. Aborts k6 when the live site degrades (non-200 or > 2.0 s
# three samples in a row) or available RAM drops below 800 MB — real
# students always win.
#
#   PSQL_URL=postgresql://u:p@127.0.0.1:5432 LT_DB=mts_loadtest_live PM2_HOME_LT=/tmp/pm2-lt \
#   BASE=http://127.0.0.1:8088 NGINX_LOG=/var/log/nginx/lt-live.access.log \
#     ops/load-test/run-live-cbt.sh <candidates> <mock index> <window seconds> <fixture.json> <out dir>
set -u
N=$1; MOCKIDX=$2; WIN=$3; FIX=$4; OUT=$5
BASE="${BASE:-http://127.0.0.1:8088}"
mkdir -p "$OUT"
START_MS=$(( $(date +%s%3N) + 45000 ))
SETUP=$(DATABASE_URL="$PSQL_URL/$LT_DB?schema=public" NODE_OPTIONS=--conditions=react-server npx tsx ops/load-test/live-cbt-setup.ts "$FIX" --mock "$MOCKIDX" --candidates "$N" --start-ms "$START_MS" --window-s "$WIN")
echo "$SETUP" > "$OUT/setup.json"
MOCK=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['mockId'])" "$SETUP")
END_MS=$(( START_MS + WIN * 1000 ))
APP_PIDS=$(PM2_HOME=$PM2_HOME_LT pm2 jlist | python3 -c "import sys,json;print(' '.join(str(p['pid']) for p in json.load(sys.stdin)))")
R0=$(PM2_HOME=$PM2_HOME_LT pm2 jlist | python3 -c "import sys,json;print(sum(p['pm2_env']['restart_time'] for p in json.load(sys.stdin)))")
N5XX0=$(awk '$9 ~ /^5/' "$NGINX_LOG" 2>/dev/null | wc -l)

k6 run --quiet --summary-export "$OUT/summary.json" -e BASE="$BASE" -e FIXTURE="$FIX" -e MOCK="$MOCK" -e START_MS="$START_MS" -e END_MS="$END_MS" -e CANDIDATES="$N" \
  ops/load-test/k6/live-cbt.js > "$OUT/k6.log" 2>&1 &
K6=$!

echo "t,app_cpu_pct,pg_cpu_pct,load1,mem_avail_mb,lt_conns,prod_health_s,prod_code,app_rss_mb,restarts" > "$OUT/samples.csv"
ticks() { awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null || echo 0; }
sum_ticks() { local s=0; for p in "$@"; do s=$((s + $(ticks "$p"))); done; echo $s; }
HZ=$(getconf CLK_TCK); slow=0; reason=""
prev_app=$(sum_ticks $APP_PIDS); prev_pg=$(sum_ticks $(pgrep -x postgres)); prev_t=$(date +%s%N)
while kill -0 $K6 2>/dev/null; do
  sleep 1
  now_t=$(date +%s%N); dt=$(( (now_t - prev_t) / 1000000 )); prev_t=$now_t
  cur_app=$(sum_ticks $APP_PIDS); cur_pg=$(sum_ticks $(pgrep -x postgres))
  app_pct=$(( (cur_app - prev_app) * 100000 / HZ / dt )); pg_pct=$(( (cur_pg - prev_pg) * 100000 / HZ / dt ))
  prev_app=$cur_app; prev_pg=$cur_pg
  load1=$(cut -d' ' -f1 /proc/loadavg)
  mem=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  conns=$(psql "$PSQL_URL/postgres" -XAtc "select count(*) from pg_stat_activity where datname='$LT_DB'" 2>/dev/null || echo -1)
  read -r code secs < <(curl -s -o /dev/null -m 5 -w "%{http_code} %{time_total}\n" https://mocktestseries.in/api/health || echo "000 5") || true
  rss=0; for p in $APP_PIDS; do rss=$(( rss + $(awk '/VmRSS/ {print $2}' /proc/$p/status 2>/dev/null || echo 0) )); done
  restarts=$(PM2_HOME=$PM2_HOME_LT pm2 jlist | python3 -c "import sys,json;print(sum(p['pm2_env']['restart_time'] for p in json.load(sys.stdin)))")
  echo "$(date +%s),$app_pct,$pg_pct,$load1,$mem,$conns,$secs,$code,$((rss/1024)),$restarts" >> "$OUT/samples.csv"
  if [ "$restarts" != "$R0" ]; then APP_PIDS=$(PM2_HOME=$PM2_HOME_LT pm2 jlist | python3 -c "import sys,json;print(' '.join(str(p['pid']) for p in json.load(sys.stdin)))"); fi
  if [ "$code" != "200" ] || awk "BEGIN{exit !($secs > 2.0)}"; then slow=$((slow+1)); else slow=0; fi
  if [ $slow -ge 3 ]; then reason="LIVE SITE DEGRADED (health $code ${secs}s x3)"; fi
  if [ "$mem" -lt 800 ]; then reason="RAM $mem MB < 800"; fi
  if [ -n "$reason" ]; then kill $K6; echo "ABORTED: $reason" | tee "$OUT/aborted.txt"; break; fi
done
wait $K6 2>/dev/null
N5XX1=$(awk '$9 ~ /^5/' "$NGINX_LOG" 2>/dev/null | wc -l)
R1=$(PM2_HOME=$PM2_HOME_LT pm2 jlist | python3 -c "import sys,json;print(sum(p['pm2_env']['restart_time'] for p in json.load(sys.stdin)))")
echo "{\"nginx_5xx\": $((N5XX1 - N5XX0)), \"pm2_restarts\": $((R1 - R0)), \"start_ms\": $START_MS, \"end_ms\": $END_MS}" > "$OUT/extra.json"
echo "done N=$N ${reason:+(aborted: $reason)}"
