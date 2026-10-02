#!/usr/bin/env bash
# Light, guarded load step against the ISOLATED instance (never production).
#
#   ops/load-test/run-light.sh <scenario> <rate/s> <duration> <fixture.json> <outdir>
#
# While k6 runs, samples every second: CPU of the isolated app process tree,
# all postgres backends and k6 itself; free RAM; loadtest DB connections; and
# the LIVE site's /api/health latency. Aborts k6 immediately when the live
# site slows (>1.0s twice in a row, or non-200) or the 1-min load average
# exceeds 1.6 (2 vCPUs) — real students always win.
set -euo pipefail
SCEN="$1"; RATE="$2"; DUR="$3"; FIX="$4"; OUT="$5"
BASE="${BASE:-http://127.0.0.1:3100}"
LT_DB="${LT_DB:-mts_loadtest_20260930}"
PSQL_URL="${PSQL_URL:?postgres URL without db name, e.g. postgresql://user:pw@127.0.0.1:5432}"
mkdir -p "$OUT"
APP_PID=$(ss -ltnpH "sport = :${BASE##*:}" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$APP_PID" ] || { echo "isolated app not listening on $BASE"; exit 2; }
TICK=$(getconf CLK_TCK)
tree_ticks() { # utime+stime of a pid and all its descendants
  local t=0 p
  for p in $(pstree -p -T "$1" | grep -o '([0-9]*)' | tr -d '()'); do
    [ -r /proc/$p/stat ] && t=$((t + $(awk '{print $14+$15}' /proc/$p/stat)))
  done; echo $t; }
pg_ticks() { local t=0 p; for p in $(pgrep -x postgres); do [ -r /proc/$p/stat ] && t=$((t + $(awk '{print $14+$15}' /proc/$p/stat))); done; echo $t; }

k6 run --quiet --summary-export "$OUT/summary.json" -e BASE="$BASE" -e FIXTURE="$FIX" -e SCENARIO="$SCEN" -e RATE="$RATE" -e DURATION="$DUR" \
  "$(dirname "$0")/k6/scenarios.js" > "$OUT/k6.log" 2>&1 &
K6=$!
echo "t,app_cpu_pct,pg_cpu_pct,k6_cpu_pct,load1,mem_avail_mb,lt_conns,prod_health_s,prod_code,app_rss_mb" > "$OUT/samples.csv"
a0=$(tree_ticks "$APP_PID"); g0=$(pg_ticks); k0=$(tree_ticks $K6); slow=0; t=0; reason=""; w0=$(date +%s%N)
while kill -0 $K6 2>/dev/null; do
  sleep 1; t=$((t+1))
  a1=$(tree_ticks "$APP_PID"); g1=$(pg_ticks); k1=$(tree_ticks $K6 2>/dev/null || echo "$k0"); w1=$(date +%s%N)
  el=$(( (w1-w0)/10000000 )); [ $el -gt 0 ] || el=100   # elapsed in 1/100 s
  read -r code secs < <(curl -s -o /dev/null -m 5 -w "%{http_code} %{time_total}\n" https://mocktestseries.in/api/health || echo "000 5") || true
  conns=$(psql "$PSQL_URL/$LT_DB" -Atc "select count(*) from pg_stat_activity where datname='$LT_DB'" 2>/dev/null || echo -1)
  load1=$(cut -d' ' -f1 /proc/loadavg); mem=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  # CPU % of ONE vCPU over the real elapsed interval (200% = both vCPUs busy).
  echo "$t,$(( (a1-a0)*10000/TICK/el )),$(( (g1-g0)*10000/TICK/el )),$(( (k1-k0)*10000/TICK/el )),$load1,$mem,$conns,$secs,$code,$(( $(awk '/VmRSS/{print $2}' /proc/$APP_PID/status) / 1024 ))" >> "$OUT/samples.csv"
  a0=$a1; g0=$g1; k0=$k1; w0=$w1
  if [ "$code" != "200" ] || awk "BEGIN{exit !($secs > 1.0)}"; then slow=$((slow+1)); else slow=0; fi
  if [ $slow -ge 2 ]; then reason="LIVE SITE SLOW/ERROR ($code ${secs}s)"; fi
  if awk "BEGIN{exit !($load1 > 1.6)}"; then reason="LOAD AVERAGE $load1 > 1.6"; fi
  if [ -n "$reason" ]; then echo "ABORT: $reason" | tee "$OUT/ABORTED"; kill $K6 2>/dev/null || true; break; fi
done
wait $K6 2>/dev/null || true
echo "done $SCEN rate=$RATE ${reason:+(aborted: $reason)}"
