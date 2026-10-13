/**
 * Premium Trial reminders (Admin → Payments → Free Access & Trial). Run by
 * cron every 5 minutes (/etc/cron.d/mocktestseries-trial-reminders, source
 * ops/premium-trial/):
 *
 *   cd /var/www/mocktestseries-current && NODE_OPTIONS="--conditions=react-server" npx --no-install tsx scripts/trial-reminders.ts
 *
 * Idempotent (lib/premium-trial.ts#runTrialReminders): each reminder is
 * claimed once per trial in StudentTrialNotice and queued once in the email
 * queue, which delivers only while production sending is ON. Does nothing
 * while Premium Access Enforcement is OFF. Logs counts only.
 */
import "dotenv/config";

async function main() {
  const { prisma } = await import("../lib/prisma");
  const { runTrialReminders } = await import("../lib/premium-trial");
  try {
    const started = Date.now();
    const r = await runTrialReminders();
    const stamp = new Date().toISOString();
    console.log(
      r.skipped
        ? `${stamp} trial-reminders: skipped (${r.skipped})`
        : `${stamp} trial-reminders: checked=${r.checked} queued=${r.queued} paidSkipped=${r.paidSkipped} ms=${Date.now() - started}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`${new Date().toISOString()} trial-reminders failed: ${e instanceof Error ? e.name : "UNKNOWN"}`);
  process.exit(1);
});
