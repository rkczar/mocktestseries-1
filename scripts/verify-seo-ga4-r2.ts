/**
 * SEO/GA4 Release 2: runs the REAL cron entry point (scripts/seo-intel-sync.ts, as a child process) against the
 * loopback Google mock on a DISPOSABLE database (name must contain "seoga4") and checks the one-line status file the
 * watchdog reads: SKIPPED when the daily switch is OFF, OK, FAIL streak=1 → streak=2, google-needs-reconnect,
 * google-not-connected — and that no token/secret ever reaches the status file or the log.
 *
 *   DATABASE_URL=<mts_*seoga4*> AUTH_SECRET=<scratch> NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-seo-ga4-r2.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dbUrl = process.env.DATABASE_URL ?? "";
if (!/seoga4/.test(dbUrl.split("/").pop() ?? "")) {
  console.error("Refusing to run: DATABASE_URL must be a scratch database whose name contains 'seoga4'.");
  process.exit(2);
}
const PORT = 3553;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.SEO_GOOGLE_TEST_BASE_URL = BASE;
const dir = mkdtempSync(path.join(tmpdir(), "seo-r2-"));
const STATUS = path.join(dir, "seo-intel-status.txt");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failed++;
};
const control = (body: unknown) => fetch(`${BASE}/__mock/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const logs: string[] = [];
function runCron(): { code: number | null; status: string } {
  const r = spawnSync(process.execPath, ["node_modules/.bin/tsx", "scripts/seo-intel-sync.ts"], {
    env: { ...process.env, SEO_INTEL_STATUS_FILE: STATUS, SEO_RETRY_DELAY_MS: "10" },
    encoding: "utf8",
    timeout: 120_000,
  });
  logs.push(r.stdout, r.stderr);
  return { code: r.status, status: existsSync(STATUS) ? readFileSync(STATUS, "utf8").trim() : "" };
}

async function main() {
  const mock = spawn(process.execPath, ["scripts/mock-google-seo.mjs", String(PORT)], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`${BASE}/__mock/stats`)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const { prisma } = await import("@/lib/prisma");
    const { setClientCredentials, CONNECTION_SETTING_KEY } = await import("@/lib/seo-intel/google");
    const { SNAPSHOT_SETTING_KEY } = await import("@/lib/seo-intel/sync");
    const { encryptSecret } = await import("@/lib/secret-cipher");
    const { saveIntelSettings } = await import("@/lib/seo-intel/history");
    const backdate = async () => {
      const row = await prisma.setting.findUnique({ where: { key: SNAPSHOT_SETTING_KEY } });
      const v = row?.value as { lastSync?: { at: string } } | undefined;
      if (v?.lastSync) await prisma.setting.update({ where: { key: SNAPSHOT_SETTING_KEY }, data: { value: { ...v, lastSync: { ...v.lastSync, at: new Date(Date.now() - 10 * 60_000).toISOString() } } as object } });
    };

    await prisma.setting.deleteMany({ where: { key: { startsWith: "seo." } } });
    let r = runCron();
    check("C1 daily sync OFF → SKIPPED daily-sync-off, exit 0", /^\S+Z SKIPPED streak=0 daily-sync-off$/.test(r.status) && r.code === 0, r.status);

    await saveIntelSettings({ autoSyncEnabled: true });
    r = runCron();
    check("C2 ON but Google not connected → FAIL google-not-connected", / FAIL streak=0 google-not-connected$/.test(r.status), r.status);

    await setClientCredentials("123456789012-mockseoclientabcdefghijk.apps.googleusercontent.com", "GOCSPX-mockSeoSecret-1234567890abc");
    const refresh = "1//mock-seeded-refresh-r2";
    await control({ seedRefresh: { token: refresh, email: "seo-owner@example.test" }, scenario: "ok" });
    const conn = (await prisma.setting.findUniqueOrThrow({ where: { key: CONNECTION_SETTING_KEY } })).value as Record<string, unknown>;
    await prisma.setting.update({ where: { key: CONNECTION_SETTING_KEY }, data: { value: { ...conn, refreshTokenCipher: encryptSecret(refresh), accountEmail: "seo-owner@example.test", grantedScopes: ["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/analytics.readonly"], connectedAt: new Date().toISOString() } } });

    r = runCron();
    check("C3 connected → OK streak=0, exit 0", / OK streak=0 ok$/.test(r.status) && r.code === 0, r.status);

    await backdate();
    await control({ failNext: { count: 50, status: 500, match: "searchAnalytics" } });
    r = runCron();
    check("C4 GSC down (after retries) → FAIL streak=1 google-sync-failed-gsc, exit 1", / FAIL streak=1 google-sync-failed-gsc$/.test(r.status) && r.code === 1, r.status);

    await backdate();
    await control({ failNext: { count: 50, status: 500, match: "searchAnalytics" } });
    r = runCron();
    check("C5 second failed day → streak=2 (watchdog alerts)", / FAIL streak=2 google-sync-failed-gsc$/.test(r.status), r.status);

    await backdate();
    await control({ failNext: { count: 0 }, scenario: "ok" });
    r = runCron();
    check("C6 recovery → OK streak=0", / OK streak=0 ok$/.test(r.status), r.status);

    await backdate();
    await control({ scenario: "invalidGrant" });
    r = runCron();
    check("C7 revoked grant → FAIL google-needs-reconnect", / FAIL streak=\d+ google-needs-reconnect$/.test(r.status), r.status);
    r = runCron();
    check("C8 next day still needs reconnect (no Google call) → FAIL google-needs-reconnect", / FAIL streak=\d+ google-needs-reconnect$/.test(r.status), r.status);

    const secrets = [refresh, "GOCSPX-mockSeoSecret-1234567890abc", process.env.AUTH_SECRET ?? "-"];
    const all = logs.join("\n") + readFileSync(STATUS, "utf8");
    check("C9 no secret in status file or cron log", secrets.every((s) => !all.includes(s)));
    check("C10 status file is one line, world-readable 0644 not required for secrets (fixed words only)", readFileSync(STATUS, "utf8").split("\n").filter(Boolean).length === 1);

    await prisma.$disconnect();
  } finally {
    mock.kill();
  }
  console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
