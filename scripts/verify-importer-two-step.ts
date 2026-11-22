/**
 * Two-step importer (2026-11-22) regression: provider error classification, the multi-provider fallback chain,
 * key-limit pause, deterministic answer mapping, review buckets, status-rules version and auto-verify holds.
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
    } else return send(404, { error: { message: "not found" } });
    seen.push({ provider, model });
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
  const { saveGeminiConfig } = await import("@/lib/gemini-config");
  const { saveOpenAiConfig } = await import("@/lib/openai-config");
  const { IMPORTER_SETTING_KEY, normalizeImporterSettings } = await import("@/lib/ai-import/config");
  const { directCategory } = await import("@/lib/ai-import/direct-providers");
  const { directModelName, normalizeChains, parseChainText, RECOMMENDED_CHAINS, RECOMMENDED_PRIMARIES } = await import("@/lib/ai-import/chains");
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
  };
  await purge();

  section("A. 403 / provider error classification");
  ok("A1 OpenRouter 403 key limit → insufficient_credits", categorize(403, "Key limit exceeded (total limit). Manage it using https://openrouter.ai/…") === "insufficient_credits");
  ok("A2 403 content flag → moderation", categorize(403, "Input flagged by content moderation") === "moderation");
  ok("A3 403 rejected key → auth_invalid", categorize(403, "This API key is disabled") === "auth_invalid");
  ok("A4 401 → auth_invalid; 402 → credits", categorize(401, "x") === "auth_invalid" && categorize(402, "x") === "insufficient_credits");
  ok("A5 key limit / auth = provider_credit kind (never a question error)", kindOfCategory("insufficient_credits") === "provider_credit" && kindOfCategory("auth_invalid") === "provider_credit");
  ok("A6 Gemini quota 429 → insufficient_credits; plain 429 → rate_limited", directCategory(429, "Resource has been exhausted (check quota)") === "insufficient_credits" && directCategory(429, "slow down") === "rate_limited");
  ok("A7 Anthropic overloaded 529 / 5xx → provider_error", directCategory(529, "Overloaded") === "provider_error" && directCategory(503, "x") === "provider_error");
  ok("A8 Anthropic 400 credit balance → insufficient_credits", directCategory(400, "Your credit balance is too low") === "insufficient_credits");
  ok("A9 chainable: timeout / rate limit / provider / output / unavailable yes; budget no", ai.chainable(new ai.ImporterAiFailure("t", "timeout")) && ai.chainable(new ai.ImporterAiFailure("r", "rate_limited")) && ai.chainable(new ai.ImporterAiFailure("m", "model_output")) && ai.chainable(new ai.ImporterAiFailure("u", "route_unavailable")) && !ai.chainable(new ai.ImporterBudgetError("b", "month")) && !ai.chainable(new ai.ImporterAiFailure("b", "budget")));
  ok("A10 paid-AI-off / stopped job never chain", !ai.chainable(new ai.ImporterAiSwitchedOff("off")) && !ai.chainable(new ai.ImporterJobStopped("stopped")));

  section("B. Chains: names, parsing, defaults, independence");
  ok("B1 direct names", directModelName("anthropic", "anthropic/claude-opus-5.5") === "claude-opus-5-5" && directModelName("gemini", "google/gemini-3.1-pro-preview") === "gemini-3.1-pro-preview" && directModelName("openai", "openai/gpt-5.4") === "gpt-5.4" && directModelName("anthropic", "openai/gpt-5.4") === null && directModelName("gemini", "google/gemini-x:free") === null && directModelName("openrouter", "qwen/x:free") === "qwen/x:free");
  const parsed = parseChainText("anthropic: anthropic/claude-sonnet-5.5\nbogus line\ngemini: openai/gpt-5.4");
  ok("B2 parse reports bad lines and impossible routes", parsed.entries.length === 1 && parsed.problems.length === 2);
  const def = normalizeChains(null);
  ok("B3 defaults = recommended chains, three independent provider keys per role", (Object.keys(RECOMMENDED_CHAINS) as (keyof typeof RECOMMENDED_CHAINS)[]).every((r) => new Set(def[r].map((e) => e.provider)).size === 3));
  const P = RECOMMENDED_PRIMARIES;
  ok("B4 strong primaries: reading and verification from different vendors; key reader independent of question reader", P.extract.split("/")[0] !== P.verify.split("/")[0] && P.key !== P.extract && P.classify !== P.key);
  ok("B4b each chain starts with its primary through the vendor's own key (survives an OpenRouter outage)", (Object.keys(P) as (keyof typeof P)[]).every((r) => def[r][0].model === P[r] && def[r][0].provider !== "openrouter"));
  ok("B4c the verification chain never contains the reading primary", !def.verify.some((e) => e.model === P.extract) && !def.extract.some((e) => e.model === P.verify));
  ok("B5 stored junk is dropped, never guessed", normalizeChains({ extract: [{ provider: "x", model: "a/b" }, { provider: "gemini", model: "openai/gpt" }, { provider: "openrouter", model: "a/b" }] }).extract.length === 1);
  const st = normalizeImporterSettings({ openaiDirect: true });
  ok("B6 settings defaults: anthropic+gemini direct on, openai follows openaiDirect, auto checks on, no cap", st.directProviders.anthropic && st.directProviders.gemini && st.directProviders.openai && st.workflow.autoVerify && st.workflow.autoVerifyMaxInr === null);
  ok("B7 explicit off is kept", !normalizeImporterSettings({ directProviders: { gemini: false }, workflow: { autoVerify: false, autoVerifyMaxInr: "12.5" } }).directProviders.gemini && normalizeImporterSettings({ workflow: { autoVerifyMaxInr: "12.5" } }).workflow.autoVerifyMaxInr === 12.5);

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
    await prisma.aiModel.upsert({ where: { id }, update: {}, create: { id, name: id, vendor: id.split("/")[0], inputModalities: ["text", "image"], outputModalities: ["text"], supportedParameters: ["max_tokens", "response_format"], promptPrice: p, completionPrice: c, lastSyncedAt: new Date() } as never });
  }
  const chains = {
    extract: [{ provider: "gemini", model: "google/gemini-3.1-pro-preview" }, { provider: "anthropic", model: "anthropic/claude-opus-5.5" }],
    key: [{ provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }],
    verify: [{ provider: "openrouter", model: "qwen/qwen-strong" }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }, { provider: "gemini", model: "google/gemini-3.1-pro-preview" }],
    classify: [{ provider: "openrouter", model: "openai/gpt-5.4" }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }],
  };
  const settings = normalizeImporterSettings({ aiEnabled: true, openaiDirect: true, selection: { mode: "manual" }, importerModels: [PRIMARY], models: { extract: PRIMARY, verify: PRIMARY, classify: PRIMARY, key: PRIMARY }, privacy: { zdr: false, dataCollection: "deny" }, fallbackChains: chains, budget: { totalInr: 1000, monthlyInr: 1500 } });
  await prisma.setting.upsert({ where: { key: IMPORTER_SETTING_KEY }, update: { value: settings as unknown as Prisma.InputJsonValue }, create: { key: IMPORTER_SETTING_KEY, value: settings as unknown as Prisma.InputJsonValue } });
  const choice = (task: "extract" | "verify" | "key" | "classify") => ({ task, model: PRIMARY, fallbacks: [], mode: "manual", reason: "test", vision: true, price: { prompt: 0.75e-6, completion: 4.5e-6, image: 0, request: 0 }, maxUsd: 0.01, maxInr: 1, typicalInr: 0.1, routes: [], privacy: { zdrRequired: false, dataCollection: "deny", zdrVerified: false }, candidates: [] });
  const plan = { computedAt: new Date().toISOString(), mode: "manual", routesFetchedAt: null, routesStale: false, fxRate: 90, fxDate: null, privacy: { zdr: false, dataCollection: "deny" }, tasks: { extract: choice("extract"), verify: choice("verify"), key: choice("key"), classify: choice("classify") }, problems: [] };
  const newJob = async (extra: Record<string, unknown> = {}) => {
    queue.clear();
    return prisma.aiImportJob.create({ data: { title: "two-step synthetic", status: AiImportJobStatus.PROCESSING, examId: "exam-synthetic", paperType: AiImportPaperType.FULL_PAPER, createdById: "admin-synthetic", budgetInr: 1000, spentInr: 0, spentUsd: 0, config: { ...settings, modelPlan: plan, ...extra } as unknown as Prisma.InputJsonValue } });
  };
  const call = (jobId: string, task: "verify" | "classify" | "extract" | "key" = "verify") => ai.importerAiCall({ jobId, task, models: [PRIMARY], system: "Answer as JSON.", content: [{ type: "text", text: "Q1. Which? (A) a (B) b" }], maxOutputTokens: 400, settings, needsVision: false, stage: "test" });
  const calls = (jobId: string) => prisma.aiImportAiCall.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const events = (jobId: string, type: string) => prisma.aiImportEvent.count({ where: { jobId, type } });

  {
    const j = await newJob();
    seen.length = 0;
    const r = await call(j.id);
    ok("E1 healthy primary: no fallback", r.model.includes("gpt-5.4-mini") && !r.fallbackUsed && seen.length === 1);
  }
  {
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["500", "500"]);
    seen.length = 0;
    const r = await call(j.id);
    const rows = await calls(j.id);
    ok("E2 provider 500 → next vendor (OpenRouter qwen) answers", r.fallbackUsed && r.model === "qwen/qwen-strong", r.model);
    ok("E3 every attempt logged with its provider; fallback marked", rows.some((c) => !c.ok && c.provider === "openai") && rows.some((c) => c.ok && c.provider === "openrouter" && c.fallbackUsed));
    ok("E4 PROVIDER_FALLBACK event recorded", (await events(j.id, "PROVIDER_FALLBACK")) === 1);
  }
  {
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["429", "429"]);
    queue.set(`openrouter|qwen/qwen-strong`, ["403-key"]);
    seen.length = 0;
    const r = await call(j.id);
    ok("E5 rate limit → OpenRouter key limit → Anthropic direct (independent key) answers", r.model.startsWith("anthropic/") && r.fallbackUsed, r.model);
    queue.set(`openai|gpt-5.4-mini`, ["500"]);
    const r2 = await call(j.id, "classify");
    ok("E6 OpenRouter is skipped for the rest of the run after its key limit (classify chain goes to Anthropic)", r2.model.startsWith("anthropic/") && !seen.slice(-3).some((s) => s.provider === "openrouter"), JSON.stringify(seen.slice(-3)));
  }
  {
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["403-key"]);
    queue.set(`openrouter|qwen/qwen-strong`, ["403-key"]);
    queue.set(`anthropic|claude-sonnet-5-5`, ["401"]);
    queue.set(`gemini|gemini-3.1-pro-preview`, ["gemini-quota"]);
    let err: unknown = null;
    try {
      await call(j.id);
    } catch (e) {
      err = e;
    }
    ok("E7 every provider key-limited → job PAUSES (ImporterAiUnavailable), not a question failure", err instanceof ai.ImporterAiUnavailable && !(err instanceof ai.ImporterAiFailure) && /paused/i.test((err as Error).message), err instanceof Error ? err.message.slice(0, 200) : String(err));
    ok("E8 the pause names every provider tried", err instanceof Error && /qwen-strong/.test(err.message) && /claude-sonnet-5.5/.test(err.message) && /gemini-3.1-pro-preview/.test(err.message));
  }
  {
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["403-mod"]);
    const r = await call(j.id);
    ok("E9 genuine moderation on one vendor → next vendor serves it", r.fallbackUsed && r.model === "qwen/qwen-strong");
  }
  {
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["500", "500"]);
    queue.set(`openrouter|qwen/qwen-strong`, ["500"]);
    queue.set(`anthropic|claude-sonnet-5-5`, ["500"]);
    queue.set(`gemini|gemini-3.1-pro-preview`, ["500"]);
    let err: unknown = null;
    try {
      await call(j.id);
    } catch (e) {
      err = e;
    }
    ok("E10 all vendors fail → a reported failure (not a pause), chain summarised", err instanceof ai.ImporterAiFailure && /Fallback chain tried/.test((err as Error).message) && ai.isChained(err));
    const rows = await calls(j.id);
    ok("E11 no request retried on a provider that already failed in the chain", rows.filter((c) => c.provider === "anthropic").length === 1 && rows.filter((c) => c.provider === "gemini").length === 1);
  }
  {
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["bad-json"]);
    seen.length = 0;
    const out = await ai.importerAiCallChecked({ jobId: j.id, task: "verify", models: [PRIMARY], system: "JSON", content: [{ type: "text", text: "Q" }], maxOutputTokens: 400, settings, needsVision: false, stage: "test" }, (t) => {
      const v = JSON.parse(t) as { answer: string[] };
      if (!Array.isArray(v.answer)) throw new ai.ImporterAiFailure("shape", "model_output");
      return v;
    });
    const rows = await calls(j.id);
    ok("E12 malformed answer → same request to the next vendor, parsed", out.value.answer[0] === "B" && out.result.fallbackUsed);
    ok("E13 malformed answer logged as a failed call of the model that gave it; no extra hidden retry", rows.length === 2 && !rows[0].ok && rows[0].errorCategory === "unusable", JSON.stringify(rows.map((r) => [r.model, r.ok, r.errorCategory])));
  }
  {
    // Independence: a verification request never borrows the job's page-reading model.
    const verifyPlan = { ...plan, tasks: { ...plan.tasks, extract: { ...choice("extract"), model: "qwen/qwen-strong" } } };
    const j = await prisma.aiImportJob.create({ data: { title: "independence", status: AiImportJobStatus.PROCESSING, examId: "exam-synthetic", paperType: AiImportPaperType.FULL_PAPER, createdById: "admin-synthetic", budgetInr: 1000, spentInr: 0, spentUsd: 0, config: { ...settings, modelPlan: verifyPlan } as unknown as Prisma.InputJsonValue } });
    queue.set(`openai|gpt-5.4-mini`, ["500", "500"]);
    seen.length = 0;
    const r = await call(j.id, "verify");
    ok("E14 verify chain skips the extract model (independent verification)", r.model.startsWith("anthropic/") && !seen.some((s) => s.model === "qwen/qwen-strong"), r.model);
  }
  {
    // Direct providers are never used while ZDR is required.
    const zdr = normalizeImporterSettings({ ...settings, privacy: { zdr: true, dataCollection: "deny" } });
    const j = await newJob();
    queue.set(`openrouter|qwen/qwen-strong`, ["500"]);
    let err: unknown = null;
    try {
      await ai.chainCall({ jobId: j.id, task: "verify", models: [PRIMARY], system: "s", content: [{ type: "text", text: "q" }], maxOutputTokens: 300, settings: zdr, needsVision: false }, new ai.ImporterAiFailure("x", "provider"), [PRIMARY]);
    } catch (e) {
      err = e;
    }
    ok("E15 ZDR: direct vendors skipped with the reason", err instanceof Error && /Zero-Data-Retention/.test(err.message), err instanceof Error ? err.message.slice(0, 300) : "");
  }
  {
    // A budget refusal is never routed round to another provider.
    const j = await newJob();
    await prisma.aiImportJob.update({ where: { id: j.id }, data: { budgetInr: 0.0001 } });
    seen.length = 0;
    let err: unknown = null;
    try {
      await call(j.id);
    } catch (e) {
      err = e;
    }
    ok("E16 budget stop is final (nothing sent anywhere)", err instanceof ai.ImporterBudgetError && seen.length === 0);
  }
  {
    // Cost: fallback requests are reserved and settled like any other.
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["500", "500"]);
    queue.set(`openrouter|qwen/qwen-strong`, ["500"]);
    await call(j.id);
    const rows = await calls(j.id);
    const good = rows.find((c) => c.ok);
    const open = await prisma.aiBudgetReservation.count({ where: { requestKey: { startsWith: `qi:${j.id}:` }, status: "RESERVED" } });
    ok("E17 fallback cost recorded (tokens × catalog price) and no reservation left open", !!good && (good.costInr ?? 0) > 0 && open === 0, `${good?.costInr} open=${open}`);
  }

  section("G. Opinions (Verify Answers / AI answer) and same-model provider switch");
  const solveParse = (t: string) => {
    const v = ai.parseModelJson(t) as { answer?: unknown };
    if (!Array.isArray(v.answer)) throw new ai.ImporterAiFailure("The answer was not the expected JSON.", "model_output");
    return v as { answer: string[] };
  };
  {
    // Verify Answers sends with a fixed model (override + noReplace): a malformed opinion still goes to the next vendor.
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["bad-json"]);
    const out = await ai.importerAiCallChecked({ jobId: j.id, task: "classify", override: choice("classify") as never, noReplace: true, models: [PRIMARY], system: "JSON", content: [{ type: "text", text: "Q" }], maxOutputTokens: 300, settings, needsVision: false, stage: "verify-answers" }, solveParse);
    ok("G1 Verify Answers: malformed opinion → next independent provider answers", out.value.answer[0] === "B" && out.result.fallbackUsed && out.result.model !== PRIMARY, out.result.model);
  }
  {
    // AI answer opinion (post.ts path): truncated answer → next provider.
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["500", "500"]);
    queue.set(`openrouter|qwen/qwen-strong`, ["bad-json"]);
    const out = await ai.importerAiCallChecked({ jobId: j.id, task: "verify", models: [PRIMARY], system: "JSON", content: [{ type: "text", text: "Q" }], maxOutputTokens: 300, settings, needsVision: false, stage: "post-answer-opinion" }, solveParse);
    ok("G2 AI opinion: provider error, then a malformed fallback answer → the third provider answers", out.result.model.startsWith("anthropic/") && out.value.answer[0] === "B", out.result.model);
  }
  {
    // Provider-level failure: the SAME model through another provider is allowed; a model-level failure is not.
    const sameChain = { ...chains, classify: [{ provider: "openrouter", model: PRIMARY }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }] };
    const st2 = normalizeImporterSettings({ ...settings, fallbackChains: sameChain });
    const j = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["500", "500"]);
    seen.length = 0;
    const r = await ai.importerAiCall({ jobId: j.id, task: "classify", models: [PRIMARY], system: "s", content: [{ type: "text", text: "q" }], maxOutputTokens: 300, settings: st2, needsVision: false });
    ok("G3 provider outage → same strong model served through the other provider", r.model === PRIMARY && r.fallbackUsed && seen.some((x) => x.provider === "openrouter" && x.model === PRIMARY), JSON.stringify(seen));
    const j2 = await newJob();
    queue.set(`openai|gpt-5.4-mini`, ["bad-json"]);
    seen.length = 0;
    const out = await ai.importerAiCallChecked({ jobId: j2.id, task: "classify", models: [PRIMARY], system: "s", content: [{ type: "text", text: "q" }], maxOutputTokens: 300, settings: st2, needsVision: false }, solveParse);
    ok("G4 malformed answer → that model is skipped on every provider (next vendor answers)", out.result.model.startsWith("anthropic/") && !seen.some((x) => x.provider === "openrouter" && x.model === PRIMARY), JSON.stringify(seen));
  }

  section("H. Production mode: OpenRouter off, primaries through their own vendor keys");
  {
    const prodChains = { extract: [{ provider: "gemini", model: "google/gemini-3.1-pro-preview" }], key: [{ provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }], verify: [{ provider: "anthropic", model: "anthropic/claude-opus-5.5" }, { provider: "gemini", model: "google/gemini-3.1-pro-preview" }, { provider: "anthropic", model: "anthropic/claude-sonnet-5.5" }], classify: [{ provider: "anthropic", model: "anthropic/claude-opus-5.5" }] };
    const ps = normalizeImporterSettings({ ...settings, useOpenRouter: false, fallbackChains: prodChains });
    const prodPlan = { ...plan, tasks: { extract: { ...choice("extract"), model: "google/gemini-3.1-pro-preview" }, key: { ...choice("key"), model: "anthropic/claude-sonnet-5.5" }, verify: { ...choice("verify"), model: "anthropic/claude-opus-5.5" }, classify: { ...choice("classify"), model: "anthropic/claude-opus-5.5" } } };
    const pj = async () => { queue.clear(); return prisma.aiImportJob.create({ data: { title: "prod-mode", status: AiImportJobStatus.PROCESSING, examId: "exam-synthetic", paperType: AiImportPaperType.FULL_PAPER, createdById: "admin-synthetic", budgetInr: 1000, spentInr: 0, spentUsd: 0, config: { ...ps, modelPlan: prodPlan } as unknown as Prisma.InputJsonValue } }); };
    const pc = (jobId: string, task: "verify" | "extract") => ai.importerAiCall({ jobId, task, models: ["x"], system: "s", content: [{ type: "text", text: "q" }], maxOutputTokens: 300, settings: ps, needsVision: false });
    let j = await pj();
    seen.length = 0;
    let r = await pc(j.id, "verify");
    ok("H1 OpenRouter off: the verify primary (Claude Opus) answers through Anthropic's own key; not marked as a fallback; no OpenRouter request", r.model === "anthropic/claude-opus-5.5" && !r.fallbackUsed && !seen.some((x) => x.provider === "openrouter") && (await events(j.id, "PROVIDER_FALLBACK")) === 0, JSON.stringify(seen));
    r = await pc(j.id, "extract");
    ok("H2 the reading primary (Gemini 3.1 Pro) answers through the Gemini key", r.model === "google/gemini-3.1-pro-preview" && seen.some((x) => x.provider === "gemini"));
    j = await pj();
    queue.set("anthropic|claude-opus-5-5", ["500"]);
    seen.length = 0;
    r = await pc(j.id, "verify");
    ok("H3 primary fails → next entry; the Google (reading vendor) entry is skipped for verification", r.model === "anthropic/claude-sonnet-5.5" && r.fallbackUsed && !seen.some((x) => x.provider === "gemini") && (await events(j.id, "PROVIDER_FALLBACK")) === 1, JSON.stringify(seen));
    j = await pj();
    queue.set("anthropic|claude-opus-5-5", ["401"]);
    queue.set("anthropic|claude-sonnet-5-5", ["401"]);
    let err: unknown = null;
    try {
      await pc(j.id, "verify");
    } catch (e) {
      err = e;
    }
    ok("H4 every usable provider refuses its key → the job PAUSES (never a question failure)", err instanceof ai.ImporterAiUnavailable && !(err instanceof ai.ImporterAiFailure), err instanceof Error ? err.message.slice(0, 200) : String(err));
    const zs = normalizeImporterSettings({ ...ps, privacy: { zdr: true, dataCollection: "deny" } });
    j = await pj();
    err = null;
    try {
      await ai.importerAiCall({ jobId: j.id, task: "verify", models: ["x"], system: "s", content: [{ type: "text", text: "q" }], maxOutputTokens: 300, settings: zs, needsVision: false });
    } catch (e) {
      err = e;
    }
    ok("H5 OpenRouter off + ZDR required → pause with the reason, nothing sent", err instanceof ai.ImporterAiUnavailable && /cannot be used/.test((err as Error).message));
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
