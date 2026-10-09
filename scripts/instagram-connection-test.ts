/**
 * Instagram API — read-only connection test from the server shell (same check
 * as Admin → Instagram → Settings → Test connection, but saves nothing).
 *
 *   cd /var/www/mocktestseries-current
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/instagram-connection-test.ts
 *
 * Prints identity + permission status only; the token is never printed.
 * Exit code 0 = connected (with or without publishing permission), 1 = not.
 */
import "dotenv/config";
import { getConnectionConfigView, runConnectionTest } from "@/lib/instagram/meta";

async function main() {
  const config = getConnectionConfigView();
  console.log(`Token configured: ${config.tokenConfigured ? `yes (fingerprint ${config.tokenFingerprint})` : "no"}`);
  console.log(`Pinned INSTAGRAM_USER_ID: ${config.userIdConfigured ?? "not set"}`);
  console.log(`Token expiry: ${config.expiry.state}${config.expiry.estimatedExpiresAt ? ` (≈ ${config.expiry.estimatedExpiresAt}, ${config.expiry.daysLeft} days left)` : ""}`);
  console.log(`API version: ${config.apiVersion}`);
  for (const w of config.warnings) console.log(`Warning: ${w}`);

  const r = await runConnectionTest();
  console.log(`\nStatus: ${r.status} — ${r.summary}`);
  if (r.account) console.log(`Account: @${r.account.username} · user_id ${r.account.userId} · ${r.account.accountType ?? "?"} · ${r.account.mediaCount ?? "?"} posts`);
  console.log(`Publishing permission: ${r.publishPermission}${r.publishingQuota ? ` (quota ${r.publishingQuota.usage}/${r.publishingQuota.total ?? "?"})` : ""}`);
  for (const c of r.checks) console.log(`  [${c.state.toUpperCase()}] ${c.label}: ${c.detail}`);
  if (r.error) console.log(`Meta error: code ${r.error.code ?? "-"} / subcode ${r.error.subcode ?? "-"}: ${r.error.message}`);
  console.log(`(${r.durationMs} ms)`);
  process.exit(r.ok ? 0 : 1);
}

main().catch(() => {
  console.error("Connection test crashed.");
  process.exit(2);
});
