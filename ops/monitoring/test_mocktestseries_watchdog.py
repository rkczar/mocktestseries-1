#!/usr/bin/env python3
"""Isolated tests for mocktestseries-watchdog.py: temp fixtures, fake pm2/pg_isready/psql that record their
arguments, and local stub HTTP servers for /api/health and Resend. Nothing real is read, sent or changed.
Run: python3 ops/monitoring/test_mocktestseries_watchdog.py"""
import datetime as dt
import hashlib
import http.server
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("wd", os.path.join(HERE, "mocktestseries-watchdog.py"))
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)

NOW = dt.datetime(2026, 11, 10, 9, 0, tzinfo=dt.timezone.utc)
FAKE_KEY = "re_TESTKEY_must_never_appear_in_logs_123456"
PKG = "mocktestseries-full-20261108-100535-72cfed.tar"


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        code, body = self.server.reply
        self.send_response(code)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        self.server.requests.append({"auth": self.headers.get("Authorization"), "body": json.loads(self.rfile.read(n))})
        code, body = self.server.reply
        self.send_response(code)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


def serve(reply):
    s = http.server.HTTPServer(("127.0.0.1", 0), Stub)
    s.reply, s.requests = reply, []
    threading.Thread(target=s.serve_forever, daemon=True).start()
    return s


def sha(b):
    return hashlib.sha256(b).hexdigest()


