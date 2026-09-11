#!/usr/bin/env bash
# Production health check for mocktestseries.
#
# Usage:
#   BASE_URL=https://mocktestseries.in ./scripts/healthcheck.sh   (default — live site)
#   BASE_URL=http://127.0.0.1:3001 ./scripts/healthcheck.sh       (pre-cutover check during deploy)
#
# Exit 0 = all checks passed. Exit 1 = at least one check failed.
# PM2/Nginx/log checks only run when BASE_URL is the public domain, since a
# pre-cutover scratch instance during deploy has no PM2 entry of its own yet.

set -uo pipefail

BASE_URL="${BASE_URL:-https://mocktestseries.in}"
TIMEOUT=10
FAIL=0
PASS=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  WARN: $1"; }

check_http() {
  local path="$1" expect="$2" label="$3"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$BASE_URL$path" 2>/dev/null || echo "000")
  if [[ "$code" == "$expect" ]]; then
    pass "$label ($path -> $code)"
  else
    fail "$label ($path -> $code, expected $expect)"
  fi
}

echo "Health check against $BASE_URL"
echo "--------------------------------------------"

check_http "/" 200 "Homepage"
check_http "/student/login" 200 "Student login route"
check_http "/admin/login" 200 "Admin login route"
check_http "/exams" 200 "Public DB-backed route (exams)"
check_http "/test-series" 200 "Public DB-backed route (test-series)"

# Static asset — pull a real hashed asset path out of the homepage HTML rather than guessing one.
ASSET_PATH=$(curl -s --max-time "$TIMEOUT" "$BASE_URL/" 2>/dev/null | grep -oE '/_next/static/[^"]+\.(js|css)' | head -1)
if [[ -n "$ASSET_PATH" ]]; then
  check_http "$ASSET_PATH" 200 "Static asset ($ASSET_PATH)"
else
  fail "Could not locate a static asset reference in homepage HTML"
fi

# Upload serving — proves the persistent storage cutover to /var/lib/mocktestseries/uploads works
# end-to-end through the app, not just on disk.
check_http "/api/uploads/2026/09/f09c15e3-6ede-4328-8c78-01881123db78.csv" 200 "Upload file serving"

# API route smoke test — unauthenticated call should be rejected cleanly, never crash with a 500.
API_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" -X POST "$BASE_URL/api/ai/explain" 2>/dev/null || echo "000")
if [[ "$API_CODE" =~ ^(400|401|403|405)$ ]]; then
  pass "AI explain API reachable and enforces auth ($API_CODE)"
elif [[ "$API_CODE" == "200" ]]; then
  warn "AI explain API returned 200 unauthenticated — verify this is expected"
  PASS=$((PASS + 1))
else
  fail "AI explain API returned unexpected status ($API_CODE)"
fi

if [[ "$BASE_URL" == "https://mocktestseries.in" || "$BASE_URL" == "http://mocktestseries.in" || "$BASE_URL" == "https://www.mocktestseries.in" ]]; then
  echo
  echo "Live-system checks:"

  if command -v pm2 >/dev/null 2>&1; then
    PM2_STATUS=$(pm2 jlist 2>/dev/null | node -e '
      let d = "";
      process.stdin.on("data", c => d += c).on("end", () => {
        try {
          const apps = JSON.parse(d);
          const app = apps.find(a => a.name === "mocktestseries");
          console.log(app ? app.pm2_env.status : "missing");
        } catch { console.log("error"); }
      });
    ' 2>/dev/null)
    if [[ "$PM2_STATUS" == "online" ]]; then
      pass "PM2 process 'mocktestseries' is online"
    else
      fail "PM2 process status: ${PM2_STATUS:-unknown}"
    fi
  else
    warn "pm2 not on PATH — skipping PM2 check"
  fi

  if systemctl is-active --quiet nginx; then
    pass "Nginx is active"
  else
    fail "Nginx is not active"
  fi

  if [[ -f /var/log/mocktestseries/error.log ]]; then
    RECENT=$(tail -n 200 /var/log/mocktestseries/error.log 2>/dev/null | grep -ic "error" || true)
    echo "  INFO: 'error' occurrences in last 200 lines of app error.log (informational only): ${RECENT:-0}"
  fi
fi

echo "--------------------------------------------"
echo "Result: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
