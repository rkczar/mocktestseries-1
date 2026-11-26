/**
 * OpenRouter-only P0 — explanation / variant failure scenarios against the LOCAL mock OpenRouter.
 * Never talks to OpenRouter or Gemini (every outbound fetch must be loopback). igstudio scratch DB only.
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-openrouter-p0.ts
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
const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 3194);
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
const thrown = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
};
const ENGINE_KEYS = ["api.openrouter", "ai.engine", "ai.fx", "ai.eval", "ai.gateway", "ai.settings", "api.gemini", "api.openai", "api.anthropic"];
const JSON_OPTS = { temperature: 0.2, maxOutputTokens: 1200, json: true };

async function main() {
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push(url);
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
  const gateway = await import("@/lib/ai-gateway");
  await settings.saveOpenRouterKey(mockKey("valid"), "admin");
  await (await import("@/lib/ai-engine/manage")).testOpenRouterConnection();
  await settings.setOpenRouterEnabled(true);
  await catalog.syncCatalog();
  await fx.refreshFxRate();
  const MODELS = ["mockai/cheap", "mockai/mid", "mockai/cutoff", "mockai/prose", "mockai/slow", "mockai/fail429", "mockai/retry429", "mockai/thinker", "mockai/fail500", "mockai/empty"];
  await prisma.aiModel.updateMany({ where: { id: { in: MODELS } }, data: { approved: true, medicallyApproved: true } });
  const setFeature = (f: "explanation" | "variant", p: Partial<ReturnType<typeof cfg.normalizeFeatureConfig>>) =>
    settings.saveFeatureConfig(f, cfg.normalizeFeatureConfig({ ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", ...p }));
  const rowsOf = (requestId: string) => prisma.aiGatewayCall.findMany({ where: { requestId }, orderBy: { attempt: "asc" } });
  const lastReq = async () => (await prisma.aiGatewayCall.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).requestId;

  {
    const engine = await import("@/lib/ai-engine/engine");
    await setFeature("explanation", { mode: "manual", model: "mockai/cheap", fallbacks: [], maxRetries: 1 });
    const e = await thrown(() => engine.generateTextViaOpenRouter("explanation", "Explain the answer as JSON.", JSON_OPTS, {}));
    console.log(`  diag: direct engine call → ${e ? `${e.constructor.name}: ${e.message}` : "ok"}`);
  }
  console.log("\nP0. explanation / variant through the gateway (geminiFallback default ON, no Gemini key configured)");
  for (const feature of ["explanation", "variant"] as const) {
    await check(`${feature}: truncated answer (finish_reason length) → next model answers, cost tracked`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/cutoff", fallbacks: ["mockai/cheap"], maxRetries: 1 });
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      assert.equal(r.model, "mockai/cheap");
      const rows = await rowsOf((await lastReq())!);
      assert.equal(rows[0].errorCategory, "truncated");
      assert.ok(rows.at(-1)!.ok && rows.at(-1)!.actualCostUsd! > 0 && rows.at(-1)!.costStatus === "actual");
    });
    await check(`${feature}: invalid JSON (prose) → next model answers`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/prose", fallbacks: ["mockai/cheap"], maxRetries: 1 });
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      assert.equal(r.model, "mockai/cheap");
      const rows = await rowsOf((await lastReq())!);
      assert.ok(["invalid_json", "non_answer", "schema_invalid"].includes(rows[0].errorCategory ?? ""), String(rows[0].errorCategory));
    });
    await check(`${feature}: reasoning-only empty answer → truncated → next model`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/thinker", fallbacks: ["mockai/cheap"], maxRetries: 1 });
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      assert.equal(r.model, "mockai/cheap");
    });
    await check(`${feature}: rate_limited (429 + Retry-After) → one controlled retry succeeds`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/retry429", fallbacks: [], maxRetries: 1 });
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      assert.equal(r.model, "mockai/retry429");
      const rows = await rowsOf((await lastReq())!);
      assert.equal(rows[0].errorCategory, "rate_limited");
      assert.equal(rows.length, 2);
    });
    await check(`${feature}: permanent 429 on primary → OpenRouter-side fallback model answers (flagged)`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/fail429", fallbacks: ["mockai/cheap"], maxRetries: 0 });
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      assert.equal(r.model, "mockai/cheap");
      const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { ok: true }, orderBy: { createdAt: "desc" } });
      assert.equal(row.fallbackUsed, true);
    });
    await check(`${feature}: timeout on a slow primary → next model answers inside the deadline (P1)`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/slow", fallbacks: ["mockai/cheap"], maxRetries: 1, timeoutMs: 5000 });
      const t0 = Date.now();
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      const rows = await rowsOf((await lastReq())!);
      assert.equal(r.model, "mockai/cheap");
      assert.equal(rows[0].errorCategory, "timeout");
      assert.equal(rows[0].costStatus, "unknown", "a timed-out attempt may still bill: worst case kept");
      assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
    });
    await check(`${feature}: 5xx on primary → next model answers`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/fail500", fallbacks: ["mockai/cheap"], maxRetries: 1 });
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      assert.equal(r.model, "mockai/cheap");
    });
    await check(`${feature}: empty response → next model answers`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/empty", fallbacks: ["mockai/cheap"], maxRetries: 1 });
      const r = await gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS);
      assert.equal(r.model, "mockai/cheap");
    });
    await check(`${feature}: every model fails → friendly error fast, no direct provider`, async () => {
      await setFeature(feature, { mode: "manual", model: "mockai/fail500", fallbacks: ["mockai/fail429"], maxRetries: 0 });
      const t0 = Date.now();
      const e = await thrown(() => gateway.generateForFeature(feature, "Explain the answer as JSON.", JSON_OPTS));
      assert.ok(e && /could not answer right now|temporarily unavailable/.test(e.message), String(e?.message));
      assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0} ms`);
    });
  }
  await check("no request ever went to a direct provider (only loopback mock), no gemini rows", async () => {
    assert.ok(outbound.every((u) => u.startsWith("http://127.0.0.1:")));
    assert.equal(await prisma.aiGatewayCall.count({ where: { provider: { not: "openrouter" } } }), 0);
  });
  await check("budget reservations are all settled or released (none left RESERVED)", async () => {
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
