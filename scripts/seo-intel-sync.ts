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

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { getIntelSettings } = await import("../lib/seo-intel/history");
  const { getConnectionView } = await import("../lib/seo-intel/google");
  const { runSync } = await import("../lib/seo-intel/sync");
  const { getKeyView, runPageSpeed } = await import("../lib/seo-intel/pagespeed");
  const stamp = () => new Date().toISOString();
  try {
    const settings = await getIntelSettings();
    if (!settings.autoSyncEnabled) return console.log(`${stamp()} seo-intel-sync: skipped (daily sync is OFF)`);

    // 1. Search Console + GA4 (needs the Google connection).
    const conn = await getConnectionView();
    if (!conn.connected) console.log(`${stamp()} seo-intel-sync: google skipped (Google not connected)`);
    else if (conn.needsReconnect) console.log(`${stamp()} seo-intel-sync: google skipped (connection needs a Master Admin to reconnect)`);
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
        if (!r.ok) process.exitCode = 1;
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
        if (!p.ok) process.exitCode = 1;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} seo-intel-sync failed: ${e instanceof Error ? e.name : "UNKNOWN"}`);
  process.exit(1);
});
