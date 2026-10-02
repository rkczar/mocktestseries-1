/**
 * Email queue worker — drains EmailDeliveryLog (lib/email/queue.ts). Run by
 * cron every minute (/etc/cron.d/mocktestseries-email, source ops/email/):
 *
 *   cd /var/www/mocktestseries-current && flock -n /run/mocktestseries-email.lock \
 *     env NODE_OPTIONS=--conditions=react-server npx --no-install tsx scripts/email-worker.ts
 *
 * Each run works for up to ~55 s (polling every few seconds when idle), so
 * queued email goes out within seconds, and every run picks up the current
 * release's code. flock guarantees ONE worker at a time, which also makes
 * the configured send rate global. A killed run is safe: its SENDING rows
 * return to the queue after 10 minutes and the provider idempotency key
 * (row id) prevents a duplicate delivery.
 *
 * With no RESEND_API_KEY nothing is sent: automatic email is marked
 * SKIPPED ("Email provider not configured") and campaigns stay queued.
 *
 *   --once       one batch, then exit
 *   --seconds=N  run budget (default 55)
 *
 * Logs counts only — never addresses, content or credentials.
 */
import "dotenv/config";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const once = process.argv.includes("--once");
  const budgetArg = process.argv.find((a) => a.startsWith("--seconds="));
  const budgetMs = (budgetArg ? Number(budgetArg.split("=")[1]) : 55) * 1000;
  const { prisma } = await import("../lib/prisma");
  const { releaseStaleLocks, runEmailWorkerBatch, completeFinishedCampaigns } = await import("../lib/email/queue");
  const { recordWorkerHeartbeat } = await import("../lib/email/admin");
  const started = Date.now();
  const totals = { claimed: 0, sent: 0, retried: 0, failed: 0, skipped: 0, paused: 0 };
  try {
    // Shown in Admin → Communications → Email → Settings ("Queue worker: last run …").
    await recordWorkerHeartbeat();
    const released = await releaseStaleLocks();
    if (released) console.log(`${new Date().toISOString()} email-worker released ${released} stale row(s)`);
    await completeFinishedCampaigns();
    do {
      const r = await runEmailWorkerBatch();
      totals.claimed += r.claimed;
      totals.sent += r.sent;
      totals.retried += r.retried;
      totals.failed += r.failed;
      totals.skipped += r.skipped;
      totals.paused += r.paused;
      if (once) break;
      if (r.rateLimitedFor) await sleep(r.rateLimitedFor * 1000);
      else if (r.claimed === 0 || r.claimed === r.paused) await sleep(3000);
    } while (Date.now() - started < budgetMs);
  } finally {
    await prisma.$disconnect();
  }
  if (totals.claimed > 0) {
    console.log(
      `${new Date().toISOString()} email-worker claimed=${totals.claimed} sent=${totals.sent} retried=${totals.retried} failed=${totals.failed} skipped=${totals.skipped} paused=${totals.paused} ms=${Date.now() - started}`
    );
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} email-worker failed: ${e instanceof Error ? e.name : "UNKNOWN"}`);
  process.exit(1);
});
