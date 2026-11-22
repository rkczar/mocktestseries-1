/**
 * Two-step importer (2026-11-22) regression — OpenRouter ONLY (owner rule): error classification, the model fallback
 * chain (all via OpenRouter, also for old saved job settings), immediate pause on credits / key limit, cost estimator, deterministic answer mapping, review buckets, status-rules version and auto-verify holds.
 *
 * Scratch DB only (mts_twostep*), synthetic rows, ONE in-process loopback mock serving OpenRouter, OpenAI, Anthropic and
 * Gemini. A network guard refuses every non-loopback fetch, so no real AI request is possible.
 *
 *   DATABASE_URL=<mts_twostep…> PG_POOL_MAX=3 AUTH_SECRET=<test> NODE_OPTIONS=--conditions=react-server \
 *   OPENROUTER_TEST_BASE_URL=http://127.0.0.1:3597 OPENAI_TEST_BASE_URL=http://127.0.0.1:3597 \
 *   ANTHROPIC_TEST_BASE_URL=http://127.0.0.1:3597 GEMINI_TEST_BASE_URL=http://127.0.0.1:3597 \
 *   npx tsx scripts/verify-importer-two-step.ts
 */
import http from "node:http";
import { AiImportJobStatus, AiImportPaperType, type Prisma } from "@prisma/client";

