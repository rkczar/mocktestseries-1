#!/usr/bin/env python3
"""mocktestseries watchdog: backups + server health, with email alerts. Read-only by design.

Installed as /usr/local/bin/mocktestseries-watchdog.py (source: ops/monitoring/ in the repo) and run
every 5 minutes from /etc/cron.d/mocktestseries-watchdog.

Checks
  Database backup   db-status.txt is OK and from the latest scheduled run; the newest nightly dump
                    exists, is fresh, and matches its .sha256 sidecar.
  File backup       files-status.txt is OK and from the latest scheduled run; every mirror matches
                    its SHA-256 manifest (manifests/<name>.sha256).
  Full package      the newest packages/mocktestseries-full-*.tar hashes to the SHA-256 recorded
                    when the Backup Center verified it (read-only DB query).
  Server            /api/health, pg_isready, PM2 workers, disk usage, TLS certificate expiry.
Hashing (dump, mirrors, package) runs again only when the file changes or every HEAVY_EVERY_H hours.

Alerts: one email (Resend) when a problem starts, a reminder every REMIND_EVERY_H hours while it
lasts, and one when it clears. Alert state: STATE_DIR/state.json (0600, dir 0700).

It NEVER restarts, reloads or changes anything: the only commands it runs are `pm2 jlist`,
`pg_isready` and a read-only `psql` query. Secrets (API key, DB password) are read from the app's
.env, passed only in an HTTP header / the psql environment, and never logged or emailed.
"""
import datetime as dt
import hashlib
import json
import math
import os
import re
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULTS = {
    "CONF_FILE": "/etc/mocktestseries-watchdog.conf",
    "ENV_FILE": "/var/www/mocktestseries-shared/.env",
    "BACKUP_ROOT": "/var/backups/mocktestseries",
    "STATE_DIR": "/var/lib/mocktestseries-watchdog",
    "LOG_DIR": "/var/log/mocktestseries",
    "HEALTH_URL": "http://127.0.0.1:3002/api/health",
    "PM2_BIN": "pm2",
    "PM2_APP": "mocktestseries",
    "EXPECTED_WORKERS": "2",
    "PG_ISREADY": "pg_isready",
    "PSQL": "psql",
    "DISK_PATH": "/",
    "DISK_WARN_PCT": "85",
    "TLS_HOST": "mocktestseries.in",
    "CERT_WARN_DAYS": "14",
    "DB_RUN_AT": "02:00",
    "FILES_RUN_AT": "02:15",
    "RUN_GRACE_MIN": "120",
    "MAX_AGE_H": "26",
    "HEAVY_EVERY_H": "24",
    "REMIND_EVERY_H": "24",
    "MIRRORS": "uploads storage ai-import-vault import-staging",
    "ALERT_TO": "",
    "EMAIL_MODE": "send",  # send | outbox (tests: write the email to OUTBOX_DIR) | off
    "OUTBOX_DIR": "",
    "RESEND_URL": "https://api.resend.com/emails",
    "NOW": "",  # tests only: ISO time to use as "now"
}
DUMP_RE = re.compile(r"^mocktestseries-\d{8}T\d{6}Z\.dump$")
PKG_RE = re.compile(r"^mocktestseries-full-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}\.tar$")


def read_kv(path):
    out = {}
    try:
        with open(path) as f:
            for line in f:
                m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
                if m:
                    out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def load_config(env=None):
    env = os.environ if env is None else env
    c = dict(DEFAULTS)
    c.update({k: v for k, v in read_kv(env.get("CONF_FILE", c["CONF_FILE"])).items() if k in DEFAULTS})
    c.update({k: env[k] for k in DEFAULTS if k in env})
    return c


def now_utc(c):
    if c["NOW"]:
        return dt.datetime.fromisoformat(c["NOW"].replace("Z", "+00:00"))
    return dt.datetime.now(dt.timezone.utc)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_text(path):
    with open(path) as f:
        return f.read()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_id(path):
    st = os.stat(path)
    return f"{os.path.basename(path)}:{st.st_size}:{int(st.st_mtime)}"


