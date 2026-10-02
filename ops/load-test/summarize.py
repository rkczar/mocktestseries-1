#!/usr/bin/env python3
"""Summarize run-light.sh step directories: latency, errors, throughput and
CPU cost per request (ms of CPU on the 2 vCPUs, app vs PostgreSQL).

    python3 ops/load-test/summarize.py <outdir>...
"""
import csv, json, sys, os

def step(d):
    s = json.load(open(os.path.join(d, "summary.json")))["metrics"]
    rows = list(csv.DictReader(open(os.path.join(d, "samples.csv"))))
    rows = rows[2:-1] if len(rows) > 4 else rows  # drop ramp-in/out seconds
    avg = lambda k: sum(float(r[k]) for r in rows) / max(1, len(rows))
    reqs = s.get("http_reqs", {})
    rps = reqs.get("rate", 0)
    trend = next((s[k] for k in ("lat_save", "lat_heartbeat", "lat_submit", "lat_start", "lat_page") if k in s and s[k].get("med")), s.get("http_req_duration", {}))
    errs = s.get("app_errors", {}).get("count", 0)
    app, pg = avg("app_cpu_pct"), avg("pg_cpu_pct")
    return {
        "step": os.path.basename(d),
        "rps": round(rps, 1),
        "p50": round(trend.get("med", 0)), "p95": round(trend.get("p(95)", 0)), "p99": round(trend.get("p(99)", 0)),
        "errors": int(errs), "reqs": int(reqs.get("count", 0)),
        "app_cpu%": round(app), "pg_cpu%": round(pg), "k6_cpu%": round(avg("k6_cpu_pct")),
        "app_cpu_ms/req": round(app * 10 / rps, 1) if rps else None,
        "pg_cpu_ms/req": round(pg * 10 / rps, 1) if rps else None,
        "lt_conns_max": max(int(r["lt_conns"]) for r in rows) if rows else None,
        "mem_avail_min_mb": min(int(r["mem_avail_mb"]) for r in rows) if rows else None,
        "prod_health_max_s": max(float(r["prod_health_s"]) for r in rows) if rows else None,
        "aborted": os.path.exists(os.path.join(d, "ABORTED")),
    }

out = [step(d) for d in sys.argv[1:]]
keys = list(out[0].keys())
print("\t".join(keys))
for o in out:
    print("\t".join(str(o[k]) for k in keys))
