#!/usr/bin/env python3
"""Summarize ops/load-test/run-live-cbt.sh step directories into one table.

    python3 ops/load-test/summarize-live.py /tmp/lt-live/n50 /tmp/lt-live/n100 ...
"""
import csv
import json
import os
import sys


def metric(summary, name, stat):
    m = summary.get("metrics", {}).get(name, {})
    return m.get(stat, m.get("values", {}).get(stat)) if m else None


def fmt(v):
    return "-" if v is None else (f"{v:.0f}" if isinstance(v, (int, float)) else str(v))


cols = ["N", "started", "submitted", "held_ok", "errors", "start_p95", "run_p95", "save_p95", "save_max", "submit_p95", "submit_max",
        "submits_done_after_end_max_ms", "app_cpu_max", "pg_cpu_max", "load_max", "mem_min_mb", "rss_max_mb", "db_conns_max",
        "prod_health_max_s", "nginx_5xx", "pm2_restarts", "aborted"]
print("\t".join(cols))
for d in sys.argv[1:]:
    s = json.load(open(os.path.join(d, "summary.json"))) if os.path.exists(os.path.join(d, "summary.json")) else {}
    x = json.load(open(os.path.join(d, "extra.json"))) if os.path.exists(os.path.join(d, "extra.json")) else {}
    setup = json.load(open(os.path.join(d, "setup.json")))
    rows = list(csv.DictReader(open(os.path.join(d, "samples.csv"))))
    num = lambda k: [float(r[k]) for r in rows if r[k] not in ("", "-1")]
    out = [setup["candidates"],
           metric(s, "candidates_started", "count"), metric(s, "candidates_submitted", "count"), metric(s, "results_held_ok", "count"),
           metric(s, "app_errors", "count") or 0,
           metric(s, "lat_start", "p(95)"), metric(s, "lat_run", "p(95)"), metric(s, "lat_save", "p(95)"), metric(s, "lat_save", "max"),
           metric(s, "lat_submit", "p(95)"), metric(s, "lat_submit", "max"), metric(s, "submit_done_after_end_ms", "max"),
           max(num("app_cpu_pct") or [0]), max(num("pg_cpu_pct") or [0]), max(num("load1") or [0]), min(num("mem_avail_mb") or [0]),
           max(num("app_rss_mb") or [0]), max(num("lt_conns") or [0]), max(num("prod_health_s") or [0]),
           x.get("nginx_5xx"), x.get("pm2_restarts"), "yes" if os.path.exists(os.path.join(d, "aborted.txt")) else "no"]
    out[18] = f"{out[18]:.2f}"
    print("\t".join(fmt(v) for v in out))