def last_scheduled(now, hhmm, grace_min):
    """Most recent daily run (UTC) whose grace period has already passed."""
    h, m = map(int, hhmm.split(":"))
    t = now.replace(hour=h, minute=m, second=0, microsecond=0)
    while t + dt.timedelta(minutes=grace_min) > now:
        t -= dt.timedelta(days=1)
    return t


def heavy(c, state, key, ident, now, fn):
    """Cached expensive check: rerun when the target changes or the cache is older than HEAVY_EVERY_H."""
    cache = state.setdefault("heavy", {})
    hit = cache.get(key)
    if hit and hit["id"] == ident and now - dt.datetime.fromisoformat(hit["at"]) < dt.timedelta(hours=float(c["HEAVY_EVERY_H"])):
        return hit["problem"]
    problem = fn()
    cache[key] = {"id": ident, "at": now.isoformat(), "problem": problem}
    return problem


def check_status_file(c, now, name, path, run_at, key):
    problems = []
    try:
        ts_s, state_s, *rest = read_text(path).split(maxsplit=2)
        ts = dt.datetime.fromisoformat(ts_s.replace("Z", "+00:00"))
    except (OSError, ValueError):
        return [(f"{key}.status", f"{os.path.basename(path)} is missing or unreadable")], None, None
    if state_s != "OK":
        problems.append((f"{key}.status", f"last {name} FAILED at {iso(ts)}: {(rest[0] if rest else '').strip()[:200]}"))
    expected = last_scheduled(now, run_at, int(c["RUN_GRACE_MIN"]))
    if ts < expected:
        problems.append((f"{key}.missed", f"scheduled {name} of {iso(expected)} did not run (last result {iso(ts)})"))
    return problems, state_s, (rest[0].strip() if rest else "")


def check_db_backup(c, state, now):
    root = c["BACKUP_ROOT"]
    problems, st, rest = check_status_file(c, now, "database backup", os.path.join(root, "db-status.txt"), c["DB_RUN_AT"], "db")
    ddir = os.path.join(root, "postgres")
    try:
        dumps = sorted(f for f in os.listdir(ddir) if DUMP_RE.match(f))
    except OSError:
        dumps = []
    if not dumps:
        return problems + [("db.dump", f"no nightly database dump in {ddir}")]
    newest = os.path.join(ddir, dumps[-1])
    if st == "OK" and rest and rest != dumps[-1]:
        problems.append(("db.dump", f"db-status.txt names {rest[:80]} but the newest dump is {dumps[-1]}"))
    age_h = (now.timestamp() - os.stat(newest).st_mtime) / 3600
    if age_h >= float(c["MAX_AGE_H"]):
        problems.append(("db.stale", f"newest database dump {dumps[-1]} is {age_h:.0f}h old"))
    side = newest + ".sha256"
    if not os.path.isfile(side):
        return problems + [("db.sha256", f"checksum file missing for {dumps[-1]}")]

    def verify():
        try:
            want = read_text(side).split()[0].lower()
        except (OSError, IndexError):
            return f"checksum file for {dumps[-1]} is unreadable"
        return None if sha256_file(newest) == want else f"checksum MISMATCH for {dumps[-1]} (dump damaged)"

    p = heavy(c, state, "db.sha256", file_id(newest) + "|" + file_id(side), now, verify)
    return problems + ([("db.sha256", p)] if p else [])


def check_file_backup(c, state, now):
    root = c["BACKUP_ROOT"]
    problems, _, _ = check_status_file(c, now, "file backup", os.path.join(root, "files-status.txt"), c["FILES_RUN_AT"], "files")
    for name in c["MIRRORS"].split():
        man = os.path.join(root, "manifests", f"{name}.sha256")
        if not os.path.isfile(man):
            problems.append((f"files.{name}", f"checksum manifest missing: manifests/{name}.sha256"))
            continue

        def verify(name=name, man=man):
            mirror, bad, total = os.path.join(root, name), 0, 0
            with open(man) as f:
                for line in f:
                    parts = line.rstrip("\n").split("  ", 1)
                    if len(parts) != 2:
                        continue
                    total += 1
                    rel = os.path.normpath(parts[1])
                    p = os.path.join(mirror, rel)
                    if os.path.isabs(rel) or rel.startswith("..") or not os.path.isfile(p) or sha256_file(p) != parts[0].lower():
                        bad += 1
            return f"{name}: {bad} of {total} files missing or changed in the backup copy" if bad else None

        p = heavy(c, state, f"files.{name}", file_id(man), now, verify)
        if p:
            problems.append((f"files.{name}", p))
    return problems