def ts(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


class Fixture:
    def __init__(self, root):
        self.root = root
        self.b = os.path.join(root, "backups")
        self.bin = os.path.join(root, "bin")
        self.calls = os.path.join(root, "calls.log")
        for d in ["postgres", "packages", "manifests"]:
            os.makedirs(os.path.join(self.b, d), exist_ok=True)
        os.makedirs(self.bin, exist_ok=True)
        self.pm2_states(["online", "online"])
        self.fake("pg_isready", 'exit "$(cat "$(dirname "$0")/pg_rc" 2>/dev/null || echo 0)"')
        self.write(os.path.join(self.bin, "pg_rc"), "0")
        self.fake("psql", '[ -f "$(dirname "$0")/psql_fail" ] && exit 2; cat "$(dirname "$0")/recorded_sha"')
        self.env = os.path.join(root, "app.env")
        self.write(self.env, f'DATABASE_URL="postgresql://app:s3cretPW@127.0.0.1:5432/fake_db?schema=public"\nRESEND_API_KEY="{FAKE_KEY}"\nEMAIL_FROM="MTS <no-reply@example.test>"\n')
        self.health = serve((200, {"status": "ok", "db": "ok"}))
        self.make_healthy()

    def write(self, p, text, mtime=None):
        os.makedirs(os.path.dirname(p), exist_ok=True)
        mode = "wb" if isinstance(text, bytes) else "w"
        with open(p, mode) as f:
            f.write(text)
        if mtime:
            os.utime(p, (mtime.timestamp(), mtime.timestamp()))

    def fake(self, name, body):
        p = os.path.join(self.bin, name)
        self.write(p, f'#!/bin/bash\necho "{name} $*" >> "{self.calls}"\n{body}\n')
        os.chmod(p, 0o755)

    def pm2_states(self, states):
        procs = [{"name": "mocktestseries", "pm2_env": {"status": s}} for s in states]
        self.write(os.path.join(self.bin, "pm2.json"), json.dumps(procs))
        self.fake("pm2", 'cat "$(dirname "$0")/pm2.json"')

    def make_healthy(self, day=NOW):
        run = day.replace(hour=2, minute=0, second=3)
        name = f"mocktestseries-{run.strftime('%Y%m%dT%H%M%SZ')}.dump"
        dump = os.path.join(self.b, "postgres", name)
        self.write(dump, b"PGDMP fake dump", run)
        self.write(dump + ".sha256", f"{sha(b'PGDMP fake dump')}  {name}\n", run)
        self.write(os.path.join(self.b, "db-status.txt"), f"{ts(run)} OK {name}\n")
        self.write(os.path.join(self.b, "files-status.txt"), f"{ts(run.replace(minute=15))} OK\n")
        for m in ["uploads", "storage", "ai-import-vault", "import-staging"]:
            self.write(os.path.join(self.b, m, "dir", f"{m}.bin"), m.encode())
            self.write(os.path.join(self.b, "manifests", f"{m}.sha256"), f"{sha(m.encode())}  ./dir/{m}.bin\n")
        self.write(os.path.join(self.b, "packages", PKG), b"full package bytes", run)
        self.write(os.path.join(self.bin, "recorded_sha"), sha(b"full package bytes") + "\n")
        self.dump = dump

    def config(self, **over):
        c = dict(wd.DEFAULTS)
        c.update(CONF_FILE=os.path.join(self.root, "none.conf"), ENV_FILE=self.env, BACKUP_ROOT=self.b,
                 STATE_DIR=os.path.join(self.root, "state"), LOG_DIR=os.path.join(self.root, "log"),
                 HEALTH_URL=f"http://127.0.0.1:{self.health.server_port}/api/health",
                 PM2_BIN=os.path.join(self.bin, "pm2"), PG_ISREADY=os.path.join(self.bin, "pg_isready"),
                 PSQL=os.path.join(self.bin, "psql"), DISK_PATH=self.root, DISK_WARN_PCT="101",
                 ALERT_TO="owner@example.test", EMAIL_MODE="outbox", OUTBOX_DIR=os.path.join(self.root, "outbox"),
                 NOW=NOW.isoformat(), SEO_CRON_FILE=os.path.join(self.root, "cron.d", "mocktestseries-seo-intel"),
                 SEO_STATUS_FILE=os.path.join(self.root, "log", "seo-intel-status.txt"))
        c.update(over)
        return c

    def outbox(self):
        d = os.path.join(self.root, "outbox")
        return [json.loads(open(os.path.join(d, f)).read()) for f in sorted(os.listdir(d))] if os.path.isdir(d) else []

    def state(self):
        with open(os.path.join(self.root, "state", "state.json")) as f:
            return json.load(f)

    def status(self):
        return open(os.path.join(self.root, "log", "watchdog-status.txt")).read()


def seo_line(t, state, streak, reason):
    return f"{ts(t)} {state} streak={streak} {reason}\n"


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="wd-test-")
        self.f = Fixture(self.tmp)
        self._tls = wd.tls_days_left
        wd.tls_days_left = lambda host: 60.0

    def tearDown(self):
        wd.tls_days_left = self._tls
        self.f.health.shutdown()
        self.f.health.server_close()
        shutil.rmtree(self.tmp)

    def run_wd(self, at=NOW, **over):
        return wd.run(self.f.config(NOW=at.isoformat(), **over))

    def open_keys(self):
        return sorted(k for k, a in self.f.state()["alerts"].items() if not a.get("cleared"))

    # --- baseline -------------------------------------------------------------------------------
    def test_all_healthy(self):
        self.assertEqual(self.run_wd(), 0)
        self.assertEqual(self.open_keys(), [])
        self.assertEqual(self.f.outbox(), [])
        self.assertIn("] OK |", self.f.status())

    # --- A. database backup ---------------------------------------------------------------------
    def test_db_status_missing(self):
        os.remove(os.path.join(self.f.b, "db-status.txt"))
        self.assertEqual(self.run_wd(), 1)
        self.assertIn("db.status", self.open_keys())

    def test_db_status_failed(self):
        self.f.write(os.path.join(self.f.b, "db-status.txt"), f"{ts(NOW.replace(hour=2))} FAIL pg_dump exited non-zero\n")
        self.run_wd()
        self.assertIn("pg_dump exited non-zero", self.f.state()["alerts"]["db.status"]["message"])

    def test_db_missed_schedule_and_grace(self):
        # Result from yesterday 02:00: at 03:00 today the run is still within its 2h grace, at 04:30 it is missed.
        self.f.make_healthy(day=NOW - dt.timedelta(days=1))
        for f in os.listdir(os.path.join(self.f.b, "postgres")):
            if "20261110" in f:
                os.remove(os.path.join(self.f.b, "postgres", f))
        self.run_wd(at=NOW.replace(hour=3, minute=0), STATE_DIR=os.path.join(self.tmp, "s1"))
        self.assertNotIn("db.missed", json.load(open(os.path.join(self.tmp, "s1", "state.json")))["alerts"])
        self.run_wd(at=NOW.replace(hour=4, minute=30))
        self.assertIn("db.missed", self.open_keys())
        self.assertIn("files.missed", self.open_keys())

    def test_db_stale_dump(self):
        os.utime(self.f.dump, ((NOW - dt.timedelta(hours=30)).timestamp(),) * 2)
        self.run_wd()
        self.assertIn("db.stale", self.open_keys())

    def test_db_no_dump(self):
        for f in os.listdir(os.path.join(self.f.b, "postgres")):
            os.remove(os.path.join(self.f.b, "postgres", f))
        self.run_wd()
        self.assertIn("db.dump", self.open_keys())

    def test_db_checksum_missing(self):
        os.remove(self.f.dump + ".sha256")
        self.run_wd()
        self.assertIn("checksum file missing", self.f.state()["alerts"]["db.sha256"]["message"])

    def test_db_checksum_mismatch(self):
        mtime = os.stat(self.f.dump).st_mtime
        self.f.write(self.f.dump, b"PGDMP damaged!!")  # same length, different bytes
        os.utime(self.f.dump, (mtime + 1, mtime + 1))
        self.run_wd()
        self.assertIn("MISMATCH", self.f.state()["alerts"]["db.sha256"]["message"])

    # --- B. file backup -------------------------------------------------------------------------
    def test_files_status_failed(self):
        self.f.write(os.path.join(self.f.b, "files-status.txt"), f"{ts(NOW.replace(hour=2, minute=15))} FAIL storage: rsync failed\n")
        self.run_wd()
        self.assertIn("rsync failed", self.f.state()["alerts"]["files.status"]["message"])

    def test_files_manifest_missing(self):
        os.remove(os.path.join(self.f.b, "manifests", "ai-import-vault.sha256"))
        self.run_wd()
        self.assertIn("files.ai-import-vault", self.open_keys())

    def test_files_mirror_changed_and_missing(self):
        self.f.write(os.path.join(self.f.b, "storage", "dir", "storage.bin"), b"tampered")
        os.remove(os.path.join(self.f.b, "import-staging", "dir", "import-staging.bin"))
        self.run_wd()
        self.assertIn("1 of 1 files", self.f.state()["alerts"]["files.storage"]["message"])
        self.assertIn("files.import-staging", self.open_keys())

    def test_manifest_cannot_point_outside_the_mirror(self):
        outside = os.path.join(self.tmp, "outside.bin")
        self.f.write(outside, b"x")
        with open(os.path.join(self.f.b, "manifests", "uploads.sha256"), "a") as f:
            f.write(f"{sha(b'x')}  {outside}\n{sha(b'x')}  ../outside.bin\n")
        self.run_wd()
        self.assertIn("2 of 3 files", self.f.state()["alerts"]["files.uploads"]["message"])

    def test_heavy_check_cached_then_rechecked_after_24h(self):
        self.run_wd()
        self.f.write(os.path.join(self.f.b, "storage", "dir", "storage.bin"), b"tampered")
        self.run_wd(at=NOW + dt.timedelta(hours=1))
        self.assertNotIn("files.storage", self.open_keys())  # cached for HEAVY_EVERY_H (manifest unchanged)
        self.run_wd(at=NOW + dt.timedelta(hours=24, minutes=5))
        self.assertIn("files.storage", self.open_keys())

    # --- C. Full package ------------------------------------------------------------------------
    def test_package_missing(self):
        os.remove(os.path.join(self.f.b, "packages", PKG))
        self.run_wd()
        self.assertIn("pkg.missing", self.open_keys())

    def test_package_corrupt(self):
        self.f.write(os.path.join(self.f.bin, "recorded_sha"), "0" * 64 + "\n")
        self.run_wd()
        self.assertIn("damaged", self.f.state()["alerts"]["pkg.sha256"]["message"])

    def test_package_db_down_uses_cached_recorded_sha(self):
        self.run_wd()
        self.f.write(os.path.join(self.f.bin, "psql_fail"), "1")
        self.assertEqual(self.run_wd(at=NOW + dt.timedelta(minutes=5)), 0)
        os.remove(os.path.join(self.tmp, "state", "state.json"))
        self.run_wd(at=NOW + dt.timedelta(minutes=10))
        self.assertIn("pkg.recorded", self.open_keys())

    def test_psql_query_is_read_only_and_password_not_on_command_line(self):
        self.run_wd()
        calls = [l for l in open(self.f.calls) if l.startswith("psql ")]
        self.assertTrue(calls)
        for l in calls:
            self.assertNotIn("s3cretPW", l)
            self.assertIn("-c select coalesce(", l)
        self.assertEqual(wd.pg_env(self.f.config())["PGOPTIONS"], "-c default_transaction_read_only=on")
        with self.assertRaises(ValueError):
            wd.recorded_package_sha(self.f.config(), "x'; drop table \"User\"; --")

    # --- D. server ------------------------------------------------------------------------------
    def test_health_down(self):
        self.f.health.reply = (503, {"status": "error", "db": "unreachable"})
        self.run_wd()
        self.assertIn("503", self.f.state()["alerts"]["app.health"]["message"])

    def test_postgres_down(self):
        self.f.write(os.path.join(self.f.bin, "pg_rc"), "2")
        self.run_wd()
        self.assertIn("pg.down", self.open_keys())

    def test_pm2_stopped_is_reported_never_restarted(self):
        self.f.pm2_states(["online", "stopped"])
        for i in range(3):
            self.run_wd(at=NOW + dt.timedelta(minutes=5 * i))
        self.assertIn("Not restarted automatically", self.f.state()["alerts"]["pm2.workers"]["message"])
        pm2_calls = [l.split()[1:] for l in open(self.f.calls) if l.startswith("pm2")]
        self.assertTrue(pm2_calls)
        self.assertTrue(all(c == ["jlist"] for c in pm2_calls), pm2_calls)

    def test_pm2_missing_worker(self):
        self.f.pm2_states(["online"])
        self.run_wd()
        self.assertIn("pm2.workers", self.open_keys())

    def test_disk_threshold(self):
        s = os.statvfs(self.tmp)
        used, avail = (s.f_blocks - s.f_bfree) * s.f_frsize, s.f_bavail * s.f_frsize
        pct = -(-used * 100 // (used + avail))
        df = subprocess.run(["df", "--output=pcent", self.tmp], capture_output=True, text=True).stdout.split()[-1].rstrip("%")
        self.assertEqual(pct, int(df))  # same number df shows
        self.run_wd(DISK_WARN_PCT=str(pct))
        self.assertIn("disk.usage", self.open_keys())
        self.run_wd(at=NOW + dt.timedelta(minutes=5), DISK_WARN_PCT=str(pct + 1))
        self.assertNotIn("disk.usage", self.open_keys())

    def test_tls_expiry_and_failure(self):
        wd.tls_days_left = lambda host: 10.0
        self.run_wd()
        self.assertIn("tls.expiry", self.open_keys())

        def boom(host):
            raise OSError("no route")
        wd.tls_days_left = boom
        self.run_wd(at=NOW + dt.timedelta(minutes=5))
        self.assertIn("tls.check", self.open_keys())

    # --- E. alert lifecycle ---------------------------------------------------------------------
    def test_alert_reminder_resolved_reopen(self):
        self.f.pm2_states(["online", "errored"])
        self.run_wd()
        self.run_wd(at=NOW + dt.timedelta(minutes=5))
        later = NOW + dt.timedelta(hours=23, minutes=55)
        self.f.make_healthy(day=later)  # next night's backups ran normally
        self.run_wd(at=later)
        mails = self.f.outbox()
        self.assertEqual(len(mails), 1)  # one alert, no repeat within 24h
        self.assertTrue(mails[0]["subject"].startswith("[mocktestseries] ALERT: 1 new problem"))
        self.assertIn("NEW PROBLEMS", mails[0]["text"])
        self.run_wd(at=NOW + dt.timedelta(hours=24))
        self.assertTrue(self.f.outbox()[1]["subject"].startswith("[mocktestseries] REMINDER"))
        self.f.pm2_states(["online", "online"])
        self.run_wd(at=NOW + dt.timedelta(hours=24, minutes=5))
        resolved = self.f.outbox()[2]
        self.assertTrue(resolved["subject"].startswith("[mocktestseries] RESOLVED: 1 problem(s) resolved, 0 open"))
        self.assertIn("All checks pass now.", resolved["text"])
        self.run_wd(at=NOW + dt.timedelta(hours=24, minutes=10))
        self.assertEqual(len(self.f.outbox()), 3)  # nothing more once resolved
        self.f.pm2_states(["stopped", "online"])
        self.run_wd(at=NOW + dt.timedelta(hours=25))
        self.assertTrue(self.f.outbox()[3]["subject"].startswith("[mocktestseries] ALERT"))

    def test_second_problem_triggers_new_alert_listing_both(self):
        self.f.pm2_states(["online", "errored"])
        self.run_wd()
        self.f.health.reply = (500, {})
        self.run_wd(at=NOW + dt.timedelta(minutes=5))
        m = self.f.outbox()[1]
        self.assertIn("1 new problem(s), 2 open", m["subject"])
        self.assertIn("OTHER OPEN PROBLEMS", m["text"])

    def test_email_disabled_then_configured(self):
        self.f.pm2_states(["online", "errored"])
        self.run_wd(ALERT_TO="")
        self.assertEqual(self.f.outbox(), [])
        self.assertIn("email not configured", self.f.status())
        self.run_wd(at=NOW + dt.timedelta(minutes=5))
        self.assertEqual(len(self.f.outbox()), 1)  # pending alert goes out once configured

    def test_problem_cleared_before_any_email_is_silent(self):
        self.f.pm2_states(["online", "errored"])
        self.run_wd(EMAIL_MODE="off")
        self.f.pm2_states(["online", "online"])
        self.run_wd(at=NOW + dt.timedelta(minutes=5))
        self.assertEqual(self.f.outbox(), [])

    def test_resend_send_success_failure_retry_and_no_secret_leak(self):
        resend = serve((500, {"message": "boom"}))
        try:
            self.f.pm2_states(["online", "errored"])
            self.run_wd(EMAIL_MODE="send", RESEND_URL=f"http://127.0.0.1:{resend.server_port}/emails")
            self.assertIn("Resend HTTP 500", self.f.status())
            self.assertIsNone(self.f.state()["alerts"]["pm2.workers"]["last_sent"])
            resend.reply = (200, {"id": "x"})
            self.run_wd(at=NOW + dt.timedelta(minutes=5), EMAIL_MODE="send", RESEND_URL=f"http://127.0.0.1:{resend.server_port}/emails")
            self.assertEqual(len(resend.requests), 2)
            r = resend.requests[1]
            self.assertEqual(r["auth"], f"Bearer {FAKE_KEY}")
            self.assertEqual(r["body"]["to"], ["owner@example.test"])
            self.assertEqual(r["body"]["from"], "MTS <no-reply@example.test>")
            self.assertTrue(r["body"]["subject"].startswith("[mocktestseries] ALERT"))
            # resolution fails once -> kept as cleared (not open) and retried
            self.f.pm2_states(["online", "online"])
            resend.reply = (500, {})
            self.assertEqual(self.run_wd(at=NOW + dt.timedelta(minutes=10), EMAIL_MODE="send", RESEND_URL=f"http://127.0.0.1:{resend.server_port}/emails"), 0)
            self.assertTrue(self.f.state()["alerts"]["pm2.workers"]["cleared"])
            resend.reply = (200, {"id": "y"})
            self.run_wd(at=NOW + dt.timedelta(minutes=15), EMAIL_MODE="send", RESEND_URL=f"http://127.0.0.1:{resend.server_port}/emails")
            self.assertTrue(resend.requests[-1]["body"]["subject"].startswith("[mocktestseries] RESOLVED"))
            self.assertEqual(self.f.state()["alerts"], {})
            for r in resend.requests:
                self.assertNotIn(FAKE_KEY, json.dumps(r["body"]))
                self.assertNotIn("s3cretPW", json.dumps(r["body"]))
        finally:
            resend.shutdown()
            resend.server_close()
        for p in [os.path.join(self.tmp, "log", "watchdog.log"), os.path.join(self.tmp, "log", "watchdog-status.txt"), os.path.join(self.tmp, "state", "state.json")]:
            text = open(p).read()
            self.assertNotIn(FAKE_KEY, text)
            self.assertNotIn("s3cretPW", text)

    def test_state_and_status_are_root_only(self):
        self.run_wd()
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.tmp, "state")).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.tmp, "state", "state.json")).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.tmp, "log", "watchdog-status.txt")).st_mode), 0o600)

    def test_a_crashing_check_does_not_hide_others(self):
        orig = wd.CHECKS[:]
        def broken(c, s, n):
            raise RuntimeError("x")
        wd.CHECKS.insert(0, broken)
        try:
            self.f.pm2_states(["stopped"])
            self.run_wd()
        finally:
            wd.CHECKS[:] = orig
        self.assertIn("broken.error", self.open_keys())
        self.assertIn("pm2.workers", self.open_keys())

    # --- no automatic restarts, by construction --------------------------------------------------
    def test_only_read_only_commands_are_ever_run(self):
        seen = []
        real = subprocess.run
        def spy(cmd, *a, **k):
            seen.append([os.path.basename(cmd[0])] + list(cmd[1:2]))
            return real(cmd, *a, **k)
        wd.subprocess.run = spy
        try:
            self.f.pm2_states(["stopped", "errored"])
            self.f.write(os.path.join(self.f.bin, "pg_rc"), "2")
            self.run_wd()
        finally:
            wd.subprocess.run = real
        self.assertEqual(sorted({c[0] for c in seen}), ["pg_isready", "pm2", "psql"])
        self.assertTrue(all(c[1] in ("jlist", "-q", "-X") for c in seen), seen)
        src = open(os.path.join(HERE, "mocktestseries-watchdog.py")).read()
        for word in ['"restart"', '"reload"', "systemctl", "os.system", "shell=True", '"stop"', "kill"]:
            self.assertNotIn(word, src)


    # --- G. SEO Intelligence daily sync ---------------------------------------------------------
    def seo_setup(self, line=None, cron_mtime=None):
        cron = os.path.join(self.tmp, "cron.d", "mocktestseries-seo-intel")
        self.f.write(cron, "40 21 * * * root true\n", cron_mtime or (NOW - dt.timedelta(days=3)))
        if line is not None:
            self.f.write(os.path.join(self.tmp, "log", "seo-intel-status.txt"), line)

    def last_run(self):
        return (NOW - dt.timedelta(days=1)).replace(hour=21, minute=40, second=5)

    def test_seo_silent_without_cron(self):
        self.assertEqual(self.run_wd(), 0)
        self.assertEqual(self.open_keys(), [])

    def test_seo_ok(self):
        self.seo_setup(seo_line(self.last_run(), "OK", 0, "ok"))
        self.assertEqual(self.run_wd(), 0)

    def test_seo_daily_sync_off_is_not_an_alert(self):
        self.seo_setup(seo_line(self.last_run(), "SKIPPED", 0, "daily-sync-off"))
        self.assertEqual(self.run_wd(), 0)

    def test_seo_missing_status_after_first_scheduled_run(self):
        self.seo_setup()
        self.assertEqual(self.run_wd(), 1)
        self.assertIn("seo.status", self.open_keys())

    def test_seo_missing_status_before_first_run_is_fine(self):
        self.seo_setup(cron_mtime=NOW - dt.timedelta(hours=2))
        self.assertEqual(self.run_wd(), 0)

    def test_seo_missed_run(self):
        self.seo_setup(seo_line(self.last_run() - dt.timedelta(days=2), "OK", 0, "ok"))
        self.run_wd()
        self.assertIn("seo.missed", self.open_keys())

    def test_seo_single_failure_tolerated(self):
        self.seo_setup(seo_line(self.last_run(), "FAIL", 1, "google-sync-failed-gsc"))
        self.assertEqual(self.run_wd(), 0)

    def test_seo_second_consecutive_failure_alerts(self):
        self.seo_setup(seo_line(self.last_run(), "FAIL", 2, "google-sync-failed-gsc"))
        self.run_wd()
        self.assertIn("seo.failing", self.open_keys())
        self.assertEqual(len(self.f.outbox()), 1)

    def test_seo_reconnect_alerts_immediately(self):
        self.seo_setup(seo_line(self.last_run(), "FAIL", 1, "google-needs-reconnect"))
        self.run_wd()
        self.assertIn("seo.google", self.open_keys())

    def test_seo_alert_clears_when_sync_recovers(self):
        self.seo_setup(seo_line(self.last_run(), "FAIL", 3, "google-sync-failed-ga4"))
        self.run_wd()
        self.seo_setup(seo_line(self.last_run() + dt.timedelta(minutes=30), "OK", 0, "ok"))
        self.run_wd(at=NOW + dt.timedelta(minutes=10))
        self.assertEqual(self.open_keys(), [])
        self.assertTrue(any("resolved" in json.dumps(m).lower() or "cleared" in json.dumps(m).lower() for m in self.f.outbox()))

    def test_seo_garbage_status(self):
        self.seo_setup("not a status line\n")
        self.run_wd()
        self.assertIn("seo.status", self.open_keys())

    def test_seo_alert_never_contains_secrets(self):
        self.seo_setup(seo_line(self.last_run(), "FAIL", 2, "google-sync-failed-gsc"))
        self.run_wd()
        self.assertNotIn(FAKE_KEY, json.dumps(self.f.outbox()) + self.f.status())

if __name__ == "__main__":
    unittest.main(verbosity=2)
