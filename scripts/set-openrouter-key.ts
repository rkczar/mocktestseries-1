/**
 * Called by ops/ai/set-openrouter-key.sh — never run with the key as an argument.
 *   key     reads the key from stdin, stores it encrypted (AUTH_SECRET) in Setting api.openrouter (disabled, untested)
 *   status  prints whether a key is installed (hint only) and the provider state
 *   clear   removes the key and disables OpenRouter
 * Needs NODE_OPTIONS=--conditions=react-server and the shared .env (DATABASE_URL, AUTH_SECRET).
 */
import { getOpenRouterConfig, removeOpenRouterKey, saveOpenRouterKey } from "@/lib/ai-engine/settings";
import { prisma } from "@/lib/prisma";

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function main() {
  const mode = process.argv[2] ?? "status";
  if (mode === "key") {
    const key = await readStdin();
    const { keyHint } = await saveOpenRouterKey(key, "script");
    console.log(`Saved (encrypted). Key ${keyHint}. OpenRouter stays DISABLED until Admin → AI → Providers → Test Connection → Enable.`);
  } else if (mode === "clear") {
    await removeOpenRouterKey();
    console.log("OpenRouter key removed; OpenRouter disabled.");
  }
  const c = await getOpenRouterConfig();
  console.log(`Status: ${c.status} · key ${c.keyHint ?? "not installed"} · enabled ${c.enabled}${c.lastTest ? ` · last test ${c.lastTest.ok ? "OK" : "failed"} ${c.lastTest.at}` : ""}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "failed");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