def pg_env(c):
    url = read_kv(c["ENV_FILE"]).get("DATABASE_URL", "")
    u = urllib.parse.urlsplit(url)
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PGOPTIONS": "-c default_transaction_read_only=on", "PGCONNECT_TIMEOUT": "10"}
    if u.hostname:
        env.update({"PGHOST": u.hostname, "PGPORT": str(u.port or 5432), "PGUSER": urllib.parse.unquote(u.username or ""),
                    "PGPASSWORD": urllib.parse.unquote(u.password or ""), "PGDATABASE": u.path.lstrip("/")})
    return env


def recorded_package_sha(c, name):
    """SHA-256 the Backup Center recorded when it verified the package (read-only query), or None."""
    if not PKG_RE.match(name):  # name is interpolated into SQL: only the strict package pattern is allowed
        raise ValueError("unexpected package name")
    sql = (f"select coalesce((select sha256 from \"BackupJob\" where \"fileName\"='{name}' and \"deletedAt\" is null and sha256 is not null order by \"createdAt\" desc limit 1),"
           f"(select sha256 from \"BackupArtifactCheck\" where \"fileName\"='{name}' and status='VALID' and sha256 is not null order by \"checkedAt\" desc limit 1))")
    r = subprocess.run([c["PSQL"], "-X", "-At", "-c", sql], env=pg_env(c), capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError("database query failed")
    return r.stdout.strip() or None


def check_full_package(c, state, now):
    pdir = os.path.join(c["BACKUP_ROOT"], "packages")
    try:
        pkgs = [f for f in os.listdir(pdir) if PKG_RE.match(f)]
    except OSError:
        pkgs = []
    if not pkgs:
        return [("pkg.missing", f"no Full backup package in {pdir}")]
    name = max(pkgs, key=lambda f: os.stat(os.path.join(pdir, f)).st_mtime)
    path = os.path.join(pdir, name)
    try:
        want = recorded_package_sha(c, name)
        state.setdefault("recorded", {})[name] = want
    except Exception:
        want = state.get("recorded", {}).get(name)
        if not want:
            return [("pkg.recorded", f"could not read the recorded SHA-256 of {name}")]
    if not want:
        return [("pkg.recorded", f"{name} has no recorded verified SHA-256")]
    p = heavy(c, state, "pkg.sha256", file_id(path) + "|" + want, now,
              lambda: None if sha256_file(path) == want else f"{name} does not match its recorded SHA-256 (package damaged)")
    return [("pkg.sha256", p)] if p else []


def check_health(c, state, now):
    try:
        with urllib.request.urlopen(c["HEALTH_URL"], timeout=10) as r:
            body = json.loads(r.read(4096) or b"{}")
            if r.status == 200 and body.get("status") == "ok" and body.get("db") == "ok":
                return []
            return [("app.health", f"health check returned HTTP {r.status} {body}")]
    except urllib.error.HTTPError as e:
        return [("app.health", f"health check returned HTTP {e.code}")]
    except Exception as e:
        return [("app.health", f"health check failed: {type(e).__name__}")]


def check_postgres(c, state, now):
    try:
        r = subprocess.run([c["PG_ISREADY"], "-q", "-t", "10"], capture_output=True, timeout=20)
        return [] if r.returncode == 0 else [("pg.down", f"PostgreSQL is not accepting connections (pg_isready exit {r.returncode})")]
    except Exception as e:
        return [("pg.down", f"pg_isready failed: {type(e).__name__}")]


def check_pm2(c, state, now):
    # Read-only: `pm2 jlist` only. This watchdog never restarts or reloads anything.
    try:
        r = subprocess.run([c["PM2_BIN"], "jlist"], capture_output=True, text=True, timeout=30)
        procs = [p for p in json.loads(r.stdout or "[]") if p.get("name") == c["PM2_APP"]]
        states = [p.get("pm2_env", {}).get("status", "?") for p in procs]
    except Exception as e:
        return [("pm2.workers", f"could not read PM2 status ({type(e).__name__})")]
    want = int(c["EXPECTED_WORKERS"])
    if len(states) < want or any(s != "online" for s in states):
        return [("pm2.workers", f"PM2 workers {states or 'missing'} (expected {want} online). Not restarted automatically — check `pm2 status`.")]
    return []


def check_disk(c, state, now):
    s = os.statvfs(c["DISK_PATH"])
    used, avail = (s.f_blocks - s.f_bfree) * s.f_frsize, s.f_bavail * s.f_frsize
    pct = math.ceil(used * 100 / (used + avail)) if used + avail else 0
    state["disk_pct"] = pct
    return [("disk.usage", f"disk {c['DISK_PATH']} is {pct}% used ({avail / 2**30:.1f} GiB free)")] if pct >= int(c["DISK_WARN_PCT"]) else []


def tls_days_left(host):
    ctx = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=10) as sock, ctx.wrap_socket(sock, server_hostname=host) as s:
        not_after = s.getpeercert()["notAfter"]
    return (ssl.cert_time_to_seconds(not_after) - dt.datetime.now(dt.timezone.utc).timestamp()) / 86400


