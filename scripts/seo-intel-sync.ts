/**
 * SEO Intelligence daily scheduled sync (Admin → SEO → Intelligence →
 * "Daily automatic sync"). Run by cron once a day (/etc/cron.d/mocktestseries-seo-intel,
 * source ops/seo/):
 *
 *   cd /var/www/mocktestseries-current && NODE_OPTIONS="--conditions=react-server" npx --no-install tsx scripts/seo-intel-sync.ts
 *
 * Does nothing while the switch is OFF (the default). Otherwise, independently:
 *   - Search Console + GA4 (same as "Sync now", lib/seo-intel/sync.ts) unless
 *     Google is not connected or the connection needs a reconnect (no point
 *     retrying a revoked grant every day);
 *   - PageSpeed + Core Web Vitals (lib/seo-intel/pagespeed.ts) when the
 *     PageSpeed API key is installed.
 * Each part is audited with no actor. Logs status only — never a token, key,
 * secret or report row.
 */
import "dotenv/config";
import { renameSync, writeFileSync } from "node:fs";

/**
 * One-line status for the watchdog (ops/monitoring/mocktestseries-watchdog.py, check_seo_intel):
 *   <ISO time> <OK|FAIL|SKIPPED> streak=<consecutive Google sync failures> <reason>
 * Reasons are fixed words only — never a token, key, secret or Google error text.
 */
const STATUS_FILE = process.env.SEO_INTEL_STATUS_FILE || "/var/log/mocktestseries/seo-intel-status.txt";
function writeStatus(state: "OK" | "FAIL" | "SKIPPED", streak: number, reason: string) {
  try {
    const tmp = `${STATUS_FILE}.tmp`;
    writeFileSync(tmp, `${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")} ${state} streak=${streak} ${reason}\n`, { mode: 0o644 });
    renameSync(tmp, STATUS_FILE);
  } catch {
    console.error(`${new Date().toISOString()} seo-intel-sync: could not write the status file`);
  }
}

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { getIntelSettings } = await import("../lib/seo-intel/history");
  const { getConnectionView } = await import("../lib/seo-intel/google");
  const { runSync } = await import("../lib/seo-intel/sync");
  const { getKeyView, runPageSpeed } = await import("../lib/seo-intel/pagespeed");
  const { getSnapshot } = await import("../lib/seo-intel/sync");
  const stamp = () => new Date().toISOString();
  const problems: string[] = [];
  let finished = false;
  try {
    const settings = await getIntelSettings();
    if (!settings.autoSyncEnabled) {
      finished = true;
      writeStatus("SKIPPED", 0, "daily-sync-off");
      return console.log(`${stamp()} seo-intel-sync: skipped (daily sync is OFF)`);
    }

    // 1. Search Console + GA4 (needs the Google connection).
    const conn = await getConnectionView();
    if (!conn.connected) {
      problems.push("google-not-connected");
      console.log(`${stamp()} seo-intel-sync: google skipped (Google not connected)`);
    } else if (conn.needsReconnect) {
      problems.push("google-needs-reconnect");
      console.log(`${stamp()} seo-intel-sync: google skipped (connection needs a Master Admin to reconnect)`);
    }
    else {
      const r = await runSync(null, "scheduled");
      if (r.skipped) console.log(`${stamp()} seo-intel-sync: google skipped (${r.message})`);
      else {
        await prisma.auditLog.create({
          data: {
            actorId: null,
            action: "SEO_GOOGLE_SYNC",
            entityType: "Setting",
            entityId: "seo.intel.snapshot",
            metadata: { source: "scheduled", ok: r.ok, gscError: r.gscError, ga4Error: r.ga4Error },
          },
        });
        console.log(
          `${stamp()} seo-intel-sync: google ${r.ok ? "ok" : "FAILED"} gsc=${r.gscError ? "error" : "ok"} ga4=${r.ga4Error ? "error" : "ok"} history=${r.historyDate ?? "none"} pruned=${r.pruned ?? 0}`
        );
        if (!r.ok) {
          process.exitCode = 1;
          problems.push((await getConnectionView()).needsReconnect ? "google-needs-reconnect" : `google-sync-failed${r.gscError ? "-gsc" : ""}${r.ga4Error ? "-ga4" : ""}`);
        }
      }
    }

    // 2. PageSpeed + Core Web Vitals (needs only the API key).
    if (!(await getKeyView()).installed) console.log(`${stamp()} seo-intel-sync: pagespeed skipped (API key not installed)`);
    else {
      const p = await runPageSpeed(null, "scheduled");
      if (p.skipped) console.log(`${stamp()} seo-intel-sync: pagespeed skipped (${p.message})`);
      else {
        await prisma.auditLog.create({
          data: { actorId: null, action: "SEO_PAGESPEED_RUN", entityType: "Setting", entityId: "seo.intel.pagespeed", metadata: { source: "scheduled", ok: p.ok, errors: p.errors } },
        });
        console.log(`${stamp()} seo-intel-sync: pagespeed ${p.ok ? "ok" : "FAILED"} errors=${p.errors}`);
        if (!p.ok) {
          process.exitCode = 1;
          problems.push("pagespeed-failed");
        }
      }
    }
    const streak = (await getSnapshot()).lastSync?.failStreak ?? 0;
    finished = true;
    writeStatus(problems.length ? "FAIL" : "OK", streak, problems.join(",") || "ok");
  } catch (e) {
    finished = true;
    writeStatus("FAIL", 0, "sync-crashed");
    throw e;
  } finally {
    if (!finished) writeStatus("FAIL", 0, "sync-crashed");
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} seo-intel-sync failed: ${e instanceof Error ? e.name : "UNKNOWN"}`);
  process.exit(1);
});
