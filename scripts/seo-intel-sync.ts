/**
 * SEO Intelligence daily scheduled sync (Admin → SEO → Intelligence →
 * "Daily automatic sync"). Run by cron once a day (/etc/cron.d/mocktestseries-seo-intel,
 * source ops/seo/):
 *
 *   cd /var/www/mocktestseries-current && NODE_OPTIONS="--conditions=react-server" npx --no-install tsx scripts/seo-intel-sync.ts
 *
 * Does nothing while the switch is OFF (the default), while Google is not
 * connected, or while the connection needs a Master Admin to reconnect (no
 * point retrying a revoked grant every day). Otherwise the same read-only sync
 * as "Sync now" (lib/seo-intel/sync.ts), audited with no actor. Logs status
 * only — never a token, secret or report row.
 */
import "dotenv/config";

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { getIntelSettings } = await import("../lib/seo-intel/history");
  const { getConnectionView } = await import("../lib/seo-intel/google");
  const { runSync } = await import("../lib/seo-intel/sync");
  const stamp = () => new Date().toISOString();
  try {
    const settings = await getIntelSettings();
    if (!settings.autoSyncEnabled) return console.log(`${stamp()} seo-intel-sync: skipped (daily sync is OFF)`);
    const conn = await getConnectionView();
    if (!conn.connected) return console.log(`${stamp()} seo-intel-sync: skipped (Google not connected)`);
    if (conn.needsReconnect) return console.log(`${stamp()} seo-intel-sync: skipped (connection needs a Master Admin to reconnect)`);

    const r = await runSync(null, "scheduled");
    if (r.skipped) return console.log(`${stamp()} seo-intel-sync: skipped (${r.message})`);
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
      `${stamp()} seo-intel-sync: ${r.ok ? "ok" : "FAILED"} gsc=${r.gscError ? "error" : "ok"} ga4=${r.ga4Error ? "error" : "ok"} history=${r.historyDate ?? "none"} pruned=${r.pruned ?? 0}`
    );
    if (!r.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} seo-intel-sync failed: ${e instanceof Error ? e.name : "UNKNOWN"}`);
  process.exit(1);
});
