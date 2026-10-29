/**
 * AI Gateway + Admin-managed Claude provider — library regression against a
 * LOCAL mock of api.anthropic.com (scripts/mock-anthropic.mjs). Never talks to
 * Anthropic; keys are fake. Runs only on an *igstudio* scratch database.
 *
 *   set -a; . ./.env; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-gateway.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { startMockAnthropic, mockKey } from "./mock-anthropic.mjs";

const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
if (!dbName.includes("igstudio")) {
  console.error(`Refusing to run: database "${dbName}" is not an igstudio scratch database.`);
  process.exit(2);
}
const PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 3189);
process.env.ANTHROPIC_TEST_BASE_URL = `http://127.0.0.1:${PORT}`;

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
const logged: string[] = [];
for (const m of ["log", "error", "warn", "info", "debug"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    orig(...args);
  };
}
const thrown = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
};

async function resetSettings() {
  await prisma.setting.deleteMany({ where: { key: { in: ["api.anthropic", "ai.gateway"] } } });
  // These checks cover the direct Claude / OpenAI routes (rollback path): since 2026-10-29 they are off at runtime by default.
  await (await import("@/lib/ai-engine/settings")).saveRuntime({ geminiFallback: true, directClaudeOpenAi: true });
  await prisma.aiGatewayCall.deleteMany({});
}

async function main() {
  // Outbound guard: only the loopback mock may be called.
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    outbound.push(url);
    if (!url.startsWith(`http://127.0.0.1:${PORT}`) && !url.startsWith("http://127.0.0.1:19/")) throw new Error(`Blocked outbound fetch: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;

  const { server, stats } = await startMockAnthropic(PORT);
  const cfg = await import("@/lib/anthropic-config");
  const gw = await import("@/lib/ai-gateway");
  const { AiNotConfiguredError } = await import("@/lib/ai-provider");
  const { saveAiSettings } = await import("@/lib/ai-settings");
  await resetSettings();
  await saveAiSettings({ askAiEnabled: true });
  const keys: string[] = [];
  const key = (s: string) => {
    const k = mockKey(s);
    keys.push(k);
    return k;
  };

  console.log("Claude credentials");
  await check("fresh install: NOT_CONFIGURED, disabled, no key hint", async () => {
    const c = await cfg.getClaudeConfig();
    assert.equal(c.status, "NOT_CONFIGURED");
    assert.equal(c.enabled, false);
    assert.equal(c.keyHint, null);
    assert.equal(c.modelsSource, "curated");
    assert.ok(c.models.some((m) => m.id === "claude-opus-5-5"));
    assert.equal(await cfg.resolveClaude(), null);
  });
  await check("key format is validated (prefix, admin key, spaces, length)", async () => {
    for (const bad of ["", "abc", "sk-proj-123456789012345678901234567890", "sk-ant-admin01-xxxxxxxxxxxxxxxxxxxxxxxxxxxx", "sk-ant-abc def-xxxxxxxxxxxxxxxxxxxxxxxxx", "sk-ant-short"]) {
      const e = await thrown(() => cfg.saveClaudeKey(bad));
      assert.ok(e instanceof cfg.ClaudeConfigError, `should reject ${bad.slice(0, 14)}`);
    }
  });
  await check("enabling without a key is refused", async () => {
    const e = await thrown(() => cfg.saveClaudeSettings({ enabled: true }));
    assert.ok(e instanceof cfg.ClaudeConfigError);
  });
  const k1 = key("valid");
  await check("save: stored AES-GCM encrypted, never plaintext; masked hint only", async () => {
    const r = await cfg.saveClaudeKey(`  ${k1}  `);
    assert.equal(r.keyHint, `sk-ant-••••${k1.slice(-4)}`);
    const row = await prisma.setting.findUnique({ where: { key: "api.anthropic" } });
    const raw = JSON.stringify(row?.value);
    assert.ok(!raw.includes(k1), "plaintext key must not be in the DB");
    assert.ok(!raw.includes(k1.slice(7, 30)), "no key fragment in the DB");
    assert.match(String((row?.value as { apiKeyCipher?: string }).apiKeyCipher), /^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    const pub = await cfg.getClaudeConfig();
    assert.ok(!JSON.stringify(pub).includes(k1.slice(7, 30)), "public config must not contain the key");
    assert.equal(pub.status, "DISABLED");
    assert.equal(await cfg.getClaudeApiKey(), k1);
  });
  await check("ciphertext decrypts only with the server secret (AUTH_SECRET outside the DB)", async () => {
    const row = await prisma.setting.findUnique({ where: { key: "api.anthropic" } });
    const blob = (row?.value as { apiKeyCipher: string }).apiKeyCipher;
    const saved = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "a-different-secret-value-for-this-check-only";
    const { decryptSecret } = await import("@/lib/secret-cipher");
    assert.equal(decryptSecret(blob), null);
    process.env.AUTH_SECRET = saved;
    assert.equal(decryptSecret(blob), k1);
  });

  console.log("Connection test");
  await check("valid key: models listed (live list stored), tiny generation passes → CONNECTED after enable", async () => {
    const r = await cfg.testClaudeConnection();
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.checks, { key: "pass", model: "pass", generation: "pass" });
    const c = await cfg.getClaudeConfig();
    assert.equal(c.modelsSource, "live");
    assert.deepEqual(c.models.map((m) => m.id).sort(), ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    assert.ok(c.lastSuccessAt);
    await cfg.saveClaudeSettings({ enabled: true });
    assert.equal((await cfg.getClaudeConfig()).status, "CONNECTED");
  });
  await check("cooldown: a second test within 10 s is refused (all workers — stored in DB)", async () => {
    const e = await thrown(() => cfg.testClaudeConnection());
    assert.ok(e instanceof cfg.ClaudeConfigError && /wait/.test(e.message));
  });
  const clearCooldown = () => prisma.$executeRawUnsafe(`UPDATE "Setting" SET value = value - 'lastTest' WHERE key = 'api.anthropic'`);
  await check("model not available to the key → model_unavailable (key valid)", async () => {
    await clearCooldown();
    await prisma.$executeRawUnsafe(`UPDATE "Setting" SET value = jsonb_set(value, '{model}', '"claude-fable-9-9"') WHERE key = 'api.anthropic'`);
    const r = await cfg.testClaudeConnection();
    assert.equal(r.ok, false);
    assert.equal(r.category, "model_unavailable");
    assert.equal(r.checks.key, "pass");
    await prisma.$executeRawUnsafe(`UPDATE "Setting" SET value = jsonb_set(value, '{model}', '"claude-opus-5-5"') WHERE key = 'api.anthropic'`);
  });
  await check("saving a model that is not in the live list is refused", async () => {
    const e = await thrown(() => cfg.saveClaudeSettings({ model: "claude-ghost-1" }));
    assert.ok(e instanceof cfg.ClaudeConfigError);
    const ok = await cfg.saveClaudeSettings({ model: "claude-sonnet-5-5", effort: "medium" });
    assert.equal(ok.model, "claude-sonnet-5-5");
    assert.equal(ok.effort, "medium");
    await cfg.saveClaudeSettings({ model: "claude-opus-5-5", effort: "low" });
  });
  for (const [scenario, category, keyCheck] of [
    ["bad", "auth_invalid", "fail"],
    ["perm", "permission", "skip"],
    ["billing", "billing", "pass"],
    ["overload", "overloaded", "pass"],
    ["ratelimit", "rate_limited", "pass"],
  ] as const) {
    await check(`test distinguishes ${scenario} → ${category}`, async () => {
      await clearCooldown();
      await cfg.saveClaudeKey(key(scenario));
      const r = await cfg.testClaudeConnection();
      assert.equal(r.ok, false);
      assert.equal(r.category, category, r.message);
      assert.equal(r.checks.key, keyCheck);
      assert.ok(!r.message.includes("sk-ant-mock"), "no key in messages");
    });
  }
  await check("network failure → network category (bounded, no hang)", async () => {
    await clearCooldown();
    await cfg.saveClaudeKey(key("valid"));
    const saved = process.env.ANTHROPIC_TEST_BASE_URL;
    process.env.ANTHROPIC_TEST_BASE_URL = "http://127.0.0.1:19"; // closed loopback port (still inside the outbound guard)
    const r = await cfg.testClaudeConnection();
    process.env.ANTHROPIC_TEST_BASE_URL = saved;
    assert.equal(r.ok, false);
    assert.equal(r.category, "network", r.message);
  });
  await check("non-loopback ANTHROPIC_TEST_BASE_URL is ignored (production always uses api.anthropic.com)", async () => {
    const { anthropicBaseUrl } = await import("@/lib/anthropic-client");
    const saved = process.env.ANTHROPIC_TEST_BASE_URL;
    for (const v of ["https://evil.example", "http://10.0.0.1:80", "http://127.0.0.1"]) {
      process.env.ANTHROPIC_TEST_BASE_URL = v;
      assert.equal(anthropicBaseUrl(), undefined);
    }
    process.env.ANTHROPIC_TEST_BASE_URL = saved;
    assert.equal(anthropicBaseUrl(), saved);
  });

  console.log("Gateway routing");
  const kA = key("valid");
  await cfg.saveClaudeKey(kA);
  await cfg.saveClaudeSettings({ enabled: true });
  await check("default 'inherit' route = unchanged legacy path (no Gemini/OpenAI here → AiNotConfiguredError)", async () => {
    const e = await thrown(() => gw.generateForFeature("explanation", "x", { temperature: 0, maxOutputTokens: 10 }));
    assert.ok(e instanceof AiNotConfiguredError, String(e));
    assert.equal(await gw.isFeatureConfigured("explanation"), false);
    assert.equal(stats.prompts.filter((p: string) => p === "x").length, 0, "Claude must not be called on an inherit route");
  });
  await check("route a feature to Claude: works at once, logs provider/model/tokens/estimated cost", async () => {
    await gw.saveGatewayConfig({ routes: { ig_carousel: { mode: "custom", primary: "anthropic", fallback1: "gemini", fallback2: "none", timeoutMs: 20000, maxRetries: 0, dailyCap: null } } });
    assert.equal(await gw.isFeatureConfigured("ig_carousel"), true);
    const r = await gw.generateForFeature("ig_carousel", "Reply with the single word OK.", { temperature: 0.5, maxOutputTokens: 50 }, { actorId: null });
    assert.equal(r.provider, "anthropic");
    assert.equal(r.text, "OK");
    assert.equal(r.model, "claude-opus-5-5");
    const log = await prisma.aiGatewayCall.findFirst({ where: { feature: "ig_carousel" }, orderBy: { createdAt: "desc" } });
    assert.ok(log && log.ok && log.provider === "anthropic" && log.inputTokens! > 0 && log.outputTokens === 250);
    assert.ok(log!.estCostUsd !== null && log!.estCostUsd > 0, "cost estimated from the price table");
  });
  await check("per-feature model override is used", async () => {
    await gw.saveGatewayConfig({ routes: { ig_caption: { mode: "custom", primary: "anthropic", models: { anthropic: "claude-haiku-5-5" }, timeoutMs: 20000, maxRetries: 0 } } });
    const r = await gw.generateForFeature("ig_caption", "Reply with the single word OK.", { temperature: 0.5, maxOutputTokens: 50 });
    assert.equal(r.model, "claude-haiku-5-5");
  });
  await check("replace the key in the Admin Panel → the very next call uses the new key (no restart)", async () => {
    const kB = key("valid");
    await cfg.saveClaudeKey(kB);
    await cfg.saveClaudeSettings({ enabled: true });
    const before = stats.keys.length;
    await gw.generateForFeature("ig_carousel", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 });
    assert.equal(stats.keys[before], kB.slice(-6));
  });
  await check("Claude disabled → requests are not routed to it; key stays stored", async () => {
    await cfg.saveClaudeSettings({ enabled: false });
    const before = stats.messages;
    const e = await thrown(() => gw.generateForFeature("ig_carousel", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 }));
    assert.ok(e instanceof AiNotConfiguredError, String(e));
    assert.equal(stats.messages, before);
    assert.ok(await cfg.getClaudeApiKey());
    assert.equal((await cfg.getClaudeConfig()).status, "DISABLED");
    await cfg.saveClaudeSettings({ enabled: true });
  });
  await check("non-transient Claude error (billing) → sanitized AiProviderFailure, last error recorded", async () => {
    await cfg.saveClaudeKey(key("billing"));
    await cfg.saveClaudeSettings({ enabled: true });
    const e = await thrown(() => gw.generateForFeature("ig_carousel", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 }));
    assert.ok(e instanceof gw.AiProviderFailure, String(e));
    assert.match(e!.message, /no available credit|billing/i);
    assert.ok(!e!.message.includes("sk-ant"));
    const c = await cfg.getClaudeConfig();
    assert.equal(c.lastError?.category, "billing");
  });
  await check("transient error (overloaded) is retried up to maxRetries, then fails", async () => {
    await cfg.saveClaudeKey(key("overload"));
    await cfg.saveClaudeSettings({ enabled: true });
    await gw.saveGatewayConfig({ routes: { ig_trap: { mode: "custom", primary: "anthropic", timeoutMs: 20000, maxRetries: 2 } } });
    const before = stats.messages;
    const e = await thrown(() => gw.generateForFeature("ig_trap", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 }));
    assert.ok(e instanceof gw.AiProviderFailure);
    assert.equal(stats.messages - before, 3);
    assert.equal(await prisma.aiGatewayCall.count({ where: { feature: "ig_trap", ok: false } }), 3);
  });
  await check("timeout is bounded by the route's timeout", async () => {
    await cfg.saveClaudeKey(key("slow"));
    await cfg.saveClaudeSettings({ enabled: true });
    await gw.saveGatewayConfig({ routes: { ig_keywords: { mode: "custom", primary: "anthropic", timeoutMs: 5000, maxRetries: 0 } } });
    // 5 s is the minimum route timeout; the mock answers after 3 s → success.
    const t = Date.now();
    const r = await gw.generateForFeature("ig_keywords", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 });
    assert.equal(r.text, "OK");
    assert.ok(Date.now() - t < 5000);
    const { callClaude, ClaudeError } = await import("@/lib/anthropic-client");
    const e = await thrown(() => callClaude({ apiKey: key("slow"), model: "claude-opus-5-5", prompt: "x", maxOutputTokens: 10, timeoutMs: 800, effort: "low" }));
    assert.ok(e instanceof ClaudeError && e.category === "timeout", String(e));
  });
  await check("refusal stop_reason → 'refused' (not treated as text)", async () => {
    const { callClaude, ClaudeError } = await import("@/lib/anthropic-client");
    const e = await thrown(() => callClaude({ apiKey: key("refuse"), model: "claude-opus-5-5", prompt: "x", maxOutputTokens: 10, timeoutMs: 5000, effort: "low" }));
    assert.ok(e instanceof ClaudeError && e.category === "refused");
  });
  await check("daily cap: refuses once the IST-day successful calls reach the cap", async () => {
    await cfg.saveClaudeKey(key("valid"));
    await cfg.saveClaudeSettings({ enabled: true });
    await gw.saveGatewayConfig({ routes: { ig_hashtags: { mode: "custom", primary: "anthropic", timeoutMs: 20000, maxRetries: 0, dailyCap: 2 } } });
    for (let i = 0; i < 2; i++) await gw.generateForFeature("ig_hashtags", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 });
    const e = await thrown(() => gw.generateForFeature("ig_hashtags", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 }));
    assert.ok(e instanceof AiNotConfiguredError && /daily AI limit/.test(e.message));
  });
  await check("per-request provider override: Claude chosen even on an inherit route; an unconfigured provider is refused", async () => {
    const r = await gw.generateForFeature("ig_trends", "Reply with the single word OK.", { temperature: 0, maxOutputTokens: 20 }, { providerOverride: "anthropic" });
    assert.equal(r.provider, "anthropic");
    const e = await thrown(() => gw.generateForFeature("ig_trends", "x", { temperature: 0, maxOutputTokens: 20 }, { providerOverride: "openai" }));
    assert.ok(e instanceof AiNotConfiguredError && /OpenAI/.test(e.message));
  });
  await check("student features on a custom route still honour 'Ask AI disabled'", async () => {
    await gw.saveGatewayConfig({ routes: { explanation: { mode: "custom", primary: "anthropic", timeoutMs: 20000, maxRetries: 0 } } });
    assert.equal(await gw.isFeatureConfigured("explanation"), true);
    await saveAiSettings({ askAiEnabled: false });
    assert.equal(await gw.isFeatureConfigured("explanation"), false);
    const e = await thrown(() => gw.generateForFeature("explanation", "x", { temperature: 0, maxOutputTokens: 20 }));
    assert.ok(e instanceof AiNotConfiguredError);
    await saveAiSettings({ askAiEnabled: true });
    await gw.saveGatewayConfig({ routes: { explanation: { mode: "inherit" } } });
  });
  await check("Platform Controls AI pause stops gateway calls too", async () => {
    const { savePlatformControlsForTest } = await import("./platform-controls-test-helper");
    await savePlatformControlsForTest(false);
    const e = await thrown(() => gw.generateForFeature("ig_trends", "x", { temperature: 0, maxOutputTokens: 20 }, { providerOverride: "anthropic" }));
    await savePlatformControlsForTest(true);
    assert.ok(e instanceof AiNotConfiguredError, String(e));
  });
  await check("route normalization: fallbacks never repeat the primary; limits clamped", async () => {
    const { normalizeRoute } = await import("@/lib/ai-gateway-config");
    const r = normalizeRoute({ mode: "custom", primary: "anthropic", fallback1: "anthropic", fallback2: "gemini", timeoutMs: 999999, maxRetries: 9, dailyCap: -3, models: { anthropic: "bad model!" } });
    assert.equal(r.fallback1, "gemini");
    assert.equal(r.fallback2, "none");
    assert.equal(r.timeoutMs, 180000);
    assert.equal(r.maxRetries, 3);
    assert.equal(r.dailyCap, 1);
    assert.deepEqual(r.models, {});
  });
  await check("concurrent writes never lose the key (atomic JSON patch)", async () => {
    const k = key("valid");
    await Promise.all([cfg.saveClaudeKey(k), ...Array.from({ length: 10 }, (_, i) => cfg.recordClaudeOutcome(i % 2 ? { ok: true } : { ok: false, category: "x", message: "y" }))]);
    assert.equal(await cfg.getClaudeApiKey(), k);
  });
  await check("remove key: NOT_CONFIGURED, disabled, cipher deleted; routed features fall back / refuse", async () => {
    await cfg.removeClaudeKey();
    const row = await prisma.setting.findUnique({ where: { key: "api.anthropic" } });
    assert.ok(!("apiKeyCipher" in (row?.value as object)));
    const c = await cfg.getClaudeConfig();
    assert.equal(c.status, "NOT_CONFIGURED");
    assert.equal(c.enabled, false);
    const e = await thrown(() => gw.generateForFeature("ig_carousel", "x", { temperature: 0, maxOutputTokens: 20 }));
    assert.ok(e instanceof AiNotConfiguredError);
  });

  console.log("Secrets never leak");
  await check("no key in AiGatewayCall, AuditLog, Settings (other than cipher), or console output", async () => {
    const calls = JSON.stringify(await prisma.aiGatewayCall.findMany());
    const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { action: { startsWith: "API_ANTHROPIC" } } }));
    const settings = JSON.stringify(await prisma.setting.findMany());
    for (const k of keys) {
      const frag = k.slice(7, 40);
      assert.ok(!calls.includes(frag), "gateway log");
      assert.ok(!audits.includes(frag), "audit log");
      assert.ok(!settings.includes(frag), "settings");
      assert.ok(!logged.some((l) => l.includes(frag)), "console");
    }
  });
  await check("only the loopback mock was ever called", () => {
    assert.ok(outbound.length > 0);
    assert.ok(outbound.every((u) => u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith("http://127.0.0.1:19/")), outbound.filter((u) => !u.startsWith("http://127.0.0.1")).join(", "));
  });

  await resetSettings();
  server.close();
  globalThis.fetch = realFetch;
  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
