/**
 * Scheduled payment reconciliation — the recovery safety net behind the
 * Razorpay webhook (the primary, real-time path). Run by cron every 15 min
 * (/etc/cron.d/mocktestseries-payments, source ops/payments/):
 *
 *   cd /var/www/mocktestseries-current && NODE_OPTIONS="--conditions=react-server" npx --no-install tsx scripts/reconcile-payments.ts [--dry-run]
 *
 * Re-reads unresolved/stale gateway orders from Razorpay (each with its own
 * TEST/LIVE credentials, with per-order backoff) and fulfils only genuinely
 * captured payments through the existing idempotent fulfilment code. With no
 * orders it makes no Razorpay call at all. --dry-run lists what is due
 * without calling Razorpay or writing anything.
 *
 * Logs only order id, environment, result and latency — never credentials,
 * student details or payment-instrument data.
 */
import "dotenv/config";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { prisma } = await import("../lib/prisma");
  const { runScheduledReconciliation } = await import("../lib/payments/reconcile");
  try {
    const started = Date.now();
    const r = await runScheduledReconciliation({ dryRun });
    const stamp = new Date().toISOString();
    for (const e of r.entries) console.log(`${stamp} reconcile order=${e.orderId} env=${e.environment} result=${e.result} ms=${e.ms}`);
    console.log(
      `${stamp} reconcile${dryRun ? " (dry-run)" : ""}: expired=${r.expired} candidates=${r.candidates} due=${r.due} skippedNoCredentials=${r.skippedNoCredentials} actions=${r.entries.length} ms=${Date.now() - started}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} reconcile failed: ${e instanceof Error ? e.name : "UNKNOWN"}`);
  process.exit(1);
});
