/**
 * Student AI cost guards against the LOCAL mock OpenRouter (igstudio scratch DB only):
 * the per-question explanation cache, in-flight dedupe, the failed-retry cooldown (variants are cached by lib/ai-variant.ts#ensureQuestionVariants).
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-cache.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { startMockOpenRouter, mockKey } from "./mock-openrouter.mjs";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 3195);
process.env.OPENROUTER_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.FX_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;
let passes = 0;
let failures = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passes++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        → ${String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n          ")}`);
  }
}
const ENGINE_KEYS = ["api.openrouter", "ai.engine", "ai.fx", "ai.eval", "ai.gateway", "ai.settings", "api.gemini", "api.openai", "api.anthropic"];

async function main() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`blocked non-loopback fetch: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
  const mock = await startMockOpenRouter(PORT);
  await prisma.setting.deleteMany({ where: { key: { in: ENGINE_KEYS } } });
  await prisma.aiGatewayCall.deleteMany({});
  await prisma.aiBudgetReservation.deleteMany({});
  await prisma.aiModel.deleteMany({});

  const cfg = await import("@/lib/ai-engine/config");
  const settings = await import("@/lib/ai-engine/settings");
  const catalog = await import("@/lib/ai-engine/catalog");
  const fx = await import("@/lib/ai-engine/fx");
  const expl = await import("@/lib/ai-explanation");
  await settings.saveOpenRouterKey(mockKey("valid"), "admin");
  await (await import("@/lib/ai-engine/manage")).testOpenRouterConnection();
  await settings.setOpenRouterEnabled(true);
  await catalog.syncCatalog();
  await fx.refreshFxRate();
  await prisma.aiModel.updateMany({ where: { id: { in: ["mockai/cheap", "mockai/fail500"] } }, data: { approved: true, medicallyApproved: true } });
  const setFeature = (f: "explanation" | "variant", model: string) =>
    settings.saveFeatureConfig(f, cfg.normalizeFeatureConfig({ ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "manual", model, fallbacks: [], maxRetries: 0 }));

  const qs = await prisma.question.findMany({ where: { status: "PUBLISHED", aiSlot: null }, take: 4, orderBy: { id: "asc" } });
  assert.ok(qs.length >= 4, "fixture questions");
  await prisma.aIExplanation.deleteMany({ where: { questionId: { in: qs.map((q) => q.id) } } });
  const calls = () => prisma.aiGatewayCall.count();

  console.log("\nStudent AI cost guards");
  await setFeature("explanation", "mockai/cheap");
  await check("explanation: first request pays once (actual cost recorded), the repeat is a cache hit with 0 new calls", async () => {
    const a = await expl.getOrCreateExplanation(qs[0].id);
    assert.equal(a.status, "COMPLETED");
    const n = await calls();
    assert.equal(n, 1);
    const row = await prisma.aiGatewayCall.findFirstOrThrow();
    assert.ok(row.ok && row.costStatus === "actual" && row.actualCostUsd! > 0 && row.actualCostInr! > 0);
    const b = await expl.getOrCreateExplanation(qs[0].id);
    assert.equal(b.id, a.id);
    assert.equal(await calls(), n, "cache hit must not call OpenRouter");
  });
  await check("explanation: 5 concurrent identical requests → exactly 1 OpenRouter call", async () => {
    const before = await calls();
    const r = await Promise.allSettled(Array.from({ length: 5 }, () => expl.getOrCreateExplanation(qs[1].id)));
    assert.ok(r.some((x) => x.status === "fulfilled"));
    assert.equal(await calls(), before + 1);
    assert.equal(await prisma.aIExplanation.count({ where: { questionId: qs[1].id } }), 1);
  });
  await check("explanation: after a failure, an immediate retry makes 0 calls (cooldown) with a friendly message", async () => {
    await setFeature("explanation", "mockai/fail500");
    await assert.rejects(() => expl.getOrCreateExplanation(qs[2].id));
    const before = await calls();
    await assert.rejects(() => expl.getOrCreateExplanation(qs[2].id), /try again in a minute/);
    assert.equal(await calls(), before);
    await prisma.aIExplanation.update({ where: { questionId: qs[2].id }, data: { updatedAt: new Date(Date.now() - 2 * 60_000) } });
    await setFeature("explanation", "mockai/cheap");
    assert.equal((await expl.getOrCreateExplanation(qs[2].id)).status, "COMPLETED", "retried after the cooldown");
  });
  // Variants: ensureQuestionVariants already returns stored variants before any provider call (existing.length >= target).
  await check("every call went through OpenRouter; no reservation left open", async () => {
    assert.equal(await prisma.aiGatewayCall.count({ where: { provider: { not: "openrouter" } } }), 0);
    assert.equal(await prisma.aiBudgetReservation.count({ where: { status: "RESERVED" } }), 0);
  });

  await prisma.setting.deleteMany({ where: { key: { in: ENGINE_KEYS } } });
  await prisma.aiGatewayCall.deleteMany({});
  await prisma.aiBudgetReservation.deleteMany({});
  await mock.close?.();
  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
