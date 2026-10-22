/**
 * Called by ops/seo/set-pagespeed-key.sh — never run with the key as an argument.
 *   set     reads the key from stdin, stores it encrypted (AUTH_SECRET) in Setting seo.pagespeed.key
 *   status  prints whether a key is installed (8-char fingerprint only) and the last check
 *   clear   removes the key (PageSpeed checks stop; stored results stay)
 * Needs NODE_OPTIONS=--conditions=react-server and the shared .env (DATABASE_URL, AUTH_SECRET).
 */
import { clearApiKey, getKeyView, getPageSpeedState, setApiKey } from "@/lib/seo-intel/pagespeed";
import { prisma } from "@/lib/prisma";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function main() {
  const mode = process.argv[2] ?? "status";
  if (mode === "set") {
    const { fingerprint } = await setApiKey(await readStdin());
    await prisma.auditLog.create({ data: { actorId: null, action: "SEO_PAGESPEED_KEY_SET", entityType: "Setting", entityId: "seo.pagespeed.key", metadata: { fingerprint, via: "ops script" } } });
    console.log(`Saved the PageSpeed API key (encrypted). Fingerprint ${fingerprint}.`);
  } else if (mode === "clear") {
    await clearApiKey();
    await prisma.auditLog.create({ data: { actorId: null, action: "SEO_PAGESPEED_KEY_CLEARED", entityType: "Setting", entityId: "seo.pagespeed.key", metadata: { via: "ops script" } } });
    console.log("PageSpeed API key removed.");
  } else if (mode !== "status") {
    throw new Error("Usage: set | status | clear");
  }
  const v = await getKeyView();
  const s = await getPageSpeedState();
  console.log(
    `Status: key ${v.installed ? `installed (fingerprint ${v.fingerprint}, ${v.setAt})` : "not installed"} · last check ${s.lastRun ? `${s.lastRun.at} ${s.lastRun.ok ? "OK" : `${s.lastRun.errors} error(s)`}` : "never"}`
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
