/**
 * AI Engine (OpenRouter) — library regression against a LOCAL mock of the
 * OpenRouter API and the USD→INR rate service (scripts/mock-openrouter.mjs).
 * Never talks to OpenRouter; keys are fake; no paid request is possible
 * (every outbound fetch is asserted to be loopback). Runs only on an
 * *igstudio* scratch database (seed + scripts/ig-studio-fixture.ts setup first).
 *
 *   set -a; . ./.env; set +a
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-engine.ts
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
const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 3193);
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
    console.log(`  FAIL  ${name}\n        → ${String((e as Error)?.stack ?? e).split("\n").slice(0, 5).join("\n          ")}`);
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
const logged: string[] = [];
for (const m of ["log", "error", "warn", "info", "debug"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    orig(...args);
  };
}

const ENGINE_KEYS = ["api.openrouter", "ai.engine", "ai.fx", "ai.eval", "ai.gateway", "ai.settings", "api.gemini", "api.openai", "api.anthropic"];
async function resetAll() {
  await prisma.setting.deleteMany({ where: { key: { in: ENGINE_KEYS } } });
  await prisma.aiGatewayCall.deleteMany({});
  await prisma.aiBudgetReservation.deleteMany({});
  await prisma.aiCostQuote.deleteMany({});
  await prisma.aiModel.deleteMany({});
}

async function fingerprint() {
  const [q] = await prisma.$queryRaw<{ n: number; h: string }[]>`SELECT COUNT(*)::int AS n, md5(string_agg("id" || "text" || "status" || coalesce("explanation", ''), ',' ORDER BY "id")) AS h FROM "Question"`;
  const [o] = await prisma.$queryRaw<{ n: number; h: string }[]>`SELECT COUNT(*)::int AS n, md5(string_agg("id" || "label" || "text" || "isCorrect"::text, ',' ORDER BY "id")) AS h FROM "QuestionOption"`;
  const [p] = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "PreviousYearPaper"`;
  return JSON.stringify({ q, o, p });
}

async function main() {
  // Outbound guard: only the loopback mock may be called.
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    outbound.push(url);
    if (!url.startsWith("http://127.0.0.1:")) throw new Error(`BLOCKED non-loopback fetch in test: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;

  const mock = await startMockOpenRouter(PORT);
  const before = await fingerprint();
  await resetAll();

  const cfg = await import("@/lib/ai-engine/config");
  const settings = await import("@/lib/ai-engine/settings");
  const catalog = await import("@/lib/ai-engine/catalog");
  const fx = await import("@/lib/ai-engine/fx");
  const router = await import("@/lib/ai-engine/router");
  const budget = await import("@/lib/ai-engine/budget");
  const engine = await import("@/lib/ai-engine/engine");
  const quote = await import("@/lib/ai-engine/quote");
  const manage = await import("@/lib/ai-engine/manage");
  const analytics = await import("@/lib/ai-engine/analytics");
  const evalMod = await import("@/lib/ai-engine/eval");
  const gateway = await import("@/lib/ai-gateway");
  const { AiNotConfiguredError } = await import("@/lib/ai-provider");
  const admin = await prisma.adminUser.findFirstOrThrow({ where: { username: "igmaster" } });
  const other = await prisma.adminUser.findFirstOrThrow({ where: { username: "igfull" } });

  console.log("\nA. Config & cost arithmetic");
  await check("default budgets are ₹100/day, ₹1,500/month, ₹2 text, ₹10 image, stop off", () => {
    assert.deepEqual(cfg.normalizeBudgets(undefined), { dailyInr: 100, monthlyInr: 1500, maxTextRequestInr: 2, maxImageRequestInr: 10, alertPercent: 80, emergencyStop: false });
  });
  await check("every feature defaults to the legacy route, enabled, Cheapest Approved", () => {
    const d = cfg.normalizeFeatureConfig(undefined);
    assert.equal(d.provider, "legacy");
    assert.equal(d.enabled, true);
    assert.equal(d.mode, "cheapest");
  });
  await check("feature config clamps timeout/retries and drops invalid / duplicate fallbacks", () => {
    const n = cfg.normalizeFeatureConfig({ provider: "openrouter", timeoutMs: 1, maxRetries: 9, model: "a/b", fallbacks: ["a/b", "bad id", "c/d", "c/d", "e/f", "g/h", "i/j"] });
    assert.equal(n.timeoutMs, 5000);
    assert.equal(n.maxRetries, 2);
    assert.deepEqual(n.fallbacks, ["c/d", "e/f", "g/h"]);
  });
  await check("unpriced model → null cost (never treated as free)", () => {
    assert.equal(cfg.textCallMaxUsd({ id: "x/y", promptPrice: null, completionPrice: 0.1, reasoningPrice: null, requestPrice: null, imageUnit: null, imageUnitCostUsd: null, imageUnitsPerImage: null }, 10, 10), null);
  });
  await check("max cost uses the higher of completion / reasoning price + request fee", () => {
    const v = cfg.textCallMaxUsd({ id: "x/y", promptPrice: 1e-6, completionPrice: 2e-6, reasoningPrice: 5e-6, requestPrice: 0.001, imageUnit: null, imageUnitCostUsd: null, imageUnitsPerImage: null }, 1000, 1000)!;
    assert.ok(Math.abs(v - (0.001 + 0.005 + 0.001)) < 1e-12);
  });
  await check("image price: per image exact, per token needs units-per-image", () => {
    const base = { id: "i/m", promptPrice: null, completionPrice: null, reasoningPrice: null, requestPrice: null, imageUnitsPerImage: null };
    assert.equal(cfg.imageMaxUsd({ ...base, imageUnit: "image", imageUnitCostUsd: 0.02 }, 0.79), 0.02);
    assert.equal(cfg.imageMaxUsd({ ...base, imageUnit: "token", imageUnitCostUsd: 0.00003 }, 0.79), null);
    assert.ok(Math.abs(cfg.imageMaxUsd({ ...base, imageUnit: "token", imageUnitCostUsd: 0.00003, imageUnitsPerImage: 1300 }, 0.79)! - 0.039) < 1e-12);
  });
  await check("catalog parsePrice: '-1' (variable, e.g. openrouter/auto) → null", () => {
    assert.equal(catalog.parsePrice("-1"), null);
    assert.equal(catalog.parsePrice("0.0000025"), 0.0000025);
    assert.equal(catalog.parsePrice("abc"), null);
  });

  console.log("\nB. OpenRouter key storage & connection test");
  const validKey = mockKey("valid");
  await check("a key that is not sk-or-… is refused", async () => {
    const e = await thrown(() => settings.saveOpenRouterKey("sk-ant-wrongprovider-1234567890123456789012345"));
    assert.ok(e instanceof settings.EngineConfigError);
  });
  await check("saved key is encrypted at rest; public config shows only the hint", async () => {
    await settings.saveOpenRouterKey(validKey, "admin");
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: "api.openrouter" } });
    assert.ok(!JSON.stringify(row.value).includes(validKey), "plaintext key in DB");
    const pub = await settings.getOpenRouterConfig();
    assert.ok(!JSON.stringify(pub).includes(validKey.slice(10, 30)), "key leaked in public config");
    assert.equal(pub.keyHint, `sk-or-••••${validKey.slice(-4)}`);
    assert.equal(pub.status, "DISABLED");
  });
  await check("enabling before a successful test is refused", async () => {
    const e = await thrown(() => settings.setOpenRouterEnabled(true));
    assert.ok(e instanceof settings.EngineConfigError);
  });
  await check("Test Connection (GET /key, no generation) → CONNECTED + key limit snapshot", async () => {
    const t = await manage.testOpenRouterConnection();
    assert.equal(t.ok, true, t.message);
    const pub = await settings.getOpenRouterConfig();
    assert.equal(pub.keyStatus?.limitUsd, 10);
    assert.equal(mock.stats.chat, 0, "test must not generate");
  });
  await check("second test within 10 s is refused (cooldown across workers)", async () => {
    const e = await thrown(() => manage.testOpenRouterConnection());
    assert.ok(e instanceof settings.EngineConfigError);
  });
  await check("enable after a successful test", async () => {
    const c = await settings.setOpenRouterEnabled(true);
    assert.equal(c.status, "CONNECTED");
  });
  await check("a bad key fails the test with auth_invalid", async () => {
    await settings.saveOpenRouterKey(mockKey("bad"));
    await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" - 'lastTest' WHERE "key" = 'api.openrouter'`;
    const t = await manage.testOpenRouterConnection();
    assert.equal(t.ok, false);
    assert.equal(t.category, "auth_invalid");
    assert.equal((await settings.getOpenRouterConfig()).enabled, false, "a new key starts disabled");
  });
  // (Re)install a key as tested + enabled — saving a key always resets it to untested/disabled.
  const installKey = async (k: string) => {
    await settings.saveOpenRouterKey(k);
    await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('enabled', true, 'lastTest', jsonb_build_object('ok', true, 'category', 'ok', 'message', 'ok', 'at', '2026-01-01T00:00:00Z')) WHERE "key" = 'api.openrouter'`;
  };
  await installKey(validKey);

  console.log("\nC. Model catalog sync");
  await check("sync copies ids + prices from the Models API; auto router price stays null (variable)", async () => {
    const r = await catalog.syncCatalog();
    assert.equal(r.text, 11);
    assert.equal(r.image, 3);
    const cheap = await prisma.aiModel.findUniqueOrThrow({ where: { id: "mockai/cheap" } });
    assert.equal(cheap.promptPrice, 0.0000001);
    assert.equal(cheap.completionPrice, 0.0000004);
    const auto = await prisma.aiModel.findUniqueOrThrow({ where: { id: "openrouter/auto" } });
    assert.equal(auto.promptPrice, null);
    assert.equal(cheap.approved, false, "new models are never auto-approved");
  });
  await check("re-sync keeps admin approval flags", async () => {
    await prisma.aiModel.update({ where: { id: "mockai/mid" }, data: { approved: true, notes: "keep" } });
    await catalog.syncCatalog();
    const m = await prisma.aiModel.findUniqueOrThrow({ where: { id: "mockai/mid" } });
    assert.equal(m.approved, true);
    assert.equal(m.notes, "keep");
  });
  await check("image models are flagged; endpoint price line loads on refresh", async () => {
    const m = await catalog.refreshImagePrice("mockimg/perimage");
    assert.equal(m.isImageModel, true);
    assert.equal(m.imageUnit, "image");
    assert.equal(m.imageUnitCostUsd, 0.02);
  });

  console.log("\nD. USD→INR rate");
  await check("first use fetches the rate (Frankfurter mock) and stores it with its time", async () => {
    const r = await fx.getUsdInr();
    assert.equal(r.rate, 95.5);
    assert.ok(r.at);
    assert.equal(r.source, "Frankfurter (ECB)");
  });
  await check("a jump of more than 15% is rejected and the previous rate kept", async () => {
    await realFetch(`http://127.0.0.1:${PORT}/__mock/fx?rate=130`);
    const r = await fx.refreshFxRate();
    assert.equal(r.rate, 95.5);
    assert.match(r.lastError ?? "", /15%/);
  });
  await check("rate service down → previous validated rate kept", async () => {
    await realFetch(`http://127.0.0.1:${PORT}/__mock/fx?rate=96&status=500`);
    const r = await fx.refreshFxRate();
    assert.equal(r.rate, 95.5);
    await realFetch(`http://127.0.0.1:${PORT}/__mock/fx?status=200`);
  });
  await check("a rate older than 14 days is not used (paid requests then refuse)", async () => {
    await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('fetchedAt', '2026-01-01T00:00:00Z', 'lastAttemptAt', ${new Date().toISOString()}::text) WHERE "key" = 'ai.fx'`;
    const r = await fx.getUsdInr();
    assert.equal(r.rate, null);
    assert.ok(r.unavailableReason);
  });
  await check("manual override is used and validated (40–250)", async () => {
    const e = await thrown(() => fx.setFxMode({ mode: "manual", manualRate: 5 }));
    assert.ok(e);
    const r = await fx.setFxMode({ mode: "manual", manualRate: 90 });
    assert.equal(r.rate, 90);
    assert.equal(r.source, "Manual override");
  });
  await check("back to automatic refreshes when the stored rate is stale", async () => {
    await fx.setFxMode({ mode: "auto" });
    await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" - 'lastAttemptAt' WHERE "key" = 'ai.fx'`;
    const r = await fx.getUsdInr();
    assert.equal(r.rate, 96);
  });
  const RATE = 96;

  console.log("\nE. Router");
  await prisma.aiModel.updateMany({ where: { id: { in: ["mockai/cheap", "mockai/mid", "mockai/premium", "mockai/tinyctx", "mockai/fail429", "mockai/fail500", "mockai/slow", "mockai/empty", "mockai/nocost", "mockai/collector"] } }, data: { approved: true } });
  await check("cheapest approved for a non-medical feature picks the lowest typical cost (with fallbacks)", async () => {
    const plan = await router.planText({ feature: "ig_caption", cfg: { ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter" }, inputTokens: 500, maxOut: 1000, typicalOut: 400, capUsd: 1 });
    assert.equal(plan.models[0].id, "mockai/fail429"); // cheapest by price — failing models are only skipped once the history shows them failing
    assert.ok(plan.models.length >= 2);
    assert.equal(plan.mode, "cheapest");
  });
  await check("a context window too small for prompt + output is skipped", async () => {
    const c = await router.textCandidates("ig_caption", 900, 1000, 400);
    assert.ok(!c.some((x) => x.model.id === "mockai/tinyctx"));
  });
  await check("medical features use ONLY medically approved models", async () => {
    const e = await thrown(() => router.planText({ feature: "explanation", cfg: { ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter" }, inputTokens: 300, maxOut: 1400, typicalOut: 500, capUsd: 1 }));
    assert.ok(e instanceof AiNotConfiguredError, "no medical model approved yet → refused");
    await prisma.aiModel.update({ where: { id: "mockai/mid" }, data: { medicallyApproved: true } });
    const plan = await router.planText({ feature: "explanation", cfg: { ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter" }, inputTokens: 300, maxOut: 1400, typicalOut: 500, capUsd: 1 });
    assert.equal(plan.models[0].id, "mockai/mid");
    assert.ok(plan.models.every((m) => m.id === "mockai/mid"), "no non-medical fallback");
  });
  await check("per-request cap: a model above the cap is refused, fallbacks above it dropped", async () => {
    const e = await thrown(() => router.planText({ feature: "ig_caption", cfg: { ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "manual", model: "mockai/premium" }, inputTokens: 500, maxOut: 2000, typicalOut: 400, capUsd: 0.001 }));
    assert.ok(e instanceof AiNotConfiguredError);
    const plan = await router.planText({ feature: "ig_caption", cfg: { ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "manual", model: "mockai/cheap", fallbacks: ["mockai/premium", "mockai/mid"] }, inputTokens: 500, maxOut: 2000, typicalOut: 400, capUsd: 0.01 });
    assert.deepEqual(plan.models.map((m) => m.id), ["mockai/cheap", "mockai/mid"]);
  });
  await check("manual model that is not approved → clear refusal", async () => {
    await prisma.aiModel.update({ where: { id: "mockai/premium" }, data: { approved: false } });
    const e = await thrown(() => router.planText({ feature: "ig_caption", cfg: { ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "manual", model: "mockai/premium" }, inputTokens: 100, maxOut: 100, typicalOut: 50, capUsd: 1 }));
    assert.match(e?.message ?? "", /not approved/);
    await prisma.aiModel.update({ where: { id: "mockai/premium" }, data: { approved: true } });
  });
  await check("OpenRouter Auto: allowed_models = approved list, ceiling = most expensive allowed", async () => {
    const plan = await router.planText({ feature: "ig_caption", cfg: { ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "auto" }, inputTokens: 500, maxOut: 1000, typicalOut: 400, capUsd: 1 });
    assert.equal(plan.models.length, 0);
    assert.ok(plan.autoAllowed!.includes("mockai/cheap"));
    assert.ok(Math.abs(plan.maxPricePerM.completion - 20) < 1e-9, `ceiling ${plan.maxPricePerM.completion}`);
  });
  await check("a model failing ≥50% of ≥5 recent calls is skipped by cheapest routing", async () => {
    await prisma.aiGatewayCall.createMany({ data: Array.from({ length: 6 }, () => ({ feature: "ig_caption", provider: "openrouter", model: "mockai/fail429", ok: false, latencyMs: 1 })) });
    const c = await router.textCandidates("ig_caption", 100, 100, 50);
    assert.ok(!c.some((x) => x.model.id === "mockai/fail429"));
    await prisma.aiGatewayCall.deleteMany({});
  });

  console.log("\nF. Budgets (concurrency-safe reservations)");
  const B = cfg.normalizeBudgets({ dailyInr: 10, monthlyInr: 100 });
  await check("20 simultaneous ₹1 reservations against a ₹10 daily budget → exactly 10 succeed", async () => {
    const rs = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => budget.reserveBudget({ requestKey: `par-${i}`, feature: "ig_caption", featureLabel: "x", reservedInr: 1, budgets: B, featureDailyInr: null })));
    assert.equal(rs.filter((r) => r.status === "fulfilled").length, 10);
    assert.ok(rs.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof budget.AiBudgetError));
  });
  await check("settling to the actual cost frees the rest of the reservation", async () => {
    for (let i = 0; i < 20; i++) await budget.settleBudget(`par-${i}`, 0.25);
    const u = await budget.budgetUsage();
    assert.ok(Math.abs(u.dayInr - 2.5) < 1e-9, `day ${u.dayInr}`);
  });
  await check("release (not billed) counts ₹0; unknown cost keeps the reserved maximum", async () => {
    await budget.reserveBudget({ requestKey: "rel-1", feature: "ig_caption", featureLabel: "x", reservedInr: 3, budgets: B, featureDailyInr: null });
    await budget.releaseBudget("rel-1");
    await budget.reserveBudget({ requestKey: "unk-1", feature: "ig_caption", featureLabel: "x", reservedInr: 2, budgets: B, featureDailyInr: null });
    await budget.settleBudget("unk-1", null);
    const u = await budget.budgetUsage();
    assert.ok(Math.abs(u.dayInr - 4.5) < 1e-9, `day ${u.dayInr}`);
    assert.ok(Math.abs(u.dayHeldInr - 2) < 1e-9);
  });
  await check("feature daily budget is enforced separately", async () => {
    const e = await thrown(() => budget.reserveBudget({ requestKey: "feat-1", feature: "ig_trap", featureLabel: "Trap", reservedInr: 1.5, budgets: B, featureDailyInr: 1 }));
    assert.ok(e instanceof budget.AiBudgetError);
  });
  await check("emergency stop refuses every reservation", async () => {
    const e = await thrown(() => budget.reserveBudget({ requestKey: "stop-1", feature: "ig_caption", featureLabel: "x", reservedInr: 0.01, budgets: { ...B, emergencyStop: true }, featureDailyInr: null }));
    assert.match(e?.message ?? "", /emergency stop/);
  });
  await check("a crashed (stale RESERVED) reservation is settled at its maximum", async () => {
    await prisma.aiBudgetReservation.create({ data: { requestKey: "stale-1", feature: "ig_caption", reservedInr: 1, istDay: budget.istDayMonth().istDay, istMonth: budget.istDayMonth().istMonth, createdAt: new Date(Date.now() - 3600_000) } });
    await budget.reserveBudget({ requestKey: "after-stale", feature: "ig_caption", featureLabel: "x", reservedInr: 0.01, budgets: B, featureDailyInr: null });
    const s = await prisma.aiBudgetReservation.findUniqueOrThrow({ where: { requestKey: "stale-1" } });
    assert.equal(s.status, "SETTLED");
    assert.equal(s.costKnown, false);
    assert.equal(s.settledInr, 1);
  });
  await prisma.aiBudgetReservation.deleteMany({});

  console.log("\nG. Engine — OpenRouter text generation through the gateway");
  const setFeature = async (f: Parameters<typeof settings.saveFeatureConfig>[0], p: Partial<ReturnType<typeof cfg.normalizeFeatureConfig>>) =>
    settings.saveFeatureConfig(f, cfg.normalizeFeatureConfig({ ...cfg.DEFAULT_FEATURE_CONFIG, provider: "openrouter", ...p }));
  // The data-collecting model is the cheapest by price; keep it out of cheapest routing except in its own privacy test.
  await prisma.aiModel.updateMany({ where: { id: { in: ["mockai/fail429", "mockai/fail500", "mockai/collector"] } }, data: { approved: false } });
  await check("legacy route unchanged: no Gemini key → the same AiNotConfiguredError as before", async () => {
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.5, maxOutputTokens: 500 }));
    assert.ok(e instanceof AiNotConfiguredError);
    assert.equal(await prisma.aiGatewayCall.count({ where: { provider: "openrouter" } }), 0);
  });
  await check("OpenRouter call records tokens, actual USD + INR at the stored rate, settles the reservation", async () => {
    await setFeature("ig_caption", { mode: "cheapest" });
    const r = await gateway.generateForFeature("ig_caption", "Write THREE editable caption versions for this post.", { temperature: 0.7, maxOutputTokens: 2600 }, { actorId: admin.id, instagramPostId: "post-fixture-1" });
    assert.equal(r.provider, "openrouter");
    assert.equal(r.model, "mockai/cheap");
    const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { provider: "openrouter" } });
    assert.equal(row.costStatus, "actual");
    assert.ok(row.actualCostUsd! > 0);
    assert.equal(row.fxRate, RATE);
    assert.ok(Math.abs(row.actualCostInr! - row.actualCostUsd! * RATE) < 1e-6);
    assert.ok(row.generationId?.startsWith("gen-mock-"));
    assert.equal(row.instagramPostId, "post-fixture-1");
    const res = await prisma.aiBudgetReservation.findFirstOrThrow({ where: { requestKey: `${row.requestId}:1` } });
    assert.equal(res.status, "SETTLED");
    assert.ok(Math.abs(res.settledInr! - row.actualCostInr!) < 1e-6);
    const body = (await (await realFetch(`http://127.0.0.1:${PORT}/__mock/stats`)).json()).bodies.at(-1);
    assert.equal(body.provider.sort, "price");
    assert.equal(body.provider.data_collection, "deny", "privacy policy sent");
    assert.ok(body.provider.max_price.prompt > 0, "price ceiling sent");
    assert.equal(body.max_tokens, 2600);
  });
  await check("OpenRouter-side model fallback: failing primary → answered by the approved fallback, flagged", async () => {
    await prisma.aiModel.update({ where: { id: "mockai/fail429" }, data: { approved: true } });
    await setFeature("ig_caption", { mode: "manual", model: "mockai/fail429", fallbacks: ["mockai/cheap"], maxRetries: 0 });
    const r = await gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 });
    assert.equal(r.model, "mockai/cheap");
    const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { provider: "openrouter" }, orderBy: { createdAt: "desc" } });
    assert.equal(row.fallbackUsed, true);
    assert.equal(row.modelRequested, "mockai/fail429");
  });
  await check("transient error (429) → controlled retry (maxRetries 1): 2 attempts, both released, readable error", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    await setFeature("ig_caption", { mode: "manual", model: "mockai/fail429", fallbacks: [], maxRetries: 1 });
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 }));
    assert.ok(e instanceof gateway.AiProviderFailure, String(e));
    const rows = await prisma.aiGatewayCall.findMany({ where: { provider: "openrouter" } });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((x) => x.costStatus === "none" && x.actualCostInr === null));
    assert.equal(await prisma.aiBudgetReservation.count({ where: { status: "RELEASED" } }), 2);
  });
  await check("402 insufficient credits → not retried, not billed, clear message", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    await installKey(mockKey("nocredit"));
    await setFeature("ig_caption", { mode: "manual", model: "mockai/cheap", maxRetries: 2 });
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 }));
    assert.match(e?.message ?? "", /no credits/);
    assert.equal(await prisma.aiGatewayCall.count({ where: { provider: "openrouter" } }), 1);
    await installKey(validKey);
    await prisma.aiModel.update({ where: { id: "mockai/fail429" }, data: { approved: false } });
  });
  await check("timeout → no retry, cost UNKNOWN (never ₹0), worst case kept in the budget", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    await prisma.aiBudgetReservation.deleteMany({});
    await setFeature("ig_caption", { mode: "manual", model: "mockai/slow", maxRetries: 2, timeoutMs: 5000 });
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 }));
    assert.ok(e);
    const rows = await prisma.aiGatewayCall.findMany({ where: { provider: "openrouter" } });
    assert.equal(rows.length, 1, "no retry after a timeout");
    assert.equal(rows[0].costStatus, "unknown");
    assert.equal(rows[0].actualCostInr, null);
    const res = await prisma.aiBudgetReservation.findFirstOrThrow({});
    assert.equal(res.costKnown, false);
    assert.ok(res.settledInr! > 0);
  });
  await check("cost not in the response → 'pending', then reconciled from /generation (idempotent)", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    await setFeature("ig_caption", { mode: "manual", model: "mockai/nocost", maxRetries: 0, timeoutMs: 60000 });
    await gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 });
    const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { provider: "openrouter" } });
    assert.equal(row.costStatus, "pending");
    assert.equal(row.actualCostInr, null);
    const r1 = await analytics.reconcilePending();
    assert.equal(r1.resolved, 1);
    const after = await prisma.aiGatewayCall.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after.costStatus, "actual");
    assert.ok(after.actualCostInr! > 0);
    const res = await prisma.aiBudgetReservation.findFirstOrThrow({ where: { requestKey: `${row.requestId}:1` } });
    assert.equal(res.costKnown, true);
    assert.ok(Math.abs(res.settledInr! - after.actualCostInr!) < 1e-6);
    const r2 = await analytics.reconcilePending();
    assert.equal(r2.resolved, 0, "second reconcile changes nothing");
  });
  await check("empty response → failure, but its reported cost is still recorded", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    await setFeature("ig_caption", { mode: "manual", model: "mockai/empty", maxRetries: 0 });
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 }));
    assert.ok(e);
    const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { provider: "openrouter" } });
    assert.equal(row.ok, false);
    assert.equal(row.errorCategory, "empty_response");
    assert.equal(row.costStatus, "actual");
  });
  await check("privacy: a provider outside data_collection=deny is never used (request fails instead)", async () => {
    await prisma.aiModel.update({ where: { id: "mockai/collector" }, data: { approved: true } });
    await setFeature("ig_caption", { mode: "manual", model: "mockai/collector", maxRetries: 0 });
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 }));
    assert.match(e?.message ?? "", /privacy policy|no provider/i);
    await prisma.aiModel.update({ where: { id: "mockai/collector" }, data: { approved: false } });
  });
  await check("per-request limit refuses BEFORE any provider call", async () => {
    const calls = mock.stats.chat;
    await setFeature("ig_caption", { mode: "manual", model: "mockai/premium", maxCostInr: 0.01 });
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 2600 }));
    assert.match(e?.message ?? "", /per-request limit/);
    assert.equal(mock.stats.chat, calls);
  });
  await check("daily budget exhausted → refused before any provider call", async () => {
    const calls = mock.stats.chat;
    await settings.saveBudgets(cfg.normalizeBudgets({ dailyInr: 0.000001, monthlyInr: 1500 }));
    await setFeature("ig_caption", { mode: "manual", model: "mockai/cheap" });
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 }));
    assert.match(e?.message ?? "", /daily AI budget/);
    assert.equal(mock.stats.chat, calls);
    await settings.saveBudgets(cfg.normalizeBudgets({}));
  });
  await check("emergency stop blocks legacy-route features too", async () => {
    await settings.saveBudgets({ ...cfg.normalizeBudgets({}), emergencyStop: true });
    const e = await thrown(() => gateway.generateForFeature("ig_trends", "x", { temperature: 0, maxOutputTokens: 10 }));
    assert.match(e?.message ?? "", /emergency stop/);
    assert.equal(await gateway.isFeatureConfigured("explanation"), false);
    await settings.saveBudgets(cfg.normalizeBudgets({}));
  });
  await check("a feature turned off makes no request", async () => {
    await settings.saveFeatureConfig("ig_trends", cfg.normalizeFeatureConfig({ enabled: false }));
    const e = await thrown(() => gateway.generateForFeature("ig_trends", "x", { temperature: 0, maxOutputTokens: 10 }));
    assert.match(e?.message ?? "", /turned off/);
    await settings.saveFeatureConfig("ig_trends", cfg.normalizeFeatureConfig({}));
  });
  await check("student feature: errors are generic (no budget/model wording shown to students)", async () => {
    await setFeature("explanation", { mode: "manual", model: "mockai/cheap" }); // not medically approved
    const e = await thrown(() => gateway.generateForFeature("explanation", "x", { temperature: 0.4, maxOutputTokens: 1400 }));
    assert.ok(e instanceof AiNotConfiguredError);
    assert.equal(e!.message, "AI explanations are temporarily unavailable. Please try again later.");
  });
  await check("student feature on a medically approved model works and is cost-tracked", async () => {
    await setFeature("explanation", { mode: "cheapest" });
    const r = await gateway.generateForFeature("explanation", "Explain this MCQ.", { temperature: 0.4, maxOutputTokens: 1400 });
    assert.equal(r.model, "mockai/mid");
    assert.equal(await gateway.isFeatureConfigured("explanation"), true);
  });
  await check("OpenRouter disabled → OpenRouter features refuse (no silent fallback to another provider)", async () => {
    await settings.setOpenRouterEnabled(false);
    const e = await thrown(() => gateway.generateForFeature("ig_caption", "x", { temperature: 0, maxOutputTokens: 10 }));
    assert.match(e?.message ?? "", /not configured or is disabled/);
    await installKey(validKey);
  });

  console.log("\nH. One-time cost quotes");
  await setFeature("ig_caption", { mode: "cheapest", maxRetries: 0 });
  let q1: Awaited<ReturnType<typeof quote.createQuote>>;
  await check("quote: model, tokens, typical + maximum INR, rate and cap — computed on the server", async () => {
    q1 = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p1" }, actorId: admin.id });
    assert.equal(q1.provider, "openrouter");
    assert.equal(q1.model, "mockai/cheap");
    assert.ok(q1.textInr! > 0 && q1.textMaxInr! >= q1.textInr!);
    assert.equal(q1.fxRate, RATE);
    assert.equal(q1.capInr, 2);
    assert.equal(q1.runnable, true);
    assert.ok(q1.alternatives.length >= 2);
    assert.ok(q1.notes.some((n) => /not a guaranteed final price/.test(n)));
  });
  await check("consume once → model; the same quote again is refused (double-click protection)", async () => {
    const c = await quote.consumeQuote({ quoteId: q1.id, actorId: admin.id, feature: "ig_caption", action: "ig_caption", context: { postId: "p1" } });
    assert.equal(c.model, "mockai/cheap");
    const e = await thrown(() => quote.consumeQuote({ quoteId: q1.id, actorId: admin.id, feature: "ig_caption", action: "ig_caption", context: { postId: "p1" } }));
    assert.match(e?.message ?? "", /already used/);
  });
  await check("parallel consumption of one quote: exactly one wins", async () => {
    const q = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p2" }, actorId: admin.id });
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => quote.consumeQuote({ quoteId: q.id, actorId: admin.id, feature: "ig_caption", action: "ig_caption", context: { postId: "p2" } })));
    assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
  });
  await check("another admin, another post, another action or no quote → refused", async () => {
    const q = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p3" }, actorId: admin.id });
    for (const bad of [
      { actorId: other.id, context: { postId: "p3" }, feature: "ig_caption" as const },
      { actorId: admin.id, context: { postId: "p4" }, feature: "ig_caption" as const },
      { actorId: admin.id, context: { postId: "p3" }, feature: "ig_trap" as const },
    ]) {
      const e = await thrown(() => quote.consumeQuote({ quoteId: q.id, action: bad.feature, ...bad }));
      assert.ok(e instanceof quote.QuoteError, JSON.stringify(bad));
    }
    const none = await thrown(() => quote.consumeQuote({ quoteId: undefined, actorId: admin.id, feature: "ig_caption", action: "ig_caption", context: {} }));
    assert.match(none?.message ?? "", /cost estimate first/);
  });
  await check("expired quote → refused", async () => {
    const q = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p5" }, actorId: admin.id });
    await prisma.aiCostQuote.update({ where: { id: q.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const e = await thrown(() => quote.consumeQuote({ quoteId: q.id, actorId: admin.id, feature: "ig_caption", action: "ig_caption", context: { postId: "p5" } }));
    assert.match(e?.message ?? "", /expired/);
  });
  await check("Change Model / Choose Cheapest", async () => {
    const q = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p6" }, actorId: admin.id, model: "mockai/premium" });
    assert.equal(q.model, "mockai/premium");
    const c = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p6" }, actorId: admin.id, pick: "cheapest" });
    assert.equal(c.model, "mockai/cheap");
  });
  await check("quote above the per-request limit is not runnable (cannot be consumed)", async () => {
    await setFeature("ig_caption", { mode: "manual", model: "mockai/premium", maxCostInr: 0.01 });
    const q = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p7" }, actorId: admin.id });
    assert.equal(q.runnable, false);
    assert.match(q.blockReason ?? "", /per-request limit/);
    const e = await thrown(() => quote.consumeQuote({ quoteId: q.id, actorId: admin.id, feature: "ig_caption", action: "ig_caption", context: { postId: "p7" } }));
    assert.ok(e);
    await setFeature("ig_caption", { mode: "cheapest" });
  });
  await check("legacy feature quote: disclosed as 'no estimate available', still one-time", async () => {
    const q = await quote.createQuote({ feature: "ig_trap", action: "ig_trap", context: { postId: "p8" }, actorId: admin.id });
    assert.equal(q.provider, "legacy");
    assert.equal(q.totalInr, null);
    assert.ok(q.notes.some((n) => /legacy/.test(n)));
    const c = await quote.consumeQuote({ quoteId: q.id, actorId: admin.id, feature: "ig_trap", action: "ig_trap", context: { postId: "p8" } });
    assert.equal(c.model, null, "legacy quote pins no OpenRouter model");
  });
  await check("the quote's model is used at execution and the quote id is logged", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    const q = await quote.createQuote({ feature: "ig_caption", action: "ig_caption", context: { postId: "p9" }, actorId: admin.id, model: "mockai/mid" });
    const c = await quote.consumeQuote({ quoteId: q.id, actorId: admin.id, feature: "ig_caption", action: "ig_caption", context: { postId: "p9" } });
    const r = await gateway.generateForFeature("ig_caption", "THREE editable caption versions", { temperature: 0.7, maxOutputTokens: 800 }, { actorId: admin.id, quoteId: c.id, modelOverride: c.model, instagramPostId: "p9" });
    assert.equal(r.model, "mockai/mid");
    const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { provider: "openrouter" } });
    assert.equal(row.quoteId, q.id);
  });

  console.log("\nI. Medical images through the OpenRouter Images API");
  await check("image feature: only approved + medically approved image models with an estimable price", async () => {
    await settings.saveFeatureConfig("ig_image", cfg.normalizeFeatureConfig({ provider: "openrouter" }));
    await prisma.aiModel.update({ where: { id: "mockimg/perimage" }, data: { approved: true } });
    assert.equal((await router.imageCandidates("ig_image")).length, 0, "not medically approved yet");
    await prisma.aiModel.update({ where: { id: "mockimg/perimage" }, data: { medicallyApproved: true } });
    await prisma.aiModel.update({ where: { id: "mockimg/pertoken" }, data: { approved: true, medicallyApproved: true } });
    await catalog.refreshImagePrice("mockimg/pertoken");
    const c = await router.imageCandidates("ig_image");
    assert.deepEqual(c.map((x) => x.model.id), ["mockimg/perimage"], "token-priced model needs units per image");
  });
  await check("image generation: bytes returned, aspect 4:3 / 1K requested, $0.02 recorded in INR", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    const r = await engine.generateImageViaOpenRouter("ig_image", "spinal cord cross-section", { actorId: admin.id, instagramPostId: "img-post" });
    assert.ok(r.bytes.length > 50);
    const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { provider: "openrouter", kind: "image" } });
    assert.equal(row.actualCostUsd, 0.02);
    assert.ok(Math.abs(row.actualCostInr! - 0.02 * RATE) < 1e-6);
    assert.equal(row.imageCount, 1);
    const body = (await (await realFetch(`http://127.0.0.1:${PORT}/__mock/stats`)).json()).bodies.filter((b: { image?: boolean }) => b.image).at(-1);
    assert.equal(body.aspect_ratio, "4:3");
    assert.equal(body.resolution, "1K");
  });
  await check("image above the ₹10 image limit is refused before the call", async () => {
    const calls = mock.stats.images;
    await settings.saveFeatureConfig("ig_image", cfg.normalizeFeatureConfig({ provider: "openrouter", maxCostInr: 1 }));
    const e = await thrown(() => engine.generateImageViaOpenRouter("ig_image", "x", {}));
    assert.ok(e);
    assert.equal(mock.stats.images, calls);
    await settings.saveFeatureConfig("ig_image", cfg.normalizeFeatureConfig({ provider: "openrouter" }));
  });
  await check("failed image is not billed (reservation released)", async () => {
    await prisma.aiModel.update({ where: { id: "mockimg/fail" }, data: { approved: true, medicallyApproved: true } });
    await catalog.refreshImagePrice("mockimg/fail");
    await settings.saveFeatureConfig("ig_image", cfg.normalizeFeatureConfig({ provider: "openrouter", mode: "manual", model: "mockimg/fail" }));
    const e = await thrown(() => engine.generateImageViaOpenRouter("ig_image", "x", {}));
    assert.ok(e instanceof engine.AiEngineFailure);
    const row = await prisma.aiGatewayCall.findFirstOrThrow({ where: { kind: "image", ok: false } });
    assert.equal(row.costStatus, "none");
    await settings.saveFeatureConfig("ig_image", cfg.normalizeFeatureConfig({ provider: "openrouter" }));
  });

  console.log("\nJ. Feature switching safeguards");
  await check("switching a medical feature to OpenRouter needs a medically approved model", async () => {
    await prisma.aiModel.updateMany({ data: { medicallyApproved: false } });
    const e = await thrown(() => manage.updateFeature("ig_trap", cfg.normalizeFeatureConfig({ provider: "openrouter" })));
    assert.ok(e instanceof settings.EngineConfigError);
    await prisma.aiModel.update({ where: { id: "mockai/mid" }, data: { medicallyApproved: true } });
    await manage.updateFeature("ig_trap", cfg.normalizeFeatureConfig({ provider: "openrouter" }));
  });
  await check("switching to OpenRouter while it is disabled is refused", async () => {
    await settings.setOpenRouterEnabled(false);
    const e = await thrown(() => manage.updateFeature("ig_diagram", cfg.normalizeFeatureConfig({ provider: "openrouter" })));
    assert.ok(e instanceof settings.EngineConfigError);
    await installKey(validKey);
  });

  console.log("\nK. Analytics");
  await check("dashboard stats: requests counted; unknown costs are NOT counted as ₹0 cost", async () => {
    await prisma.aiGatewayCall.create({ data: { feature: "explanation", provider: "gemini", model: "gemini-3.1-flash-lite", ok: true, latencyMs: 10, costStatus: "unknown" } });
    const s = await analytics.dashboardAiStats();
    assert.ok(s.today.requests >= 2);
    assert.ok(s.today.uncosted >= 1);
    const sum = await prisma.aiGatewayCall.aggregate({ _sum: { actualCostInr: true } });
    assert.ok(Math.abs(s.lifetime.costInr - (sum._sum.actualCostInr ?? 0)) < 1e-9);
    assert.ok(s.costTrackingSince);
  });
  await check("per-post cost: first action = initial, later actions of the same feature = regeneration", async () => {
    await prisma.aiGatewayCall.deleteMany({});
    const mk = (feature: string, quoteId: string, inr: number) => ({ feature, provider: "openrouter", model: "m", ok: true, latencyMs: 1, actualCostInr: inr, instagramPostId: "pc", quoteId });
    await prisma.aiGatewayCall.createMany({ data: [mk("ig_trap", "q1", 1), mk("ig_trap", "q1", 0.5), mk("ig_diagram", "q2", 2), mk("ig_image", "q3", 3), mk("ig_trap", "q4", 4)] });
    const c = await analytics.postCost("pc");
    assert.equal(c.text, 1.5);
    assert.equal(c.diagram, 2);
    assert.equal(c.image, 3);
    assert.equal(c.regeneration, 4);
    assert.equal(c.total, 10.5);
  });

  console.log("\nL. Medical quality evaluation");
  await check("parseSolve: valid JSON + label, invalid label rejected", () => {
    assert.deepEqual(evalMod.parseSolve('{"answer":"b","confidence":0.7,"reason":"x"}', ["A", "B"]).answer, "B");
    assert.equal(evalMod.parseSolve('{"answer":"Z"}', ["A", "B"]).jsonOk, false);
    assert.equal(evalMod.parseSolve("no json", ["A"]).jsonOk, false);
  });
  await check("evaluation run on a NOT-yet-medical approved model; key compared; nothing in the Question Bank changes", async () => {
    const fpBefore = await fingerprint();
    const q = await quote.createQuote({ feature: "explanation_admin", action: "explanation_admin", context: { evalSize: 3 }, actorId: admin.id, model: "mockai/cheap", units: 3, evaluation: true });
    assert.equal(q.runnable, true, q.blockReason ?? "");
    assert.equal(q.calls, 3);
    const c = await quote.consumeQuote({ quoteId: q.id, actorId: admin.id, feature: "explanation_admin", action: "model_eval", context: { evalSize: 3 } });
    const r = await evalMod.runModelEvaluation({ model: c.model!, n: 3, actorId: admin.id, quoteId: c.id });
    assert.equal(r.n, 3);
    assert.equal(r.jsonOk, 3);
    assert.ok(r.costInr !== null && r.costInr > 0);
    assert.equal(await fingerprint(), fpBefore);
    assert.equal((await evalMod.listEvaluations())[0].model, "mockai/cheap");
  });

  console.log("\nM. Safety");
  await check("no outbound request left the machine (loopback only)", () => {
    assert.ok(outbound.length > 0);
    assert.ok(outbound.every((u) => u.startsWith("http://127.0.0.1:")));
  });
  await check("the API key never appeared in any log line", () => {
    assert.ok(!logged.some((l) => l.includes(validKey.slice(12, 40))));
  });
  await check("questions, options and PYQ papers unchanged by the whole suite", async () => {
    assert.equal(await fingerprint(), before);
  });

  await resetAll();
  mock.server.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
