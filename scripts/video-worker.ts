/**
 * AI Video Studio worker — script, narration, transcription, rendering and
 * export run HERE, never inside a web request. Run by cron every minute
 * (/etc/cron.d/mocktestseries-video, source ops/video-worker/) and started at
 * once by the admin actions (lib/video-studio/kick.ts), both under the SAME
 * flock, so at most one worker (and one render container) ever runs:
 *
 *   cd /var/www/mocktestseries-current && flock -n /run/mocktestseries-video.lock \
 *     nice -n 10 env NODE_OPTIONS=--conditions=react-server npx --no-install tsx scripts/video-worker.ts
 *
 * Starts nothing while a Live CBT is running (or starts within 15 minutes).
 * Logs job ids and counts only.
 *
 *   --seconds=N  run budget (default 540)
 */
import "dotenv/config";

async function main() {
  const budgetArg = process.argv.find((a) => a.startsWith("--seconds="));
  const budgetMs = (budgetArg ? Number(budgetArg.split("=")[1]) : 540) * 1000;
  const { prisma } = await import("../lib/prisma");
  const { runVideoWorker } = await import("../lib/video-studio/pipeline");
  try {
    const r = await runVideoWorker(budgetMs);
    if (r.handled || r.paused) console.log(`${new Date().toISOString()} video-worker handled=${r.handled}${r.paused ? " (paused: Live CBT running)" : ""}${r.render ? "" : " (render image unavailable)"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} video-worker error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
