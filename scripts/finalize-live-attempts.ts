/**
 * Live CBT window-end sweep (lib/live-cbt.ts#finalizeClosedWindowAttempts).
 * Run by cron every minute (/etc/cron.d/mocktestseries-live-cbt, source
 * ops/live-cbt/):
 *
 *   cd /var/www/mocktestseries-current && flock -n /run/mocktestseries-live-cbt.lock \
 *     env NODE_OPTIONS=--conditions=react-server npx --no-install tsx scripts/finalize-live-attempts.ts
 *
 * Each run polls for up to ~50 s (every 10 s), so a student who closed the
 * browser is finalized within seconds of the Fixed Window closing — without
 * ever reopening the site — and the leaderboard is complete at release.
 * Idempotent and safe to rerun or run concurrently with the app: it only
 * calls the engine's conditional IN_PROGRESS → SUBMITTED finalize.
 *
 *   --once       one pass, then exit
 *
 * Logs counts only.
 */
import "dotenv/config";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { finalizeClosedWindowAttempts } = await import("@/lib/live-cbt");
  const { prisma } = await import("@/lib/prisma");
  const once = process.argv.includes("--once");
  const until = Date.now() + 50_000;
  try {
    do {
      const { candidates, finalized } = await finalizeClosedWindowAttempts();
      if (candidates > 0) console.log(`[live-cbt] ${new Date().toISOString()} candidates=${candidates} finalized=${finalized}`);
      if (once) break;
      await sleep(10_000);
    } while (Date.now() < until);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[live-cbt] sweep failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
