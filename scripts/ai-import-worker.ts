/**
 * AI Question Importer worker — analysis, extraction, verification and the
 * import into the existing Bulk Import pipeline run HERE, never inside a web
 * request. Run by cron every minute (/etc/cron.d/mocktestseries-ai-import,
 * source ops/ai-import/) and started at once by the admin actions
 * (lib/ai-import/kick.ts), both under the same flock:
 *
 *   cd /var/www/mocktestseries-current && flock -n /run/mocktestseries-ai-import.lock \
 *     nice -n 10 env NODE_OPTIONS=--conditions=react-server npx --no-install tsx scripts/ai-import-worker.ts
 *
 * One job at a time, leased and checkpointed per page / stage: a killed run is
 * picked up by the next one. While a Live CBT is running (or starts within
 * 15 minutes) it starts nothing. Logs job ids and counts only.
 *
 *   --seconds=N  run budget (default 540)
 */
import "dotenv/config";

async function main() {
  const budgetArg = process.argv.find((a) => a.startsWith("--seconds="));
  const budgetMs = (budgetArg ? Number(budgetArg.split("=")[1]) : 540) * 1000;
  const { prisma } = await import("../lib/prisma");
  const { runWorker } = await import("../lib/ai-import/worker");
  try {
    const r = await runWorker(budgetMs);
    if (r.handled || r.skippedForLiveCbt) console.log(`${new Date().toISOString()} ai-import-worker handled=${r.handled}${r.skippedForLiveCbt ? " (paused: Live CBT running)" : ""}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} ai-import-worker error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
