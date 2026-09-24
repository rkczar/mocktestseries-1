/**
 * Daily automatic retention runner (cron, /etc/cron.d/mocktestseries-backups).
 *
 * Does NOTHING unless a Master Admin enabled "Automatic Retention Cleanup" in
 * Admin → Backup → Retention (OFF by default). When enabled it deletes only
 * what the Backup Center's release/backup plans already classify as
 * cleanup-eligible, under the same maintenance lock, and audits every run
 * that deletes (RETENTION_AUTO_CLEANUP).
 *
 *   cd /var/www/mocktestseries-current && NODE_OPTIONS="--conditions=react-server" npx --no-install tsx scripts/backup-auto-retention.ts
 */
import "dotenv/config";

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { PRODUCTION_ROOTS } = await import("../lib/backup/roots");
  const { getRetentionSettings } = await import("../lib/backup/settings");
  const { runAutoRetention } = await import("../lib/backup/maintenance");
  try {
    const settings = await getRetentionSettings();
    const stamp = new Date().toISOString();
    if (!settings.autoCleanup) {
      console.log(`${stamp} auto-retention: disabled (Admin → Backup → Retention) — nothing to do`);
      return;
    }
    const r = await runAutoRetention(PRODUCTION_ROOTS, settings);
    const fmt = (o?: { deleted: { label: string }[]; reclaimed: number | null; remaining: number }) => (o ? `${o.deleted.length} deleted, ${o.remaining} remaining, reclaimed ${o.reclaimed ?? "?"} bytes` : "n/a");
    console.log(`${stamp} auto-retention: releases ${fmt(r.releases)}; backups ${fmt(r.backups)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} auto-retention failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
