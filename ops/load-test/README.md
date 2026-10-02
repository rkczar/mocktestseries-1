# Load-test harness

Measures request cost and capacity of the student test flow **without touching
production data**. Every script refuses to run unless `DATABASE_URL` points at
a disposable database whose name contains `loadtest`, and k6 only targets a
local isolated instance (`http://127.0.0.1:<port>`).

This VPS is also production. An isolated instance still shares its CPU, RAM
and PostgreSQL with real students, so `run-light.sh` probes the live site's
`/api/health` every second and aborts as soon as it slows (>1.0 s twice) or
the load average passes 1.6. Heavy ramps (hundreds of virtual users) belong
on a separate clone server, not here.

## Files

| File | Purpose |
|---|---|
| `seed.ts` | Synthetic exam, series, mocks x questions, students, history; writes the fixture JSON (incl. this build's server-action ids) |
| `sign-in.ts` | Gives each synthetic student a production-shaped session (device + tracked session via `admitStudentSignIn`) |
| `prepare-attempts.ts` | Adds IN_PROGRESS attempts (player/save/submit scenarios) and SUBMITTED ids (result/review) |
| `profile-engine.ts` | Exact SQL statement count / DB ms / wall ms per engine operation (query-logging Prisma client) |
| `burst-engine.ts` | Bounded simultaneous START / SUBMIT bursts through one worker-sized pool, plus race checks |
| `k6/scenarios.js` | Open-model k6 scenarios: browse, runpage, save, heartbeat, submit, result, mixed |
| `run-light.sh` | One guarded k6 step + per-second CPU (app / postgres / k6), RAM, DB connections, RSS, live-site health |
| `summarize.py` | Step table: RPS, p50/p95/p99, errors, CPU ms per request |

## Run

```bash
cd /var/www/mocktestseries
PG=postgresql://USER:PASS@127.0.0.1:5432          # from .env, without db name
LT=$PG/mts_loadtest_$(date +%Y%m%d)?schema=public
psql "$PG/postgres" -c "create database mts_loadtest_$(date +%Y%m%d)"
DATABASE_URL="$LT" npx prisma db push
export NODE_OPTIONS=--conditions=react-server
DATABASE_URL="$LT" npx tsx ops/load-test/seed.ts --students 300 --mocks 5 --questions 100 --out /tmp/lt.json
DATABASE_URL="$LT" npx tsx ops/load-test/prepare-attempts.ts /tmp/lt.json 150
DATABASE_URL="$LT" npx tsx ops/load-test/sign-in.ts /tmp/lt.json          # always last
DATABASE_URL="$LT" npx tsx ops/load-test/profile-engine.ts /tmp/lt.json
DATABASE_URL="$LT" npx tsx ops/load-test/burst-engine.ts /tmp/lt.json 10,25,50

# isolated instance of the current build (needs `npx next build` first)
DATABASE_URL="$LT" AUTH_URL=http://localhost:3100/api/student-auth NEXTAUTH_URL=http://localhost:3100 \
  npx next start -p 3100 -H 127.0.0.1 &
PSQL_URL=$PG LT_DB=mts_loadtest_$(date +%Y%m%d) ops/load-test/run-light.sh save 10 30s /tmp/lt.json /tmp/lt/save-10
python3 ops/load-test/summarize.py /tmp/lt/*

# cleanup (deterministic): stop the instance, then
psql "$PG/postgres" -c "drop database mts_loadtest_$(date +%Y%m%d)"
```

Re-run `sign-in.ts` after `prepare-attempts.ts` or any submit scenario. Submit
consumes in-progress attempts, so run it last or re-prepare. Server-action ids
change on every build, so re-seed or re-read them after rebuilding.

The FormData-based start action (`startMockTestFromDetailsAction`) is not
driven over HTTP yet. Mass starts are measured at function level by
`burst-engine.ts`.