def check_tls(c, state, now):
    try:
        days = tls_days_left(c["TLS_HOST"])
    except Exception as e:
        return [("tls.check", f"could not check the TLS certificate of {c['TLS_HOST']} ({type(e).__name__})")]
    state["tls_days"] = int(days)
    return [("tls.expiry", f"TLS certificate of {c['TLS_HOST']} expires in {int(days)} days")] if days < int(c["CERT_WARN_DAYS"]) else []


CHECKS = [check_db_backup, check_file_backup, check_full_package, check_health, check_postgres, check_pm2, check_disk, check_tls]


def plan_notifications(c, state, problems, now):
    """Returns (new, reminders, resolved) and the next alert map; last_sent is set by the caller after a send."""
    alerts, remind = state.get("alerts", {}), dt.timedelta(hours=float(c["REMIND_EVERY_H"]))
    new, reminders, resolved, nxt = [], [], [], {}
    for key, msg in problems.items():
        a = alerts.get(key)
        if a is None or a.get("last_sent") is None:
            a = {"since": (a or {}).get("since", now.isoformat()), "last_sent": None}
            new.append(key)
        elif now - dt.datetime.fromisoformat(a["last_sent"]) >= remind:
            reminders.append(key)
        nxt[key] = {**{k: v for k, v in a.items() if k != "cleared"}, "message": msg}
    for key, a in alerts.items():
        if key not in problems and a.get("last_sent"):  # never-notified problems clear silently
            resolved.append(key)
    return new, reminders, resolved, nxt


def compose_email(c, state, problems, new, reminders, resolved, nxt, now):
    kind = "ALERT" if new else "REMINDER" if reminders else "RESOLVED"
    host = socket.gethostname()
    n_open = len(problems)
    subject = f"[mocktestseries] {kind}: " + (f"{len(new)} new problem(s), {n_open} open" if new else f"{n_open} problem(s) still open" if reminders else f"{len(resolved)} problem(s) resolved, {n_open} open")
    lines = [f"mocktestseries watchdog on {host} at {iso(now)}", ""]
    sections = [("NEW PROBLEMS", new), ("STILL UNRESOLVED (reminder)", reminders),
                ("OTHER OPEN PROBLEMS", [k for k in problems if k not in new and k not in reminders])]
    for title, keys in sections:
        if keys:
            lines.append(title)
            lines += [f"  - {nxt[k]['message']} (since {iso(dt.datetime.fromisoformat(nxt[k]['since']))})" for k in keys]
            lines.append("")
    if resolved:
        old = state.get("alerts", {})
        lines.append("RESOLVED")
        lines += [f"  - {old[k].get('message', k)} (open since {iso(dt.datetime.fromisoformat(old[k]['since']))})" for k in resolved]
        lines.append("")
    if not problems:
        lines += ["All checks pass now.", ""]
    lines += ["Details: /var/log/mocktestseries/watchdog.log. This watchdog only reports; it never restarts or changes anything."]
    return subject, "\n".join(lines)


