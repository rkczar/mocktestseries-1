/**
 * AI reliability (2026-10-29) — structured output, task-aware routing, retries,
 * fallback, deadlines, circuit breaker, provider policy (OpenRouter → Gemini
 * fallback, no direct Claude / OpenAI) and warn-only
 * budgets. Part A is pure (no DB, no network). Part B runs the real AI Engine
 * against the LOCAL OpenRouter mock (scripts/mock-openrouter.mjs): never talks
 * to OpenRouter, keys are fake, every outbound fetch must be loopback. Part B
 * runs only on an *igstudio* scratch database (seed + ig-studio-fixture setup).
 *
 *   set -a; . <scratch env>; set +a
 *   MOCK_OPENROUTER_PORT=3732 NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-ai-reliability.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { extractJsonObject, isClassifierVerdict, jsonCheck, nonEmptyString } from "@/lib/ai-engine/structured";
import { FEATURE_PROFILE, TASK_PROFILES, nonGenerativeReason, profileFor } from "@/lib/ai-engine/profiles";
import { aiErrorCode, isOutputFailure } from "@/lib/ai-engine/errors";
import { parseRetryAfter } from "@/lib/ai-engine/openrouter";
import { AI_FEATURE_KEYS } from "@/lib/ai-gateway-config";

const PORT = Number(process.env.MOCK_OPENROUTER_PORT ?? 3732);
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
    return e as Error & { category?: string; requestId?: string };
  }
};

// Every outbound request must stay on loopback (no real provider can be reached, nothing can be billed).
// Gemini's fixed URL is answered IN-PROCESS by a stub (never sent): "ok" = a valid explanation, "fail" = HTTP 500.
const realFetch = globalThis.fetch;
const gemini = { mode: "ok" as "ok" | "fail", calls: 0 };
const GEMINI_EXPLANATION = JSON.stringify({ concept: "Timolol is a beta blocker that lowers IOP by reducing aqueous humour production by the ciliary body." });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/") && url.includes(":generateContent")) {
    gemini.calls++;
    if (gemini.mode === "fail") return new Response(JSON.stringify({ error: { message: "stub internal error" } }), { status: 500, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: GEMINI_EXPLANATION }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 30 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!/^(http:\/\/127\.0\.0\.1:\d+|data:)/.test(url)) throw new Error(`BLOCKED non-loopback fetch: ${url}`);
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

async function partA() {
  console.log("\nA1. Structured output reader");
  const ok = (t: string) => extractJsonObject(t);
  await check("plain object", () => assert.deepEqual(ok('{"a":1}'), { ok: true, value: { a: 1 }, wrapped: false }));
  await check("whitespace + BOM", () => assert.equal(ok('﻿  \n{"a":1}\n ').ok, true));
  await check("```json fenced block", () => {
    const r = ok('```json\n{"a":"x"}\n```');
    assert.ok(r.ok && r.value.a === "x" && r.wrapped);
  });
  await check("short chatter before and after", () => assert.equal(ok('Here you go:\n{"a":1}\nHope this helps!').ok, true));
  await check("braces inside strings do not end the object", () => {
    const r = ok('{"a":"x } y { z","b":"\\"}\\""}');
    assert.ok(r.ok && r.value.a === "x } y { z");
  });
  await check("two objects are never glued (first one wins, not a greedy span)", () => {
    const r = ok('{"a":1} and also {"b":2}');
    assert.ok(r.ok && r.value.a === 1 && !("b" in r.value));
  });
  await check("empty → empty_response", () => assert.equal((ok("   ") as { category: string }).category, "empty_response"));
  await check("prose only → invalid_json", () => assert.equal((ok("Sure! The answer is B because…") as { category: string }).category, "invalid_json"));
  await check("cut off → truncated", () => assert.equal((ok('{"concept": "Acute angle-closure glaucoma presents with') as { category: string }).category, "truncated"));
  await check("syntax error → invalid_json", () => assert.equal((ok('{"a": 1,, "b": 2}') as { category: string }).category, "invalid_json"));
  await check("top-level array → invalid_json (one object expected)", () => assert.equal((ok("[1,2]") as { category: string }).category, "invalid_json"));
  await check("classifier verdicts → non_answer", () => {
    for (const t of ["User Safety: safe", "Response Safety: unsafe", "safe", "unsafe\nS1, S10", '{"User Safety": "safe"}']) assert.equal((ok(t) as { category: string }).category, "non_answer", t);
    assert.equal(isClassifierVerdict("A safe dose of paracetamol is…"), false);
  });
  await check("object buried in long prose → invalid_json", () => assert.equal((ok(`${"x".repeat(600)} {"a":1}`) as { category: string }).category, "invalid_json"));

  console.log("\nA2. Schema checks");
  const conceptCheck = jsonCheck((o) => (nonEmptyString(o.concept) ? null : "concept missing"));
  await check("extra fields are allowed, required fields are enforced", () => {
    assert.deepEqual(conceptCheck('{"concept":"x","extra":true}'), { ok: true });
    const bad = conceptCheck('{"memoryTrick":"x"}');
    assert.ok(!bad.ok && bad.category === "schema_invalid");
  });
  await check("invalid types fail the schema", () => {
    const bad = conceptCheck('{"concept": 42}');
    assert.ok(!bad.ok && bad.category === "schema_invalid");
  });
  const { explanationCheck } = await import("@/lib/ai-explanation");
  await check("explanation check rejects the 2026-10 'User Safety' answers and empty concepts", () => {
    assert.equal(explanationCheck("User Safety: safe").ok, false);
    assert.equal(explanationCheck('{"concept":"User Safety: safe"}').ok, false);
    assert.equal(explanationCheck('{"concept":""}').ok, false);
    assert.equal(explanationCheck('{"concept":"Timolol lowers IOP by reducing aqueous production."}').ok, true);
  });
  const { carouselCheck } = await import("@/lib/instagram/ai");
  await check("carousel check needs one JSON object with answerLabel", () => {
    assert.equal(carouselCheck('{"answerLabel":"B","explanation":"x"}').ok, true);
    assert.equal(carouselCheck('{"explanation":"x"}').ok, false);
    assert.equal(carouselCheck("User Safety: safe").ok, false);
  });
  const { extractJson: videoExtract } = await import("@/lib/video-studio/script");
  await check("video reader keeps its job messages (no JSON object / cut off)", () => {
    assert.throws(() => videoExtract("User Safety: safe"));
    assert.throws(() => videoExtract("no json here"), /contains no JSON object/);
    assert.throws(() => videoExtract('{"scenes":[{"narration":"a'), /incomplete \(cut off\)/);
    assert.deepEqual(videoExtract('```json\n{"title":"t"}\n```'), { title: "t" });
  });

  console.log("\nA3. Task profiles and model exclusions");
  await check("every feature has a task profile; interactive deadlines stay under the 60 s proxy timeout", () => {
    for (const f of AI_FEATURE_KEYS) assert.ok(FEATURE_PROFILE[f], f);
    for (const f of ["explanation", "variant", "ig_carousel", "ig_topic", "ig_caption", "ig_trap"] as const) assert.ok(profileFor(f).deadlineMs < 60_000, f);
    assert.equal(profileFor("ig_image").output, "image");
  });
  await check("registry ids are well-formed, not :free and not :batch", () => {
    for (const p of Object.values(TASK_PROFILES)) for (const id of p.preferred) assert.ok(/^[a-z0-9-]+\/[a-z0-9.-]+$/.test(id) && !id.endsWith(":free") && !id.endsWith(":batch"), id);
  });
  await check("non-generative models are excluded with a reason (prod 2026-10 ids)", () => {
    assert.match(nonGenerativeReason("nvidia/nemotron-3.5-content-safety:free") ?? "", /classifier/);
    assert.match(nonGenerativeReason("meta-llama/llama-guard-4-12b") ?? "", /classifier/);
    assert.match(nonGenerativeReason("openai/gpt-5-nano:batch") ?? "", /batch/);
    assert.match(nonGenerativeReason("openrouter/free") ?? "", /meta-router/);
    assert.match(nonGenerativeReason("google/lyria-3-pro-preview", ["text", "audio"]) ?? "", /audio|music/);
    for (const g of ["anthropic/claude-haiku-5.5", "google/gemini-3.6-flash", "nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-5.6-luna", "openai/gpt-oss-safeguard-20b".replace("safeguard", "120b")]) assert.equal(nonGenerativeReason(g), null, g);
  });
  const { rankForTask, healthRank } = await import("@/lib/ai-engine/router");
  await check("Task-aware order: registry first, then healthy paid, free only as last resort", () => {
    const c = (id: string, usd: number) => ({ model: { id }, typicalUsd: usd });
    const health = new Map([
      ["vendor/flaky", { okRate: 0.4, avgMs: 2000, n: 10 }],
      ["vendor/steady", { okRate: 1, avgMs: 3000, n: 10 }],
    ]);
    const order = rankForTask("explanation", [c("vendor/flaky", 0.0001), c("vendor/steady", 0.0002), c("anthropic/claude-haiku-5.5", 0.0009), c("x/free-one:free", 0)], health).map((x) => x.model.id);
    assert.deepEqual(order, ["anthropic/claude-haiku-5.5", "vendor/steady", "vendor/flaky"]);
    const onlyFree = rankForTask("explanation", [c("x/a:free", 0), c("x/b:free", 0)], new Map([["x/a:free", { okRate: 0.1, avgMs: 900_000, n: 20 }]])).map((x) => x.model.id);
    assert.deepEqual(onlyFree, ["x/b:free", "x/a:free"]);
  });
  await check("health rank: slow (> 45 s) or failing (< 80 %) ranks last; unknown is neutral", () => {
    const h = new Map([
      ["a", { okRate: 1, avgMs: 200_000, n: 9 }],
      ["b", { okRate: 1, avgMs: 2_000, n: 9 }],
    ]);
    assert.deepEqual([healthRank(h, "a"), healthRank(h, "b"), healthRank(h, "c")], [2, 0, 1]);
  });

  console.log("\nA4. Retry timing and error codes");
  const { backoffMs, checkOutput } = await import("@/lib/ai-engine/engine");
  await check("Retry-After seconds / HTTP date / absent", () => {
    assert.equal(parseRetryAfter("2"), 2000);
    assert.equal(parseRetryAfter("9999"), 300_000);
    assert.equal(parseRetryAfter(new Date(Date.now() + 3000).toUTCString(), Date.now()) !== null, true);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(parseRetryAfter("soon"), null);
  });
  await check("backoff: exponential with ±25 % jitter, capped at 8 s, Retry-After wins", () => {
    assert.equal(backoffMs(1, null, () => 0.5), 1000);
    assert.equal(backoffMs(3, null, () => 0.5), 4000);
    assert.equal(backoffMs(9, null, () => 0.5), 8000);
    assert.equal(backoffMs(1, null, () => 0), 750);
    assert.equal(backoffMs(1, null, () => 1), 1250);
    assert.equal(backoffMs(2, 1500), 1500);
  });
  await check("output check: empty / reasoning-only / cut off / verdict / json", () => {
    assert.equal(checkOutput("", "stop", false, {})?.category, "empty_response");
    assert.equal(checkOutput("", "length", true, {})?.category, "truncated");
    assert.equal(checkOutput("Some long prose", "length", false, {})?.category, "truncated");
    assert.equal(checkOutput("User Safety: safe", "stop", false, {})?.category, "non_answer");
    assert.equal(checkOutput("plain prose", "stop", false, { json: true })?.category, "invalid_json");
    assert.equal(checkOutput('{"a":1}', "stop", false, { json: true }), null);
    assert.equal(checkOutput("Plain answer.", "stop", false, {}), null);
  });
  await check("normalized error codes", () => {
    assert.equal(aiErrorCode("auth_invalid"), "PROVIDER_AUTH_ERROR");
    assert.equal(aiErrorCode("rate_limited"), "PROVIDER_RATE_LIMIT");
    assert.equal(aiErrorCode("no_endpoint"), "MODEL_UNAVAILABLE");
    assert.equal(aiErrorCode("timeout"), "REQUEST_TIMEOUT");
    assert.equal(aiErrorCode("invalid_json"), "INVALID_JSON");
    assert.equal(aiErrorCode("schema_invalid"), "SCHEMA_VALIDATION_FAILED");
    assert.equal(aiErrorCode("non_answer"), "NON_ANSWER_MODEL");
    assert.equal(aiErrorCode("RENDERING_FAILED"), "RENDERING_FAILED");
    assert.equal(aiErrorCode("something_new"), "PROVIDER_ERROR");
    assert.equal(aiErrorCode(null), null);
    assert.ok(isOutputFailure("truncated") && !isOutputFailure("rate_limited"));
  });

  console.log("\nA5. Provider-usage audit (no direct provider calls outside approved adapters)");
  await check("provider hosts / SDKs appear only in approved adapter files", () => {
    const APPROVED: Record<string, string[]> = {
      "openrouter.ai": ["lib/ai-engine/openrouter.ts"],
      "generativelanguage.googleapis.com": ["lib/ai-provider.ts", "lib/gemini-config.ts", "lib/instagram/medical-image.ts"],
      "api.openai.com": ["lib/ai-provider.ts", "lib/openai-config.ts"],
      "api.anthropic.com": ["lib/anthropic-client.ts"],
      "@anthropic-ai/sdk": ["lib/anthropic-client.ts"],
      "@google/genai": [],
      "openai\"": [],
    };
    const roots = ["app", "lib", "components"];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(n)) files.push(p);
      }
    };
    roots.forEach(walk);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const [needle, allowed] of Object.entries(APPROVED)) {
        const hit = needle === 'openai"' ? /from "openai"/.test(src) : src.includes(needle);
        if (hit && !allowed.includes(f)) offenders.push(`${f}: ${needle}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
  await check("provider policy defaults: Gemini fallback on, direct Claude / OpenAI off", async () => {
    const { normalizeRuntime } = await import("@/lib/ai-engine/config");
    assert.deepEqual(normalizeRuntime(undefined), { geminiFallback: true, directClaudeOpenAi: false });
    assert.deepEqual(normalizeRuntime({ legacyProviders: true }), { geminiFallback: true, directClaudeOpenAi: false });
    assert.deepEqual(normalizeRuntime({ geminiFallback: false, directClaudeOpenAi: true }), { geminiFallback: false, directClaudeOpenAi: true });
    const gw = readFileSync("lib/ai-gateway.ts", "utf8");
    assert.match(gw, /isDirectProviderBlocked\(ctx\.providerOverride, runtime\)/);
    assert.match(gw, /chain = chain\.filter\(\(p\) => !isDirectProviderBlocked\(p, runtime\)\)/);
  });
}

async function partB() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!dbName.includes("igstudio")) {
    console.log(`\nB. skipped: database "${dbName}" is not an igstudio scratch database.`);
    return;
  }
  const { prisma } = await import("@/lib/prisma");
  const { startMockOpenRouter, mockKey } = (await import("./mock-openrouter.mjs")) as { startMockOpenRouter: (p: number) => Promise<{ server: import("node:http").Server }>; mockKey: (s: string) => string };
  const settings = await import("@/lib/ai-engine/settings");
  const cfgMod = await import("@/lib/ai-engine/config");
  const catalog = await import("@/lib/ai-engine/catalog");
  const router = await import("@/lib/ai-engine/router");
  const engine = await import("@/lib/ai-engine/engine");
  const gateway = await import("@/lib/ai-gateway");
  const mock = await startMockOpenRouter(PORT);
  const stats = async () => (await (await realFetch(`http://127.0.0.1:${PORT}/__mock/stats`)).json()) as { chat: number; bodies: { model?: string; models?: string[]; response_format?: unknown; reasoning?: unknown }[] };
  const resetMock = () => realFetch(`http://127.0.0.1:${PORT}/__mock/reset`, { method: "POST" });

  try {
    const KEYS = ["api.openrouter", "ai.engine", "ai.fx", "ai.gateway", "ai.settings", "api.gemini", "api.openai", "api.anthropic"];
    await prisma.setting.deleteMany({ where: { key: { in: KEYS } } });
    await prisma.aiGatewayCall.deleteMany({});
    await prisma.aiBudgetReservation.deleteMany({});
    await prisma.aiModel.deleteMany({});
    await settings.saveOpenRouterKey(mockKey("valid"));
    await prisma.$executeRaw`UPDATE "Setting" SET "value" = "value" || jsonb_build_object('enabled', true, 'lastTest', jsonb_build_object('ok', true, 'category', 'ok', 'message', 'ok', 'at', '2026-01-01T00:00:00Z')) WHERE "key" = 'api.openrouter'`;
    await catalog.syncCatalog();
    const approve = (ids: string[], medical = true) => prisma.aiModel.updateMany({ where: { id: { in: ids } }, data: { approved: true, medicallyApproved: medical } });
    const onlyApproved = async (ids: string[]) => {
      await prisma.aiModel.updateMany({ data: { approved: false, medicallyApproved: false } });
      await approve(ids);
      await prisma.aiGatewayCall.deleteMany({});
      await resetMock();
    };
    const setFeature = async (f: "explanation" | "ig_carousel" | "ig_caption", patch: Partial<import("@/lib/ai-engine/config").FeatureEngineConfig>) =>
      settings.saveFeatureConfig(f, { ...cfgMod.DEFAULT_FEATURE_CONFIG, provider: "openrouter", ...patch });
    await setFeature("explanation", { mode: "cheapest" });
    await setFeature("ig_carousel", { mode: "cheapest" });
    await prisma.setting.upsert({ where: { key: "ai.settings" }, update: { value: { askAiEnabled: true } }, create: { key: "ai.settings", value: { askAiEnabled: true } } });
    const { explanationCheck } = await import("@/lib/ai-explanation");
    const EXPL_PROMPT = 'You are an expert exam tutor helping a student understand a multiple-choice question.\n\nQuestion:\nWhich drug lowers IOP by reducing aqueous production?\n\nOptions:\nA. Timolol\nB. Pilocarpine\nC. Latanoprost\nD. Atropine\n\nThe correct answer is A.\n\nRespond with ONLY a JSON object (no markdown fences) with these keys:\n- "concept": why the correct option is right (under 60 words)';
    const opts = { temperature: 0.4, maxOutputTokens: 1400, json: true, check: explanationCheck };

    console.log("\nB1. Eligibility and routing");
    await check("a classifier id is never a candidate, even when approved", async () => {
      await onlyApproved(["mockai/x-content-safety", "mockai/cheap"]);
      const c = await router.textCandidates("explanation", 400, 1400, 700);
      assert.deepEqual(c.map((x) => x.model.id), ["mockai/cheap"]);
      const row = await prisma.aiModel.findUniqueOrThrow({ where: { id: "mockai/x-content-safety" } });
      assert.match(router.textEligibility(row, "explanation", 400, 1400).reason ?? "", /classifier/);
    });

    console.log("\nB2. Unusable answers move to the next compatible model (one request id)");
    for (const [bad, cat] of [["mockai/verdict", "non_answer"], ["mockai/prose", "invalid_json"], ["mockai/cutoff", "truncated"], ["mockai/thinker", "truncated"]] as const) {
      await check(`${bad} answers → ${cat}, logged as failed, then mockai/cheap answers`, async () => {
        await onlyApproved([bad, "mockai/cheap"]);
        await setFeature("explanation", { mode: "manual", model: bad, fallbacks: ["mockai/cheap"] });
        const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
        assert.equal(r.model, "mockai/cheap");
        assert.equal(r.attempts, 2);
        assert.equal(r.fallbackUsed, true);
        assert.ok(explanationCheck(r.text).ok);
        const rows = await prisma.aiGatewayCall.findMany({ where: { feature: "explanation" }, orderBy: { createdAt: "asc" } });
        assert.equal(rows.length, 2);
        assert.equal(new Set(rows.map((x) => x.requestId)).size, 1, "one correlation id");
        assert.deepEqual([rows[0].ok, rows[0].errorCategory, rows[1].ok], [false, cat, true]);
        const s = await stats();
        assert.deepEqual(s.bodies[1].models ?? [s.bodies[1].model], ["mockai/cheap"], "the failing model is not asked again");
      });
    }
    await check("JSON mode is requested where supported; the reasoning bound only where accepted", async () => {
      await onlyApproved(["mockai/thinker", "mockai/cheap"]);
      await setFeature("explanation", { mode: "manual", model: "mockai/thinker", fallbacks: ["mockai/cheap"] });
      await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
      const s = await stats();
      assert.deepEqual(s.bodies[0].response_format, { type: "json_object" });
      assert.deepEqual(s.bodies[0].reasoning, { max_tokens: 350, exclude: true });
      assert.equal(s.bodies[1].reasoning, undefined);
    });
    await check("every model unusable → a failure with its category; nothing returned as success", async () => {
      await onlyApproved(["mockai/verdict", "mockai/prose"]);
      await setFeature("ig_carousel", { mode: "manual", model: "mockai/verdict", fallbacks: ["mockai/prose"] });
      const e = await thrown(() => gateway.generateForFeature("ig_carousel", "You write Instagram carousel content for MockTestSeries.in", { temperature: 0.5, maxOutputTokens: 3000, json: true, check: explanationCheck }));
      assert.ok(e instanceof gateway.AiProviderFailure, String(e));
      assert.equal(e!.category, "invalid_json");
      assert.ok(e!.requestId);
      assert.equal(await prisma.aiGatewayCall.count({ where: { ok: true } }), 0);
    });

    console.log("\nB3. Retries, Retry-After and deadlines");
    await check("429 with Retry-After: 1 → waits ~1 s, retries once, succeeds", async () => {
      await onlyApproved(["mockai/retry429"]);
      await setFeature("explanation", { mode: "manual", model: "mockai/retry429", fallbacks: [], maxRetries: 1 });
      const t0 = Date.now();
      const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
      const dt = Date.now() - t0;
      assert.equal(r.attempts, 2);
      assert.ok(dt >= 950 && dt < 5000, `waited ${dt} ms`);
      const rows = await prisma.aiGatewayCall.findMany({ orderBy: { createdAt: "asc" } });
      assert.deepEqual(rows.map((x) => [x.ok, x.errorCategory]), [[false, "rate_limited"], [true, null]]);
    });
    await check("maxRetries 0 → a 429 is not retried", async () => {
      await onlyApproved(["mockai/retry429"]);
      await setFeature("explanation", { mode: "manual", model: "mockai/retry429", fallbacks: [], maxRetries: 0 });
      const e = await thrown(() => gateway.generateForFeature("explanation", EXPL_PROMPT, opts));
      assert.ok(e);
      assert.equal(await prisma.aiGatewayCall.count({}), 1);
    });
    await check("the timeout covers the body read (headers at once, body over 8 s → stops at the 5 s deadline)", async () => {
      await onlyApproved(["mockai/drip"]);
      await settings.saveFeatureConfig("ig_caption", { ...cfgMod.DEFAULT_FEATURE_CONFIG, provider: "openrouter", mode: "manual", model: "mockai/drip", timeoutMs: 5000, maxRetries: 0 });
      const t0 = Date.now();
      const e = await thrown(() => engine.generateTextViaOpenRouter("ig_caption", "caption please", { temperature: 0.5, maxOutputTokens: 500 }));
      const dt = Date.now() - t0;
      assert.ok(e, "must fail");
      assert.equal((e as { category?: string }).category, "timeout");
      assert.ok(dt < 7000, `took ${dt} ms`);
    });
    await check("whole-request deadline is respected across attempts", async () => {
      await onlyApproved(["mockai/slow", "mockai/cheap"]);
      await setFeature("explanation", { mode: "manual", model: "mockai/slow", fallbacks: [], maxRetries: 2 });
      const t0 = Date.now();
      const e = await thrown(() => engine.generateTextViaOpenRouter("explanation", EXPL_PROMPT, opts, { deadlineMs: 3000 }));
      assert.ok(e);
      assert.ok(Date.now() - t0 < 5000);
    });

    console.log("\nB4. Circuit breaker");
    await check("3 consecutive own failures put a model in cooldown; it is skipped", async () => {
      await onlyApproved(["mockai/mid", "mockai/cheap"]);
      for (let i = 0; i < 3; i++) await prisma.aiGatewayCall.create({ data: { feature: "explanation", provider: "openrouter", model: "mockai/cheap", ok: false, errorCategory: "provider_error", latencyMs: 10, kind: "text", routingMode: "cheapest", attempt: 1 } });
      const c = await router.textCandidates("explanation", 400, 1400, 700);
      assert.deepEqual(c.map((x) => x.model.id), ["mockai/mid"]);
    });
    await check("credit / auth failures do not trip the breaker (no other model would fix them)", async () => {
      await onlyApproved(["mockai/mid", "mockai/cheap"]);
      for (let i = 0; i < 3; i++) await prisma.aiGatewayCall.create({ data: { feature: "explanation", provider: "openrouter", model: "mockai/cheap", ok: false, errorCategory: "insufficient_credits", latencyMs: 10, kind: "text", routingMode: "cheapest", attempt: 1 } });
      const c = await router.textCandidates("explanation", 400, 1400, 700);
      assert.ok(c.some((x) => x.model.id === "mockai/cheap"));
    });

    console.log("\nB5. Equal prices are broken by health, not by name");
    await check("cheapest mode: a failing model with the same price ranks after a healthy one", async () => {
      await onlyApproved(["mockai/cheap", "mockai/verdict"]);
      await prisma.aiModel.updateMany({ where: { id: { in: ["mockai/cheap", "mockai/verdict"] } }, data: { promptPrice: 0, completionPrice: 0 } });
      // "mockai/cheap" < "mockai/verdict" alphabetically; give cheap 2 failures + 1 ok (67 %, not a cooldown).
      for (const ok of [false, true, false]) await prisma.aiGatewayCall.create({ data: { feature: "ig_trap", provider: "openrouter", model: "mockai/cheap", ok, errorCategory: ok ? null : "empty_response", latencyMs: 1000, kind: "text", routingMode: "cheapest", attempt: 1 } });
      for (let i = 0; i < 3; i++) await prisma.aiGatewayCall.create({ data: { feature: "ig_trap", provider: "openrouter", model: "mockai/verdict", ok: true, latencyMs: 1000, kind: "text", routingMode: "cheapest", attempt: 1 } });
      const c = await router.textCandidates("explanation", 400, 1400, 700);
      assert.deepEqual(c.map((x) => x.model.id), ["mockai/verdict", "mockai/cheap"]);
      await catalog.syncCatalog();
    });

    console.log("\nB6. Provider policy: OpenRouter first, Gemini fallback, no direct Claude / OpenAI");
    const { saveGeminiConfig, bumpGeminiConfigEpoch } = await import("@/lib/gemini-config");
    const geminiOn = async () => {
      await saveGeminiConfig({ enabled: true, apiKey: "AIza-fake-test-key-not-real-000000000", model: "gemini-stub-flash" });
      bumpGeminiConfigEpoch();
      gemini.mode = "ok";
      gemini.calls = 0;
    };
    await check("a per-request Claude or OpenAI override is refused with a clear message (nothing sent)", async () => {
      await onlyApproved(["mockai/cheap"]);
      await setFeature("ig_carousel", { mode: "cheapest" });
      for (const p of ["anthropic", "openai"] as const) {
        const e = await thrown(() => gateway.generateForFeature("ig_carousel", "x", { temperature: 0.5, maxOutputTokens: 100 }, { providerOverride: p }));
        assert.match(e?.message ?? "", /calls are switched off: .* models run through OpenRouter/);
      }
      assert.equal((await stats()).chat, 0);
      assert.equal(await gateway.isGatewayProviderUsable("anthropic"), false);
      assert.equal(await gateway.isGatewayProviderUsable("openai"), false);
    });
    await check("OpenRouter answers first; Gemini is not called when OpenRouter succeeds", async () => {
      await geminiOn();
      await onlyApproved(["mockai/cheap"]);
      await setFeature("explanation", { mode: "cheapest" });
      const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
      assert.equal(r.provider, "openrouter");
      assert.equal(gemini.calls, 0);
    });
    await check("every OpenRouter model fails → Gemini answers, logged under the same request id", async () => {
      await geminiOn();
      await onlyApproved(["mockai/verdict"]);
      await setFeature("explanation", { mode: "manual", model: "mockai/verdict", fallbacks: [] });
      const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
      assert.equal(r.provider, "gemini");
      assert.equal(r.fallbackUsed, true);
      assert.ok(explanationCheck(r.text).ok);
      assert.equal(gemini.calls, 1);
      const rows = await prisma.aiGatewayCall.findMany({ where: { feature: "explanation" }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(rows.map((x) => [x.provider, x.ok]), [["openrouter", false], ["gemini", true]]);
      assert.equal(rows[1].routingMode, "gemini_fallback");
      assert.equal(new Set(rows.map((x) => x.requestId)).size, 1, "one correlation id");
    });
    await check("no eligible OpenRouter model (not configured) → Gemini answers", async () => {
      await geminiOn();
      await onlyApproved([]);
      await setFeature("explanation", { mode: "cheapest" });
      const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
      assert.equal(r.provider, "gemini");
      assert.equal((await stats()).chat, 0);
    });
    await check("OpenRouter and Gemini both fail → admin sees both reasons; students the generic message", async () => {
      await geminiOn();
      gemini.mode = "fail";
      await onlyApproved(["mockai/verdict"]);
      await setFeature("ig_carousel", { mode: "manual", model: "mockai/verdict", fallbacks: [] });
      const e = await thrown(() => gateway.generateForFeature("ig_carousel", "Return JSON", { temperature: 0.5, maxOutputTokens: 300, json: true }));
      assert.match(e?.message ?? "", /OpenRouter failed: .*Gemini fallback also failed/);
      await setFeature("explanation", { mode: "manual", model: "mockai/verdict", fallbacks: [] });
      const s = await thrown(() => gateway.generateForFeature("explanation", EXPL_PROMPT, opts));
      assert.match(s?.message ?? "", /could not answer right now/);
      assert.ok(gemini.calls >= 2);
    });
    await check("Gemini fallback switched off → no Gemini call, OpenRouter's error stands", async () => {
      await geminiOn();
      await settings.saveRuntime({ geminiFallback: false, directClaudeOpenAi: false });
      await onlyApproved(["mockai/verdict"]);
      await setFeature("ig_carousel", { mode: "manual", model: "mockai/verdict", fallbacks: [] });
      const e = await thrown(() => gateway.generateForFeature("ig_carousel", "Return JSON", { temperature: 0.5, maxOutputTokens: 300, json: true }));
      assert.match(e?.message ?? "", /OpenRouter failed/);
      assert.doesNotMatch(e?.message ?? "", /Gemini/);
      assert.equal(gemini.calls, 0);
      await settings.saveRuntime({ geminiFallback: true, directClaudeOpenAi: false });
    });
    await check("a budget refusal (enforcement stop) never falls back to Gemini", async () => {
      await geminiOn();
      await onlyApproved(["mockai/cheap"]);
      await setFeature("ig_carousel", { mode: "cheapest" });
      await settings.saveBudgets(cfgMod.normalizeBudgets({ dailyInr: 0.000001, enforcement: "stop" }));
      const e = await thrown(() => gateway.generateForFeature("ig_carousel", "Return JSON", { temperature: 0.5, maxOutputTokens: 300, json: true }));
      assert.match(e?.message ?? "", /budget/i);
      assert.equal(gemini.calls, 0);
      await settings.saveBudgets(cfgMod.normalizeBudgets({}));
    });
    await check("an explicit Gemini choice still works (existing Gemini integration preserved)", async () => {
      await geminiOn();
      await setFeature("explanation", { mode: "cheapest" });
      const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts, { providerOverride: "gemini" });
      assert.equal(r.provider, "gemini");
      assert.equal(gemini.calls, 1);
    });
    await check("legacy default route with OpenAI as the active provider uses Gemini, never OpenAI", async () => {
      await geminiOn();
      await prisma.setting.upsert({ where: { key: "ai.settings" }, update: { value: { askAiEnabled: true, activeProvider: "openai", fallbackProvider: "gemini" } }, create: { key: "ai.settings", value: { askAiEnabled: true, activeProvider: "openai", fallbackProvider: "gemini" } } });
      await settings.saveFeatureConfig("explanation", { ...cfgMod.DEFAULT_FEATURE_CONFIG, provider: "legacy" });
      const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
      assert.equal(r.provider, "gemini");
      await prisma.setting.upsert({ where: { key: "ai.settings" }, update: { value: { askAiEnabled: true } }, create: { key: "ai.settings", value: { askAiEnabled: true } } });
      await setFeature("explanation", { mode: "cheapest" });
    });
    await check("a custom route of Claude → OpenAI only is refused; Claude → Gemini skips Claude", async () => {
      await geminiOn();
      await settings.saveFeatureConfig("ig_carousel", { ...cfgMod.DEFAULT_FEATURE_CONFIG, provider: "legacy" });
      await gateway.saveGatewayConfig({ routes: { ig_carousel: { mode: "custom", primary: "anthropic", fallback1: "openai", fallback2: "none", timeoutMs: 20000, maxRetries: 0, dailyCap: null } } });
      const e = await thrown(() => gateway.generateForFeature("ig_carousel", "x", { temperature: 0.5, maxOutputTokens: 100 }));
      assert.match(e?.message ?? "", /routed only to direct Claude \/ OpenAI/);
      await gateway.saveGatewayConfig({ routes: { ig_carousel: { mode: "custom", primary: "anthropic", fallback1: "gemini", fallback2: "none", timeoutMs: 20000, maxRetries: 0, dailyCap: null } } });
      const r = await gateway.generateForFeature("ig_carousel", EXPL_PROMPT, { temperature: 0.5, maxOutputTokens: 300 });
      assert.equal(r.provider, "gemini");
      await prisma.setting.deleteMany({ where: { key: "ai.gateway" } });
      await setFeature("ig_carousel", { mode: "cheapest" });
    });
    await check("feature counts as configured with Gemini only (OpenRouter key missing)", async () => {
      await geminiOn();
      const keep = await prisma.setting.findUniqueOrThrow({ where: { key: "api.openrouter" } });
      await prisma.setting.delete({ where: { key: "api.openrouter" } });
      try {
        assert.equal(await gateway.isFeatureConfigured("ig_carousel"), true);
        await settings.saveRuntime({ geminiFallback: false, directClaudeOpenAi: false });
        assert.equal(await gateway.isFeatureConfigured("ig_carousel"), false);
      } finally {
        await prisma.setting.create({ data: { key: keep.key, value: keep.value as object } });
        await settings.saveRuntime({ geminiFallback: true, directClaudeOpenAi: false });
      }
    });
    await prisma.setting.deleteMany({ where: { key: "api.gemini" } });
    bumpGeminiConfigEpoch();

    console.log("\nB7. Budgets warn by default (spend still recorded)");
    await check("daily budget reached + enforcement warn → the request runs; the reservation is settled", async () => {
      await onlyApproved(["mockai/cheap"]);
      await setFeature("explanation", { mode: "cheapest" });
      await settings.saveBudgets(cfgMod.normalizeBudgets({ dailyInr: 0.000001 }));
      const r = await gateway.generateForFeature("explanation", EXPL_PROMPT, opts);
      assert.equal(r.model, "mockai/cheap");
      assert.ok((await prisma.aiBudgetReservation.count({ where: { status: "SETTLED" } })) >= 1);
    });
    await check("enforcement stop still refuses (configurable back)", async () => {
      await settings.saveBudgets(cfgMod.normalizeBudgets({ dailyInr: 0.000001, enforcement: "stop" }));
      const e = await thrown(() => gateway.generateForFeature("explanation", EXPL_PROMPT, opts));
      assert.ok(e);
      await settings.saveBudgets(cfgMod.normalizeBudgets({}));
    });

    console.log("\nB8. End to end: a cached student explanation can no longer be a classifier verdict");
    await check("getOrCreateExplanation with the classifier as first choice stores the fallback's real explanation", async () => {
      const { getOrCreateExplanation } = await import("@/lib/ai-explanation");
      await onlyApproved(["mockai/verdict", "mockai/cheap"]);
      await setFeature("explanation", { mode: "manual", model: "mockai/verdict", fallbacks: ["mockai/cheap"] });
      // A question WITHOUT an explanation (the IG fixtures own the reviewed ones; never touch them).
      const taken = (await prisma.aIExplanation.findMany({ select: { questionId: true } })).map((x) => x.questionId);
      const q = await prisma.question.findFirstOrThrow({ where: { options: { some: { isCorrect: true } }, id: { notIn: taken } }, select: { id: true } });
      const row = await getOrCreateExplanation(q.id);
      const stored = await prisma.aIExplanation.findUniqueOrThrow({ where: { questionId: q.id } });
      assert.equal(stored.status, "COMPLETED", JSON.stringify(row).slice(0, 200));
      assert.equal(stored.model, "mockai/cheap");
      assert.doesNotMatch(JSON.stringify(stored.content), /User Safety/);
      await prisma.aIExplanation.deleteMany({ where: { questionId: q.id } });
    });
  } finally {
    // Leave no AI routing behind (other suites set up their own): the same keys this part cleared at start.
    await prisma.setting.deleteMany({ where: { key: { in: ["api.openrouter", "ai.engine", "ai.fx", "ai.gateway", "ai.settings", "api.gemini", "api.openai", "api.anthropic"] } } });
    await prisma.aiModel.deleteMany({});
    mock.server.close();
    await prisma.$disconnect();
  }
}

(async () => {
  await partA();
  await partB();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
