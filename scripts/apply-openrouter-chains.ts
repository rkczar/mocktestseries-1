/**
 * OpenRouter-only activation (owner policy 2026-11-26): cost-first model chains for every text AI feature.
 * DRY RUN by default (prints the planned change, writes nothing). `--apply` writes ai.engine features + runtime and
 * approves the chain models. Refuses when a chain model is missing from the catalog (AI → Models → refresh first).
 * Rollback: restore the features/runtime saved in /root/mts-evidence/openrouter-p0-20261126/ai.engine.current.json.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/apply-openrouter-chains.ts [--apply]
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";

const APPLY = process.argv.includes("--apply");
// Cost-first (2026-11-26 benchmarks, synthetic MCQs, data_collection=deny): cheapest reliable first, pricier last.
const CHAIN = ["qwen/qwen3.5-flash-02-23", "openai/gpt-5.4-nano", "google/gemini-3.1-flash-lite"];
const STUDENT = { explanation: 6000, explanation_admin: 6000, variant: 8000, variant_admin: 8000 } as const;
const CONTENT = ["ig_caption", "ig_carousel", "ig_trap", "ig_diagram", "ig_trends", "ig_hashtags", "ig_keywords", "ig_competitors"] as const;

async function main() {
  const cfg = await import("@/lib/ai-engine/config");
  const settings = await import("@/lib/ai-engine/settings");
  const found = await prisma.aiModel.findMany({ where: { id: { in: CHAIN } }, select: { id: true, approved: true, medicallyApproved: true } });
  const missing = CHAIN.filter((id) => !found.some((m) => m.id === id));
  if (missing.length) {
    console.error(`REFUSED: not in the model catalog: ${missing.join(", ")} (AI → Models → refresh catalog first). Nothing written.`);
    process.exit(2);
  }
  const engine = await settings.getEngineConfig();
  const plan: [string, Record<string, unknown>][] = [
    ...Object.entries(STUDENT).map(([f, timeoutMs]) => [f, { mode: "manual", model: CHAIN[0], fallbacks: CHAIN.slice(1), maxRetries: 0, timeoutMs }] as [string, Record<string, unknown>]),
    ...CONTENT.map((f) => [f, { mode: "manual", model: CHAIN[0], fallbacks: CHAIN.slice(1), maxRetries: 0, timeoutMs: 15000 }] as [string, Record<string, unknown>]),
  ];
  for (const [f, p] of plan) {
    const cur = engine.features[f as keyof typeof engine.features];
    console.log(`${f}: ${cur.provider}/${cur.mode}/${cur.model ?? "-"} [${cur.fallbacks.join(",")}] t=${cur.timeoutMs} r=${cur.maxRetries}  →  openrouter/manual/${p.model} [${(p.fallbacks as string[]).join(",")}] t=${p.timeoutMs} r=0`);
  }
  const toApprove = found.filter((m) => !m.approved || !m.medicallyApproved).map((m) => m.id);
  console.log(`models to approve + medically approve: ${toApprove.join(", ") || "none"}`);
  console.log(`runtime: geminiFallback ${engine.runtime.geminiFallback} → false, directClaudeOpenAi → false (code no longer uses either)`);
  if (!APPLY) return console.log("DRY RUN — nothing written. Re-run with --apply after owner approval.");
  await prisma.aiModel.updateMany({ where: { id: { in: toApprove } }, data: { approved: true, medicallyApproved: true } });
  for (const [f, p] of plan) {
    const cur = engine.features[f as keyof typeof engine.features];
    await settings.saveFeatureConfig(f as Parameters<typeof settings.saveFeatureConfig>[0], cfg.normalizeFeatureConfig({ ...cur, provider: "openrouter", ...p }));
  }
  await settings.saveRuntime({ ...engine.runtime, geminiFallback: false, directClaudeOpenAi: false });
  console.log("APPLIED.");
}
main().then(() => prisma.$disconnect(), async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