def send_email(c, subject, text):
    """True = sent / written to the test outbox; False = failed; None = email disabled or not configured."""
    if c["EMAIL_MODE"] == "off" or not c["ALERT_TO"]:
        return None, "email not configured"
    env = read_kv(c["ENV_FILE"])
    payload = {"from": env.get("EMAIL_FROM", ""), "to": [a.strip() for a in c["ALERT_TO"].split(",") if a.strip()], "subject": subject, "text": text}
    if c["EMAIL_MODE"] == "outbox":
        os.makedirs(c["OUTBOX_DIR"], exist_ok=True)
        n = len(os.listdir(c["OUTBOX_DIR"]))
        with open(os.path.join(c["OUTBOX_DIR"], f"{n:04d}.json"), "w") as f:
            json.dump(payload, f, indent=1)
        return True, "written to test outbox"
    key = env.get("RESEND_API_KEY", "")
    if not key or not payload["from"]:
        return False, "Resend key or EMAIL_FROM missing in the app .env"
    req = urllib.request.Request(c["RESEND_URL"], data=json.dumps(payload).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "mocktestseries-watchdog"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return (200 <= r.status < 300), f"Resend HTTP {r.status}"
    except urllib.error.HTTPError as e:
        return False, f"Resend HTTP {e.code}"  # status only: the response body is never logged
    except Exception as e:
        return False, f"Resend unreachable ({type(e).__name__})"


def write_private(path, text):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def run(c=None):
    c = c or load_config()
    now = now_utc(c)
    os.makedirs(c["STATE_DIR"], mode=0o700, exist_ok=True)
    os.chmod(c["STATE_DIR"], 0o700)
    os.makedirs(c["LOG_DIR"], exist_ok=True)
    state_file = os.path.join(c["STATE_DIR"], "state.json")
    try:
        state = json.loads(read_text(state_file))
    except (OSError, ValueError):
        state = {}

    problems = {}
    for check in CHECKS:
        try:
            found = check(c, state, now)
        except Exception as e:  # a broken check must not hide the others
            found = [(f"{check.__name__}.error", f"{check.__name__} crashed ({type(e).__name__})")]
        for key, msg in found:
            problems.setdefault(key, msg)

    new, reminders, resolved, nxt = plan_notifications(c, state, problems, now)
    email = "nothing to send"
    if new or reminders or resolved:
        subject, text = compose_email(c, state, problems, new, reminders, resolved, nxt, now)
        sent, email = send_email(c, subject, text)
        if sent:
            for k in new + reminders:
                nxt[k]["last_sent"] = now.isoformat()
        elif sent is False:  # resolution not delivered: keep it (marked cleared, not open) so the next run retries
            for k in resolved:
                nxt[k] = {**state["alerts"][k], "cleared": True}
    state["alerts"] = nxt
    state["last_run"] = now.isoformat()
    write_private(state_file, json.dumps(state, indent=1, sort_keys=True))

    open_keys = [k for k in nxt if not nxt[k].get("cleared")]
    summary = f"disk={state.get('disk_pct', '?')}% tls_days={state.get('tls_days', '?')}"
    line = f"[{iso(now)}] " + (("ALERT " + "; ".join(problems[k] for k in open_keys)) if open_keys else "OK") + f" | {summary} | email: {email}"
    with open(os.path.join(c["LOG_DIR"], "watchdog.log"), "a") as f:
        f.write(line + "\n")
    write_private(os.path.join(c["LOG_DIR"], "watchdog-status.txt"), line + "\n")
    return 1 if open_keys else 0


if __name__ == "__main__":
    sys.exit(run())
