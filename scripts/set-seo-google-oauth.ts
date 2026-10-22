/**
 * Called by ops/seo/set-google-oauth.sh — never run with a secret as an argument.
 *   set     reads "<client id>\n<client secret>" from stdin, stores them in Setting seo.google.oauth
 *           (secret encrypted with AUTH_SECRET). The dedicated SEO OAuth client — never the student login one.
 *   status  prints whether the client is installed and whether Google is connected (no secrets)
 *   clear   revokes + removes the Google connection, then removes the client credentials
 * Needs NODE_OPTIONS=--conditions=react-server and the shared .env (DATABASE_URL, AUTH_SECRET).
 */
import { clearAll, disconnect, getConnectionView, setClientCredentials } from "@/lib/seo-intel/google";
import { prisma } from "@/lib/prisma";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

async function main() {
  const mode = process.argv[2] ?? "status";
  if (mode === "set") {
    const [clientId = "", clientSecret = ""] = (await readStdin()).split("\n").map((s) => s.trim());
    const { clientChanged } = await setClientCredentials(clientId, clientSecret);
    console.log("Saved the SEO Google OAuth client (secret encrypted).");
    if (clientChanged) console.log("The client ID changed, so the old Google connection was dropped: reconnect in Admin → SEO → Intelligence.");
  } else if (mode === "clear") {
    const d = await disconnect();
    await clearAll();
    console.log(`SEO Google OAuth client and connection removed${d.wasConnected ? ` (revoke at Google: ${d.revoked ? "confirmed" : "not confirmed"})` : ""}.`);
  } else if (mode !== "status") {
    throw new Error("Usage: set | status | clear");
  }
  const v = await getConnectionView();
  console.log(
    `Status: client ${v.credentialsConfigured ? `installed (${v.clientIdHint})` : "not installed"} · Google ${v.connected ? `connected as ${v.accountEmail}${v.needsReconnect ? " (NEEDS RECONNECT)" : ""}` : "not connected"} · GA4 ${v.ga4PropertyId} · redirect URI ${v.redirectUri}`
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