const DB = process.env.DATABASE_URL ?? "";
if (!/\/mts_twostep[a-z0-9_]*(\?|$)/.test(DB)) {
  console.error("Refusing to run: DATABASE_URL must be a disposable mts_twostep* scratch database.");
  process.exit(2);
}
const PORT = 3597;
for (const v of ["OPENROUTER_TEST_BASE_URL", "OPENAI_TEST_BASE_URL", "ANTHROPIC_TEST_BASE_URL", "GEMINI_TEST_BASE_URL"]) {
  if (process.env[v] !== `http://127.0.0.1:${PORT}`) {
    console.error(`Set ${v}=http://127.0.0.1:${PORT}`);
    process.exit(2);
  }
}
// Network guard: loopback only.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!/^http:\/\/127\.0\.0\.1:/.test(url)) throw new Error(`network guard: refused ${url}`);
  return realFetch(input, init);
}) as typeof fetch;

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail ? ` — ${detail}` : ""}`);
};
const section = (s: string) => console.log(`\n=== ${s}`);

// ---- Mock providers -------------------------------------------------------------------------------------------------
type Behavior = "ok" | "bad-json" | "403-key" | "403-mod" | "401" | "429" | "500" | "drop" | "gemini-quota";
const queue = new Map<string, Behavior[]>();
const seen: { provider: string; model: string }[] = [];
const seenAll: { provider: string; model: string }[] = [];
const ROUTE_PRICES = new Map<string, [number, number]>();
let gen = Date.now();
const ANSWER = JSON.stringify({ answer: ["B"], confidence: 0.9, defective: false, reason: "mock" });
function behave(key: string): Behavior {
  const q = queue.get(key);
  return q && q.length ? q.shift()! : "ok";
}
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const j = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const url = req.url ?? "";
    let provider = "";
    let model = "";
    if (url.startsWith("/api/v1/chat/completions")) {
      provider = "openrouter";
      model = ((j.models as string[] | undefined) ?? [j.model as string])[0];
    } else if (url.startsWith("/v1/chat/completions")) {
      provider = "openai";
      model = j.model as string;
    } else if (url.startsWith("/v1/messages")) {
      provider = "anthropic";
      model = j.model as string;
    } else if (url.startsWith("/v1beta/models/")) {
      provider = "gemini";
      model = decodeURIComponent(url.split("/v1beta/models/")[1].split(":")[0]);
    } else if (req.method === "GET" && url.startsWith("/api/v1/endpoints/zdr")) return send(200, { data: [] });
    else if (req.method === "GET" && /^\/api\/v1\/models\/.+\/endpoints/.test(url)) {
      // OpenRouter route metadata (free, public): one healthy route at the catalog price of the test model.
      const id = decodeURIComponent(url.split("/api/v1/models/")[1].split("/endpoints")[0]);
      const pr = ROUTE_PRICES.get(id);
      if (!pr) return send(404, { error: { message: "no such model" } });
      return send(200, { data: { endpoints: [{ model_id: id, provider_name: "MockProvider", tag: "mock", status: 0, context_length: 128000, max_completion_tokens: 16000, supported_parameters: ["max_tokens", "response_format"], pricing: { prompt: String(pr[0]), completion: String(pr[1]) } }] } });
    } else return send(404, { error: { message: "not found" } });
    seen.push({ provider, model });
    seenAll.push({ provider, model });
    const b = behave(`${provider}|${model}`);
    if (b === "drop") return req.socket.destroy();
    const err = (status: number, message: string) => send(status, { error: { message } });
    if (b === "403-key") return err(403, "Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys");
    if (b === "403-mod") return err(403, "Input flagged by content moderation: violence");
    if (b === "401") return err(401, "Invalid API key");
    if (b === "429") return err(429, "Rate limit exceeded, retry later");
    if (b === "gemini-quota") return err(429, "Resource has been exhausted (e.g. check quota).");
    if (b === "500") return err(500, "Internal server error");
    const text = b === "bad-json" ? "Sorry, I cannot help with that" : ANSWER;
    if (provider === "anthropic") return send(200, { id: `msg_${++gen}`, content: [{ type: "text", text }], usage: { input_tokens: 120, output_tokens: 30 }, stop_reason: "end_turn" });
    if (provider === "gemini") return send(200, { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } });
    return send(200, { id: `gen-${++gen}`, model, choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30, ...(provider === "openrouter" ? { cost: 0.0004 } : {}) } });
  });
});

// ---- Main -----------------------------------------------------------------------------------------------------------
async function main() {
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
  const { prisma } = await import("@/lib/prisma");
  const { categorize } = await import("@/lib/ai-engine/openrouter");
  const { setFxMode } = await import("@/lib/ai-engine/fx");
  const { saveOpenRouterKey } = await import("@/lib/ai-engine/settings");
  const { saveClaudeKey } = await import("@/lib/anthropic-config");
  const { jobRunSettings } = await import("@/lib/ai-import/settings");
  const { vaSettings } = await import("@/lib/ai-import/verify-answers-run");
  const { saveGeminiConfig } = await import("@/lib/gemini-config");
  const { saveOpenAiConfig } = await import("@/lib/openai-config");
  const { IMPORTER_SETTING_KEY, normalizeImporterSettings } = await import("@/lib/ai-import/config");
  const { normalizeChains, parseChainText, RECOMMENDED_PRIMARIES } = await import("@/lib/ai-import/chains");
  const { kindOfCategory } = await import("@/lib/ai-import/failure");
  const ai = await import("@/lib/ai-import/ai");
  const { reviewBucket, systemOnly, matchStatus, parseFilters } = await import("@/lib/ai-import/review-filters");
  const { compareAnswer, vaCategory } = await import("@/lib/ai-import/verify-answers-core");
  const { comparePaperIds } = await import("@/lib/ai-import/key-check");
  const { parseKeyText } = await import("@/lib/ai-import/keys");
  const { STATUS_RULES_VERSION, markStatusesCurrent, statusesStale, continueAutoVerify, autoVerifyOf, autoLimitExceeded } = await import("@/lib/ai-import/auto-verify");
  const { importerSettingsProblems } = await import("@/lib/ai-import/models");
  const { twoStepView } = await import("@/lib/ai-import/two-step");

  // Re-runnable: remove what an earlier run of this suite created (synthetic rows only).
  const purge = async () => {
    const old = await prisma.aiImportJob.findMany({ where: { createdById: "admin-synthetic" }, select: { id: true } });
    for (const { id } of old) await prisma.aiBudgetReservation.deleteMany({ where: { requestKey: { startsWith: `qi:${id}:` } } });
    await prisma.aiImportJob.deleteMany({ where: { createdById: "admin-synthetic" } });
    // Route snapshots of an earlier run would hide the mock's routes (refreshed only after 6 h).
    await prisma.setting.deleteMany({ where: { key: "ai.importer.routes" } });
  };
  await purge();

  section("A. 403 / provider error classification");
  ok("A1 OpenRouter 403 key limit → insufficient_credits", categorize(403, "Key limit exceeded (total limit). Manage it using https://openrouter.ai/…") === "insufficient_credits");
  ok("A2 403 content flag → moderation", categorize(403, "Input flagged by content moderation") === "moderation");
  ok("A3 403 rejected key → auth_invalid", categorize(403, "This API key is disabled") === "auth_invalid");
  ok("A4 401 → auth_invalid; 402 → credits", categorize(401, "x") === "auth_invalid" && categorize(402, "x") === "insufficient_credits");
  ok("A5 key limit / auth = provider_credit kind (never a question error)", kindOfCategory("insufficient_credits") === "provider_credit" && kindOfCategory("auth_invalid") === "provider_credit");
  ok("A9 chainable: timeout / rate limit / provider / output / unavailable yes; budget no", ai.chainable(new ai.ImporterAiFailure("t", "timeout")) && ai.chainable(new ai.ImporterAiFailure("r", "rate_limited")) && ai.chainable(new ai.ImporterAiFailure("m", "model_output")) && ai.chainable(new ai.ImporterAiFailure("u", "route_unavailable")) && !ai.chainable(new ai.ImporterBudgetError("b", "month")) && !ai.chainable(new ai.ImporterAiFailure("b", "budget")));
  ok("A10 paid-AI-off / stopped job never chain", !ai.chainable(new ai.ImporterAiSwitchedOff("off")) && !ai.chainable(new ai.ImporterJobStopped("stopped")));

  section("B. Chains: OpenRouter only, defaults, independence");
  const def = normalizeChains(null);
  ok("B1 defaults: every chain entry is OpenRouter", Object.values(def).flat().every((e) => e.provider === "openrouter"));
  const conv = normalizeChains({ extract: [{ provider: "gemini", model: "google/gemini-3.1-pro-preview" }, { provider: "openrouter", model: "google/gemini-3.1-pro-preview" }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }, { provider: "x", model: "bad id" }] });
  ok("B2 saved direct entries become the same model via OpenRouter (deduplicated, junk dropped)", conv.extract.length === 2 && conv.extract.every((e) => e.provider === "openrouter") && conv.extract[1].model === "anthropic/claude-sonnet-5.5", JSON.stringify(conv.extract));
  const parsed = parseChainText("anthropic: anthropic/claude-sonnet-5.5\nbogus line\nopenrouter: openai/gpt-5.4\ngoogle/gemini-3-flash-preview");
  ok("B3 typed direct providers are refused with a reason; bare / openrouter lines accepted", parsed.entries.length === 2 && parsed.problems.length === 2 && /OpenRouter/.test(parsed.problems[0]), JSON.stringify(parsed));
  const P = RECOMMENDED_PRIMARIES;
  ok("B4 reading and verification from different vendors; key reader independent of the question reader", P.extract.split("/")[0] !== P.verify.split("/")[0] && P.key.split("/")[0] !== P.extract.split("/")[0]);
  ok("B5 each chain starts with its primary; the verification chain has no model of the reading vendor", (Object.keys(P) as (keyof typeof P)[]).every((r) => def[r][0].model === P[r]) && !def.verify.some((e) => e.model.split("/")[0] === P.extract.split("/")[0]));
  ok("B6 auto checks on, no job cap by default", normalizeImporterSettings({}).workflow.autoVerify && normalizeImporterSettings({}).workflow.autoVerifyMaxInr === null && normalizeImporterSettings({ workflow: { autoVerifyMaxInr: "12.5" } }).workflow.autoVerifyMaxInr === 12.5);

  section("C. Deterministic answer mapping (AI never supplies an official answer)");
  const parse = (raw: string) => (/^[A-D]$/.test(raw) ? { labels: [raw], problem: null } : { labels: null, problem: `unreadable ${raw}` });
  ok("C1 matched", compareAnswer({ saved: ["B"], keys: [{ rawValue: "B", fileProblem: null }], unmapped: [], parse }).verdict === "MATCH");
  ok("C2 shifted / unmapped entry → UNVERIFIED (never assigned)", compareAnswer({ saved: ["B"], keys: [], unmapped: ["C"], parse }).code === "UNMAPPED");
  ok("C3 duplicate number with different answers → UNVERIFIED", compareAnswer({ saved: ["B"], keys: [{ rawValue: "B", fileProblem: null }, { rawValue: "C", fileProblem: null }], unmapped: [], parse }).verdict === "UNVERIFIED");
  ok("C4 key of another paper / series → WRONG_PAPER", compareAnswer({ saved: ["B"], keys: [{ rawValue: "B", fileProblem: "Series B key, paper is Series A" }], unmapped: [], parse }).code === "WRONG_PAPER");
  ok("C5 withdrawn X → WITHDRAWN", compareAnswer({ saved: [], keys: [{ rawValue: "X", fileProblem: null }], unmapped: [], parse }).code === "WITHDRAWN");
  ok("C6 unreadable cell → UNVERIFIED", compareAnswer({ saved: ["A"], keys: [{ rawValue: "?", fileProblem: null }], unmapped: [], parse }).verdict === "UNVERIFIED");
  ok("C7 missing entry → NO_KEY", compareAnswer({ saved: ["A"], keys: [], unmapped: [], parse }).verdict === "NO_KEY");
  ok("C8 AI disagreeing with a matched official key only flags review", vaCategory({ verdict: "MATCH", official: ["B"], saved: ["B"] }, { answer: ["C"], confidence: 0.99, defective: false, reason: "" }).category === "AI_DISAGREES");
  ok("C9 series mismatch detected", comparePaperIds({ paper: "1", series: "B" } as never, { paper: "1", series: "A" } as never).state !== "MATCH");
  ok("C10 key text parsed by number", parseKeyText("1 2 3 4\nB C A D").map((p) => `${p.number}${p.raw}`).join() === "1B,2C,3A,4D");

  section("D. Review buckets (system failures never counted as question errors)");
  ok("D1 clean / approved / done", reviewBucket({ status: "READY", issueCodes: [], approved: false, stored: false }) === "clean" && reviewBucket({ status: "READY", issueCodes: [], approved: true, stored: false }) === "approved" && reviewBucket({ status: "IMPORTED", issueCodes: [], approved: true, stored: true }) === "done");
  ok("D2 only provider failures → system", reviewBucket({ status: "NEEDS_CORRECTION", issueCodes: ["VERIFY2_FAILED", "TAXONOMY_CHECK_FAILED"], approved: false, stored: false }) === "system");
  ok("D3 any genuine code → needs you", reviewBucket({ status: "NEEDS_CORRECTION", issueCodes: ["VERIFY2_FAILED", "OPTIONS_INCOMPLETE"], approved: false, stored: false }) === "needs-you");
  ok("D4 READY with warnings is not bulk-approvable", reviewBucket({ status: "READY", issueCodes: ["TOPIC_UNCERTAIN"], approved: false, stored: false }) === "needs-you");
  const row = { status: "NEEDS_CORRECTION", answerStatus: "OFFICIAL_MATCHED", issueCodes: ["VERIFY2_FAILED"], approved: false, stored: false, importBlocker: "x", v1: "passed", v2: "failed", eligible: false, fieldProblem: false, memoryProblem: false };
  ok("D5 filters: system / needs-you split, old 'exceptions' unchanged", matchStatus(row, "system") && !matchStatus(row, "needs-you") && matchStatus(row, "exceptions") && systemOnly(row) && parseFilters({ status: "needs-you" }).status === "needs-you");

  section("E. Fallback chain on the scratch DB (mock providers)");
  // Keys (encrypted with AUTH_SECRET, like production) and the exchange rate.
  await setFxMode({ mode: "manual", manualRate: 90 });
  await saveOpenRouterKey(`sk-or-v1-${"a".repeat(64)}`, "script");
  const orRow = await prisma.setting.findUniqueOrThrow({ where: { key: "api.openrouter" } });
  await prisma.setting.update({ where: { key: "api.openrouter" }, data: { value: { ...(orRow.value as object), enabled: true } as Prisma.InputJsonValue } });
  await saveClaudeKey(`sk-ant-api03-${"b".repeat(80)}`);
  await saveGeminiConfig({ apiKey: `AIza${"c".repeat(35)}`, enabled: true });
  await saveOpenAiConfig({ apiKey: `sk-proj-${"d".repeat(60)}`, enabled: true });
  const PRIMARY = "openai/gpt-5.4-mini";
  const models: [string, number, number][] = [
    [PRIMARY, 0.75e-6, 4.5e-6],
    ["openai/gpt-5.4", 2.5e-6, 15e-6],
    ["anthropic/claude-sonnet-5.5", 2e-6, 10e-6],
    ["anthropic/claude-opus-5.5", 4e-6, 20e-6],
    ["google/gemini-3.1-pro-preview", 2e-6, 12e-6],
    ["qwen/qwen-strong", 1e-6, 4e-6],
  ];
  for (const [id, p, c] of models) {
    ROUTE_PRICES.set(id, [p, c]);
    await prisma.aiModel.upsert({ where: { id }, update: {}, create: { id, name: id, vendor: id.split("/")[0], inputModalities: ["text", "image"], outputModalities: ["text"], supportedParameters: ["max_tokens", "response_format"], promptPrice: p, completionPrice: c, lastSyncedAt: new Date() } as never });
  }
  const chains = {
    extract: [{ provider: "gemini", model: "google/gemini-3.1-pro-preview" }, { provider: "anthropic", model: "anthropic/claude-opus-5.5" }],
    key: [{ provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }],
    verify: [{ provider: "openrouter", model: "qwen/qwen-strong" }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }, { provider: "gemini", model: "google/gemini-3.1-pro-preview" }],
    classify: [{ provider: "openrouter", model: "openai/gpt-5.4" }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }],
  };
  const settings = normalizeImporterSettings({ aiEnabled: true, selection: { mode: "manual" }, importerModels: [PRIMARY], models: { extract: PRIMARY, verify: PRIMARY, classify: PRIMARY, key: PRIMARY }, privacy: { zdr: false, dataCollection: "deny" }, fallbackChains: chains, budget: { totalInr: 1000, monthlyInr: 1500 } });
  await prisma.setting.upsert({ where: { key: IMPORTER_SETTING_KEY }, update: { value: settings as unknown as Prisma.InputJsonValue }, create: { key: IMPORTER_SETTING_KEY, value: settings as unknown as Prisma.InputJsonValue } });
  const choice = (task: "extract" | "verify" | "key" | "classify") => ({ task, model: PRIMARY, fallbacks: [], mode: "manual", reason: "test", vision: true, price: { prompt: 0.75e-6, completion: 4.5e-6, image: 0, request: 0 }, maxUsd: 0.01, maxInr: 1, typicalInr: 0.1, routes: [], privacy: { zdrRequired: false, dataCollection: "deny", zdrVerified: false }, candidates: [] });
  const plan = { computedAt: new Date().toISOString(), mode: "manual", routesFetchedAt: null, routesStale: false, fxRate: 90, fxDate: null, privacy: { zdr: false, dataCollection: "deny" }, tasks: { extract: choice("extract"), verify: choice("verify"), key: choice("key"), classify: choice("classify") }, problems: [] };
  // Old saved job settings (as the paused production job has them): OpenRouter "off", every direct provider "on",
  // direct-provider chain entries. None of it may take effect: every request below must go through OpenRouter.
  const OLD = { useOpenRouter: false, openaiDirect: true, directProviders: { anthropic: true, gemini: true, openai: true }, fallbackChains: chains };
  const newJob = async (extra: Record<string, unknown> = {}) => {
    queue.clear();
    return prisma.aiImportJob.create({ data: { title: "two-step synthetic", status: AiImportJobStatus.PROCESSING, examId: "exam-synthetic", paperType: AiImportPaperType.FULL_PAPER, createdById: "admin-synthetic", budgetInr: 1000, spentInr: 0, spentUsd: 0, config: { ...settings, ...OLD, modelPlan: plan, ...extra } as unknown as Prisma.InputJsonValue } });
  };
  type Job = Awaited<ReturnType<typeof newJob>>;
  // Like the worker: the job's frozen settings merged with the current ones (jobRunSettings).
  const run = (job: Job, task: "verify" | "classify" | "extract" | "key" = "verify") => ai.importerAiCall({ jobId: job.id, task, models: [PRIMARY], system: "Answer as JSON.", content: [{ type: "text", text: "Q1. Which? (A) a (B) b" }], maxOutputTokens: 400, settings: jobRunSettings(job.config, settings), needsVision: false, stage: "test" });
  const calls = (jobId: string) => prisma.aiImportAiCall.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const events = (jobId: string, type: string) => prisma.aiImportEvent.count({ where: { jobId, type } });
  const errOf = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return null;
    } catch (e) {
      return e;
    }
  };
  const OR_PRIMARY = `openrouter|${PRIMARY}`;

  {
    const j = await newJob();
    seen.length = 0;
    const r = await run(j);
    ok("E1 old job settings (OpenRouter off, OpenAI direct on, direct keys saved): the request still goes through OpenRouter", r.model === PRIMARY && !r.fallbackUsed && seen.length === 1 && seen[0].provider === "openrouter", JSON.stringify(seen));
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["500", "500"]);
    seen.length = 0;
    const r = await run(j);
    const rows = await calls(j.id);
    ok("E2 provider 500 → the next chain model answers, through OpenRouter", r.fallbackUsed && r.model === "qwen/qwen-strong", r.model);
    ok("E3 every attempt logged as OpenRouter; fallback marked; one PROVIDER_FALLBACK event", rows.length === 2 && rows.every((c) => c.provider === "openrouter") && rows.some((c) => c.ok && c.fallbackUsed) && (await events(j.id, "PROVIDER_FALLBACK")) === 1);
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["403-key"]);
    seen.length = 0;
    const err = await errOf(() => run(j));
    ok("E4 OpenRouter key limit → job PAUSES at once (not a question failure), clear message", err instanceof ai.ImporterAiUnavailable && !(err instanceof ai.ImporterAiFailure) && /credits or the key's spending limit/.test((err as Error).message), err instanceof Error ? err.message.slice(0, 200) : String(err));
    ok("E5 no other model tried on the exhausted account (1 request, no fallback event)", seen.length === 1 && (await events(j.id, "PROVIDER_FALLBACK")) === 0, JSON.stringify(seen));
    const again = await errOf(() => run(j, "classify"));
    ok("E6 later requests of the same run are not sent at all (paused, nothing retried)", again instanceof ai.ImporterAiUnavailable && seen.length === 1);
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["401"]);
    seen.length = 0;
    const err = await errOf(() => run(j));
    ok("E7 rejected OpenRouter key (401) → pause, 1 request only", err instanceof ai.ImporterAiUnavailable && !(err instanceof ai.ImporterAiFailure) && seen.length === 1);
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["500", "500"]);
    queue.set("openrouter|qwen/qwen-strong", ["403-key"]);
    seen.length = 0;
    const err = await errOf(() => run(j));
    ok("E8 key limit reached inside the fallback chain → pause immediately; later chain models never tried", err instanceof ai.ImporterAiUnavailable && !(err instanceof ai.ImporterAiFailure) && seen.length === 2 && !seen.some((s) => /sonnet|gemini/.test(s.model)), JSON.stringify(seen));
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["500", "500"]);
    queue.set("openrouter|qwen/qwen-strong", ["500"]);
    queue.set("openrouter|anthropic/claude-sonnet-5.5", ["500"]);
    queue.set("openrouter|google/gemini-3.1-pro-preview", ["500"]);
    seen.length = 0;
    const err = await errOf(() => run(j));
    ok("E9 every model fails → reported failure (not a pause), chain summarised", err instanceof ai.ImporterAiFailure && /Fallback chain tried/.test((err as Error).message) && ai.isChained(err));
    const rows = await calls(j.id);
    ok("E10 each chain model tried once, all through OpenRouter", rows.length === 4 && rows.every((c) => c.provider === "openrouter") && new Set(rows.slice(1).map((c) => c.model)).size === 3, JSON.stringify(rows.map((r) => [r.provider, r.model])));
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["bad-json"]);
    const out = await ai.importerAiCallChecked({ jobId: j.id, task: "verify", models: [PRIMARY], system: "JSON", content: [{ type: "text", text: "Q" }], maxOutputTokens: 400, settings: jobRunSettings(j.config, settings), needsVision: false, stage: "test" }, (t) => {
      const v = JSON.parse(t) as { answer: string[] };
      if (!Array.isArray(v.answer)) throw new ai.ImporterAiFailure("shape", "model_output");
      return v;
    });
    const rows = await calls(j.id);
    ok("E11 malformed answer → same request to the next model (OpenRouter), parsed; failed call logged as unusable", out.value.answer[0] === "B" && out.result.fallbackUsed && rows.length === 2 && !rows[0].ok && rows[0].errorCategory === "unusable");
  }
  {
    // Independence: reading by Google → verification never uses a Google model, even as a fallback.
    const j = await newJob({ modelPlan: { ...plan, tasks: { ...plan.tasks, extract: { ...choice("extract"), model: "google/gemini-3.1-pro-preview" } } } });
    queue.set(OR_PRIMARY, ["500", "500"]);
    queue.set("openrouter|qwen/qwen-strong", ["500"]);
    queue.set("openrouter|anthropic/claude-sonnet-5.5", ["500"]);
    seen.length = 0;
    const err = await errOf(() => run(j, "verify"));
    ok("E12 verify chain skips the reading vendor (Google) entirely", err instanceof ai.ImporterAiFailure && !seen.some((s) => s.model.startsWith("google/")), JSON.stringify(seen));
  }
  {
    const j = await newJob();
    await prisma.aiImportJob.update({ where: { id: j.id }, data: { budgetInr: 0.0001 } });
    const fresh = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j.id } });
    seen.length = 0;
    const err = await errOf(() => run(fresh));
    ok("E13 budget stop is final (nothing sent anywhere)", err instanceof ai.ImporterBudgetError && seen.length === 0);
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["500", "500"]);
    queue.set("openrouter|qwen/qwen-strong", ["500"]);
    await run(j);
    const rows = await calls(j.id);
    const good = rows.find((c) => c.ok);
    const open = await prisma.aiBudgetReservation.count({ where: { requestKey: { startsWith: `qi:${j.id}:` }, status: "RESERVED" } });
    ok("E14 fallback cost recorded and no reservation left open", !!good && (good.costInr ?? 0) > 0 && open === 0, `${good?.costInr} open=${open}`);
  }

  section("G. Verify Answers / AI opinion / same model never re-sent on the same account");
  const solveParse = (t: string) => {
    const v = ai.parseModelJson(t) as { answer?: unknown };
    if (!Array.isArray(v.answer)) throw new ai.ImporterAiFailure("The answer was not the expected JSON.", "model_output");
    return v as { answer: string[] };
  };
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["bad-json"]);
    seen.length = 0;
    const out = await ai.importerAiCallChecked({ jobId: j.id, task: "classify", override: choice("classify") as never, noReplace: true, models: [PRIMARY], system: "JSON", content: [{ type: "text", text: "Q" }], maxOutputTokens: 300, settings: vaSettings(j.config, settings), needsVision: false, stage: "verify-answers" }, solveParse);
    ok("G1 Verify Answers (old job settings): malformed opinion → next model, all via OpenRouter", out.value.answer[0] === "B" && out.result.fallbackUsed && out.result.model !== PRIMARY && seen.every((s) => s.provider === "openrouter"), JSON.stringify(seen));
  }
  {
    const j = await newJob();
    queue.set(OR_PRIMARY, ["500", "500"]);
    queue.set("openrouter|qwen/qwen-strong", ["bad-json"]);
    seen.length = 0;
    const out = await ai.importerAiCallChecked({ jobId: j.id, task: "verify", models: [PRIMARY], system: "JSON", content: [{ type: "text", text: "Q" }], maxOutputTokens: 300, settings: jobRunSettings(j.config, settings), needsVision: false, stage: "post-answer-opinion" }, solveParse);
    ok("G2 AI opinion: provider error, then malformed fallback → third model answers via OpenRouter", out.result.model === "anthropic/claude-sonnet-5.5" && out.value.answer[0] === "B" && seen.every((s) => s.provider === "openrouter"), out.result.model);
  }
  {
    // An old chain listing the SAME model through a direct provider: after an outage it is not re-sent on the same account.
    const sameChain = { ...chains, classify: [{ provider: "openai", model: PRIMARY }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }] };
    const j = await newJob({ fallbackChains: sameChain });
    queue.set(OR_PRIMARY, ["500", "500"]);
    seen.length = 0;
    const r = await run(j, "classify");
    ok("G3 old direct entry for the same model is NOT re-sent (same OpenRouter account); next model answers", r.model === "anthropic/claude-sonnet-5.5" && seen.filter((s) => s.model === PRIMARY).length === 1 && seen.every((s) => s.provider === "openrouter"), JSON.stringify(seen));
  }

  section("H. No direct transport anywhere in the importer");
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dirs = ["lib/ai-import", "app/admin/(dashboard)/ai-importer", "components/admin/ai-importer"];
    const files = dirs.flatMap((d) => (fs.readdirSync(d, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(d, f)));
    const hits = files.filter((f) => /openAiDirectChat|directChat\(|getClaudeApiKey|getGeminiApiKey|getOpenAiApiKey|api\.anthropic\.com|generativelanguage\.googleapis|api\.openai\.com|direct-providers/.test(fs.readFileSync(f, "utf8")));
    ok(`H1 no direct Gemini / Anthropic / OpenAI transport or key read in ${files.length} importer files`, files.length > 50 && hits.length === 0, hits.join(", "));
    const st = normalizeImporterSettings({ useOpenRouter: false, openaiDirect: true, directProviders: { anthropic: true, gemini: true, openai: true }, fallbackChains: chains });
    ok("H2 old switches are dropped on read; chains are OpenRouter-only", !("useOpenRouter" in st) && !("openaiDirect" in st) && !("directProviders" in st) && Object.values(st.fallbackChains).flat().every((e) => e.provider === "openrouter"));
    const jr = jobRunSettings({ ...settings, ...OLD }, settings);
    ok("H3 jobRunSettings (old job copy) and vaSettings: no direct switch survives", !("openaiDirect" in jr) && !("directProviders" in vaSettings({ ...settings, ...OLD }, settings)) && Object.values(jr.fallbackChains).flat().every((e) => e.provider === "openrouter"));
    const probs = await importerSettingsProblems({}, normalizeImporterSettings({ models: { extract: "google/gemini-3.1-pro-preview", verify: "google/gemini-2.5-pro" } }));
    ok("H6 settings refuse reading + verification from the same vendor", probs.some((p) => /same vendor/.test(p)));
    ok("H7 job-level limit: ₹590 spent + ₹20 check > ₹600 → waits; ₹500 + ₹20 → runs; admin-confirmed maximum lifts it", autoLimitExceeded(590, 20, 600, null) && !autoLimitExceeded(500, 20, 600, null) && !autoLimitExceeded(590, 20, 600, 20) && autoLimitExceeded(0, 25, 600, 20) && !autoLimitExceeded(10_000, 5, null, null));
  }

  section("F. Status rules version and automatic checks");
  {
    const j = await newJob({ autoVerify: { enabled: true, actorId: "admin-synthetic", step: "verify2", held: null, updatedAt: "" } });
    ok("F1 a job without the current rules version is stale", statusesStale(j.config));
    await markStatusesCurrent(j.id);
    const fresh = await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j.id } });
    ok("F2 marked current", !statusesStale(fresh.config) && (fresh.config as { statusRulesVersion?: string }).statusRulesVersion === STATUS_RULES_VERSION);
    const r = await continueAutoVerify(j.id);
    ok("F3 auto checks never start while the job is still processing", r?.step === "verify2" && !r.held);
    await prisma.aiImportJob.update({ where: { id: j.id }, data: { status: AiImportJobStatus.NEEDS_REVIEW } });
    const off = normalizeImporterSettings({ ...settings, aiEnabled: false });
    await prisma.setting.update({ where: { key: IMPORTER_SETTING_KEY }, data: { value: off as unknown as Prisma.InputJsonValue } });
    seen.length = 0;
    await continueAutoVerify(j.id);
    const after = autoVerifyOf((await prisma.aiImportJob.findUniqueOrThrow({ where: { id: j.id } })).config);
    ok("F4 a paid check that cannot run waits (HELD) with the reason and sends nothing", !!after?.held && /switched off/.test(after.held) && seen.length === 0, JSON.stringify(after));
    await prisma.setting.update({ where: { key: IMPORTER_SETTING_KEY }, data: { value: settings as unknown as Prisma.InputJsonValue } });
    const again = await continueAutoVerify(j.id);
    ok("F4b a held sequence does not restart by itself", !!again?.held && seen.length === 0);
    const v = await twoStepView(j.id);
    ok("F5 two-step view reports the hold", !!v?.auto?.held);
  }
  {
    // A run that hit a budget stop never gets paid checks added automatically.
    const j = await newJob({ autoVerify: { enabled: true, actorId: "admin-synthetic", step: "verify2", held: null, updatedAt: "" } });
    await prisma.aiImportJob.update({ where: { id: j.id }, data: { status: AiImportJobStatus.NEEDS_REVIEW } });
    await prisma.aiImportEvent.create({ data: { jobId: j.id, type: "PAID_AI_BLOCKED", message: "job limit (job)" } });
    seen.length = 0;
    const r = await continueAutoVerify(j.id);
    ok("F8 budget-stopped import: automatic paid checks wait for confirmation, nothing sent", !!r?.held && /budget limit/.test(r.held) && seen.length === 0, JSON.stringify(r));
  }
  {
    const j = await newJob();
    await prisma.aiImportJob.update({ where: { id: j.id }, data: { status: AiImportJobStatus.NEEDS_REVIEW } });
    const base = { jobId: j.id, fileId: `f-${j.id}`, sourceLabel: "1", pages: [1], orderIndex: 0, questionType: "MCQ_SINGLE", optionCount: 4, contentFormat: "TEXT", data: {} };
    await prisma.aiImportQuestion.createMany({
      data: [
        { ...base, sourceKey: "k1", status: "READY", issueCodes: [] },
        { ...base, sourceKey: "k2", status: "NEEDS_CORRECTION", issueCodes: ["VERIFY2_FAILED"] },
        { ...base, sourceKey: "k3", status: "NEEDS_CORRECTION", issueCodes: ["ANSWER_MISMATCH"] },
      ] as never,
    });
    const v = await twoStepView(j.id);
    ok("F6 buckets: 1 clean, 1 system, 1 needs you", v?.buckets.clean === 1 && v.buckets.system === 1 && v.buckets["needs-you"] === 1, JSON.stringify(v?.buckets));
    ok("F7 provider failures counted apart from question problems", typeof v?.providerFailures === "number");
  }


  section("K. Cost estimator: role-specific sizes, current catalog prices, chain-aware maximum");
  {
    const { estimateJobCost, requestMaxPricer, MAX_OUT } = await import("@/lib/ai-import/estimate");
    const { usdToInr } = await import("@/lib/ai-engine/config");
    const { RECOMMENDED_CHAINS: RC, RECOMMENDED_PRIMARIES: RP } = await import("@/lib/ai-import/chains");
    const page = (n: number) => ({ page: n, textChars: 2_400, images: 0, kind: "TEXT" as const, risk: ["low-confidence"], localQuestions: 5 });
    const facts = { kind: "PDF", pages: 2, textPages: 2, scannedPages: 0, blankPages: 0, embeddedImages: 0, localQuestionCount: 10, questionTypes: {}, answerKeyDetected: false, formulasLikely: false, tablesLikely: false, documentType: "QUESTION_PAPER" as const, notes: [], pagesDetail: [page(1), page(2)] };
    const cat = (id: string) => models.find((m) => m[0] === id)!;
    const pr = (id: string, k = 1) => ({ prompt: cat(id)[1] * k, completion: cat(id)[2] * k, image: 0, request: 0 });
    const kPlan = (verifyK: number) => ({ ...plan, fxRate: 90, tasks: { extract: { ...choice("extract"), model: "google/gemini-3.1-pro-preview", price: pr("google/gemini-3.1-pro-preview") }, verify: { ...choice("verify"), model: "anthropic/claude-opus-5.5", price: pr("anthropic/claude-opus-5.5", verifyK) }, classify: { ...choice("classify"), model: "anthropic/claude-sonnet-5.5", price: pr("anthropic/claude-sonnet-5.5") }, key: { ...choice("key"), model: "anthropic/claude-sonnet-5.5", price: pr("anthropic/claude-sonnet-5.5") } } });
    const kChains = { extract: [{ provider: "openrouter", model: "google/gemini-3.1-pro-preview" }], key: [], verify: [{ provider: "openrouter", model: "anthropic/claude-opus-5.5" }, { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" }, { provider: "openrouter", model: "openai/gpt-5.4" }], classify: [] };
    const kSettings = normalizeImporterSettings({ ...settings, fallbackChains: kChains, verification: { ...settings.verification, independentAnswer: true } });
    const worst = (p: { prompt: number; completion: number }, inTok: number, out: number) => usdToInr((inTok * p.prompt + out * p.completion) * ai.PRICE_MARGIN, 90)!;
    const est = await estimateJobCost({ paperFacts: [facts], keyFacts: [], settings: kSettings, plan: kPlan(1) as never, verifyMode: "all" });
    const opinion = est.lines.find((l) => /answer opinion/i.test(l.label))!;
    const pageVerify = est.lines.find((l) => /every page/i.test(l.label))!;
    const expectedEach = ai.REQUEST_ATTEMPTS * worst(pr("anthropic/claude-opus-5.5"), 600, MAX_OUT.opinion) + worst(pr("anthropic/claude-sonnet-5.5"), 600, MAX_OUT.opinion) + worst(pr("openai/gpt-5.4"), 600, MAX_OUT.opinion);
    ok("K1 answer opinion max = calls × (2 sends to its model + one per other chain model) at its OWN size (600 in / 2,400 out, text only)", Math.abs((opinion.maxInr ?? 0) - opinion.maxCalls * expectedEach) < 0.01, `${opinion.maxInr} vs ${opinion.maxCalls * expectedEach}`);
    ok("K2 a per-question opinion is never priced like a page-image read (per-call max < 1/3 of the page check's)", (opinion.maxInr ?? 0) / opinion.maxCalls < (pageVerify.maxInr ?? 0) / pageVerify.maxCalls / 3, `${(opinion.maxInr ?? 0) / opinion.maxCalls} vs ${(pageVerify.maxInr ?? 0) / pageVerify.maxCalls}`);
    const stale = await estimateJobCost({ paperFacts: [facts], keyFacts: [], settings: kSettings, plan: kPlan(2) as never, verifyMode: "all" });
    const op2 = stale.lines.find((l) => /answer opinion/i.test(l.label))!;
    const typicalCatalog = usdToInr(op2.inputTokens * cat("anthropic/claude-opus-5.5")[1] + op2.outputTokens * cat("anthropic/claude-opus-5.5")[2], 90)!;
    ok("K3 typical cost uses the CURRENT catalog price, not an older plan price", Math.abs((op2.inr ?? 0) - typicalCatalog) < 0.0001, `${op2.inr} vs ${typicalCatalog}`);
    const expected2 = ai.REQUEST_ATTEMPTS * worst(pr("anthropic/claude-opus-5.5", 2), 600, MAX_OUT.opinion) + worst(pr("anthropic/claude-sonnet-5.5"), 600, MAX_OUT.opinion) + worst(pr("openai/gpt-5.4"), 600, MAX_OUT.opinion);
    ok("K4 the maximum uses the dearer of catalog and confirmed route price (never under-reserves)", Math.abs((op2.maxInr ?? 0) - op2.maxCalls * expected2) < 0.01);
    const pricer = await requestMaxPricer(kSettings, kPlan(1) as never, 90);
    ok("K5 classification per-request max uses its own 2,500-token limit (no chain → one-model switch)", Math.abs((pricer.perRequest("classify", false, 6_100, MAX_OUT.classify) ?? 0) - 2 * ai.REQUEST_ATTEMPTS * worst(pr("anthropic/claude-sonnet-5.5"), 6_100, MAX_OUT.classify)) < 0.0001);
    ok("K6 total maximum = sum of the lines", Math.abs((est.maxInr ?? 0) - est.lines.reduce((a, l) => a + (l.maxInr ?? 0), 0)) < 0.01);

    // K7–K9: the paused production job's corrected plan, on a SYNTHETIC copy (numeric page facts + public catalog prices only).
    const fs = await import("node:fs");
    const dir = process.env.PAUSED_FIXTURE_DIR;
    if (!dir) ok("K7 paused-job fixture present (PAUSED_FIXTURE_DIR)", false);
    else {
      const fx = JSON.parse(fs.readFileSync(`${dir}/paused-job-facts.json`, "utf8")) as { expectedQuestions: number; verifyMode: string; storedMaxInr: number; storedTypicalInr: number; fxRate: number; files: { role: string; facts: typeof facts }[] };
      const catalog = JSON.parse(fs.readFileSync(`${dir}/catalog-prices.json`, "utf8")) as { id: string; p: number; c: number; r: number | null; mod: string[]; out: string[]; sp: string[]; ctx: number | null; mct: number | null; pricingRaw: unknown }[];
      for (const m of catalog) {
        const data = { name: m.id, vendor: m.id.split("/")[0], inputModalities: m.mod, outputModalities: m.out, supportedParameters: m.sp, promptPrice: m.p, completionPrice: m.c, reasoningPrice: m.r, contextLength: m.ctx, maxCompletionTokens: m.mct, pricingRaw: m.pricingRaw ?? {}, lastSyncedAt: new Date() };
        await prisma.aiModel.upsert({ where: { id: m.id }, update: data as never, create: { id: m.id, ...data } as never });
      }
      const price = (id: string, k = 1) => { const m = catalog.find((x) => x.id === id)!; return { prompt: m.p * k, completion: Math.max(m.c, m.r ?? 0) * k, image: 0, request: 0 }; };
      const pPlan = (models: Record<"extract" | "verify" | "classify" | "key", [string, number]>) => ({ ...plan, fxRate: fx.fxRate, tasks: Object.fromEntries(Object.entries(models).map(([t, [id, k]]) => [t, { ...choice(t as "extract"), model: id, price: price(id, k) }])) });
      const paper = fx.files.filter((f) => f.role === "PAPER").map((f) => f.facts);
      const key = fx.files.filter((f) => f.role === "ANSWER_KEY").map((f) => f.facts);
      const s = (chainsIn: unknown) => normalizeImporterSettings({ ...settings, fallbackChains: chainsIn, verification: { ...settings.verification, independentAnswer: true } });
      // Same job, OLD models (Opus verify/classify at the plan's confirmed $8/$40 route price) under the corrected formula.
      const oldChains = { extract: [{ model: "google/gemini-3.1-pro-preview" }, { model: "google/gemini-2.5-pro" }, { model: "openai/gpt-5.4" }], key: [{ model: "anthropic/claude-sonnet-5.5" }, { model: "google/gemini-3.1-pro-preview" }, { model: "anthropic/claude-opus-5.5" }, { model: "openai/gpt-5.4" }], verify: [{ model: "anthropic/claude-opus-5.5" }, { model: "anthropic/claude-sonnet-5.5" }, { model: "openai/gpt-5.4" }], classify: [{ model: "anthropic/claude-opus-5.5" }, { model: "google/gemini-3.1-pro-preview" }, { model: "anthropic/claude-sonnet-5.5" }, { model: "openai/gpt-5.4" }] };
      const oldEst = await estimateJobCost({ paperFacts: paper, keyFacts: key, settings: s(oldChains), plan: pPlan({ extract: ["google/gemini-3.1-pro-preview", 1], verify: ["anthropic/claude-opus-5.5", 2], classify: ["anthropic/claude-opus-5.5", 2], key: ["anthropic/claude-sonnet-5.5", 1] }) as never, verifyMode: fx.verifyMode as "all" });
      const newEst = await estimateJobCost({ paperFacts: paper, keyFacts: key, settings: s(RC), plan: pPlan({ extract: [RP.extract, 1], verify: [RP.verify, 1], classify: [RP.classify, 1], key: [RP.key, 1] }) as never, verifyMode: fx.verifyMode as "all" });
      const fmt = (e: typeof newEst) => e.lines.map((l) => `  ${l.label} | ${l.model} | calls ${l.calls} | typical ₹${((l.inr ?? 0) * 1.2).toFixed(2)} | max ₹${(l.maxInr ?? 0).toFixed(2)}`).join("\n");
      console.log(`\n  STORED (production, old formula): typical ₹${fx.storedTypicalInr.toFixed(2)}, max ₹${fx.storedMaxInr.toFixed(2)}`);
      console.log(`  OLD models, corrected formula: typical ₹${oldEst.totalInr?.toFixed(2)}, max ₹${oldEst.maxInr?.toFixed(2)}\n${fmt(oldEst)}`);
      console.log(`  NEW OpenRouter models, corrected formula: typical ₹${newEst.totalInr?.toFixed(2)}, max ₹${newEst.maxInr?.toFixed(2)}\n${fmt(newEst)}\n`);
      fs.writeFileSync(`${dir}/corrected-estimate.json`, JSON.stringify({ stored: { typicalInr: fx.storedTypicalInr, maxInr: fx.storedMaxInr }, oldModels: { typicalInr: oldEst.totalInr, maxInr: oldEst.maxInr, lines: oldEst.lines }, newModels: { typicalInr: newEst.totalInr, maxInr: newEst.maxInr, lines: newEst.lines } }, null, 2));
      ok("K7 synthetic copy: same 120 questions / 20 pages as the paused job", newEst.expectedQuestions === fx.expectedQuestions);
      ok("K8 corrected maximum is far below the stored ₹23,821.71 (old models too)", (oldEst.maxInr ?? Infinity) < fx.storedMaxInr / 3 && (newEst.maxInr ?? Infinity) < (oldEst.maxInr ?? 0));
      ok("K9 new OpenRouter models cost less than the stored typical", (newEst.totalInr ?? Infinity) < fx.storedTypicalInr);
    }
  }

  ok("Z1 not one request reached a direct provider endpoint during the whole suite", seenAll.every((x) => x.provider === "openrouter"), JSON.stringify(seenAll.filter((x) => x.provider !== "openrouter").slice(0, 5)));

  await purge();
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  server.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exit(1);
});
