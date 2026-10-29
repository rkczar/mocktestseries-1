/**
 * Mock of the OpenRouter API (and of the Frankfurter USD→INR endpoint) for the
 * AI Engine tests. Never talks to OpenRouter. Bound to 127.0.0.1 only; the app
 * accepts it only through OPENROUTER_TEST_BASE_URL / FX_TEST_BASE_URL =
 * http://127.0.0.1:<port>.
 *
 *   node scripts/mock-openrouter.mjs 3193
 *
 * Key scenario = the fake key's suffix: sk-or-v1-mock…-valid | -bad (401) | -nocredit (402 on generation).
 * Models (prices in USD per token, like the real API):
 *   mockai/cheap         0.0000001 / 0.0000004   ctx 128k   (cheapest)
 *   mockai/mid           0.000001  / 0.000004
 *   mockai/premium       0.000005  / 0.00002
 *   mockai/tinyctx       ctx 1000
 *   mockai/fail429       always 429           mockai/fail500  always 502
 *   mockai/slow          answers after 7 s    mockai/empty    empty content
 *   mockai/nocost        no usage.cost (cost only via /generation)
 *   mockai/collector     unavailable when provider.data_collection = "deny"
 *   openrouter/auto      pricing -1 (variable)
 * Image API models: mockimg/perimage ($0.02 / image), mockimg/pertoken ($0.00003 / token), mockimg/fail.
 * Text answers reuse scripts/mock-anthropic.mjs#answerFor (the app's real prompts).
 * GET /__mock/stats, POST /__mock/reset, GET /__mock/fx?rate=…|status=500
 */
import http from "node:http";
import { answerFor } from "./mock-anthropic.mjs";

export const TEXT_MODELS = {
  "mockai/cheap": { p: 0.0000001, c: 0.0000004, ctx: 128000 },
  "mockai/mid": { p: 0.000001, c: 0.000004, ctx: 128000 },
  "mockai/premium": { p: 0.000005, c: 0.00002, ctx: 200000 },
  "mockai/tinyctx": { p: 0.00000005, c: 0.0000001, ctx: 1000 },
  "mockai/fail429": { p: 0.00000001, c: 0.00000001, ctx: 128000 },
  "mockai/fail500": { p: 0.00000002, c: 0.00000002, ctx: 128000 },
  "mockai/slow": { p: 0.000003, c: 0.000003, ctx: 128000 },
  "mockai/empty": { p: 0.0000031, c: 0.0000031, ctx: 128000 },
  "mockai/nocost": { p: 0.0000032, c: 0.0000032, ctx: 128000 },
  "mockai/collector": { p: 0.00000003, c: 0.00000003, ctx: 128000 },
  // AI reliability suite (scripts/verify-ai-reliability.ts) — answer-shape failures seen in production 2026-10:
  "mockai/verdict": { p: 0.00000004, c: 0.00000004, ctx: 128000 }, //    "User Safety: safe" (a classifier, id not recognisable)
  "mockai/prose": { p: 0.00000005, c: 0.00000005, ctx: 128000 }, //      chatty prose, no JSON
  "mockai/cutoff": { p: 0.00000006, c: 0.00000006, ctx: 128000 }, //     JSON cut off, finish_reason "length"
  "mockai/thinker": { p: 0.00000007, c: 0.00000007, ctx: 128000 }, //    reasoning only, empty content, "length"
  "mockai/drip": { p: 0.00000008, c: 0.00000008, ctx: 128000 }, //       headers at once, body over 8 s
  "mockai/retry429": { p: 0.00000009, c: 0.00000009, ctx: 128000 }, //   429 + Retry-After: 1 on every 1st call, then answers
  "mockai/x-content-safety": { p: 0.00000001, c: 0.00000001, ctx: 128000 }, // excluded by id (never called)
};
export const IMAGE_MODELS = { "mockimg/perimage": { unit: "image", cost: 0.02 }, "mockimg/pertoken": { unit: "token", cost: 0.00003 }, "mockimg/fail": { unit: "image", cost: 0.01 } };
// 8x8 PNG (valid for sharp).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

export function mockKey(scenario) {
  const rand = Array.from({ length: 40 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
  return `sk-or-v1-mock${rand}-${scenario}`;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const err = (res, status, message) => json(res, status, { error: { code: status, message } });

function evalAnswer(prompt) {
  if (prompt.includes("Answer this single-best-answer MCQ")) return JSON.stringify({ answer: "A", confidence: 0.9, reason: "Mock reason." });
  return null;
}

export function startMockOpenRouter(port) {
  const stats = { chat: 0, images: 0, key: 0, models: 0, generation: 0, fx: 0, bodies: [], authHeaders: 0 };
  const fx = { rate: 95.5, status: 200 };
  const generations = new Map();
  let seq = 0;
  let retry429Calls = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let raw = "";
    for await (const c of req) raw += c;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return err(res, 400, "bad json");
    }
    if (url.pathname === "/__mock/stats") return json(res, 200, { ...stats, bodies: stats.bodies.slice(-20) });
    if (url.pathname === "/__mock/reset") {
      Object.assign(stats, { chat: 0, images: 0, key: 0, models: 0, generation: 0, fx: 0, bodies: [], authHeaders: 0 });
      retry429Calls = 0;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/__mock/fx") {
      if (url.searchParams.get("rate")) fx.rate = Number(url.searchParams.get("rate"));
      if (url.searchParams.get("status")) fx.status = Number(url.searchParams.get("status"));
      return json(res, 200, fx);
    }
    if (url.pathname === "/v1/latest") {
      stats.fx++;
      if (fx.status !== 200) return err(res, fx.status, "fx down");
      return json(res, 200, { amount: 1, base: "USD", date: "2026-10-12", rates: { INR: fx.rate } });
    }
    const auth = req.headers.authorization ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (key) stats.authHeaders++;
    const scenario = key.split("-").pop();
    const p = url.pathname.replace(/^\/api\/v1/, "");

    if (req.method === "GET" && p === "/models") {
      stats.models++;
      const data = Object.entries(TEXT_MODELS).map(([id, m]) => ({
        id,
        name: id,
        context_length: m.ctx,
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        pricing: { prompt: String(m.p), completion: String(m.c) },
        top_provider: { max_completion_tokens: 16000 },
        supported_parameters: id === "mockai/thinker" ? ["max_tokens", "temperature", "response_format", "reasoning"] : ["max_tokens", "temperature", "response_format"],
      }));
      data.push({ id: "openrouter/auto", name: "Auto Router", context_length: 2000000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "-1", completion: "-1" }, top_provider: {}, supported_parameters: [] });
      return json(res, 200, { data });
    }
    if (req.method === "GET" && p === "/images/models") {
      return json(res, 200, { data: Object.keys(IMAGE_MODELS).map((id) => ({ id, name: id, architecture: { input_modalities: ["text"], output_modalities: ["image"] }, supported_parameters: { aspect_ratio: { type: "enum", values: ["4:3"] } }, endpoints: `/api/v1/images/models/${id}/endpoints` })) });
    }
    const ep = /^\/images\/models\/(.+)\/endpoints$/.exec(p);
    if (req.method === "GET" && ep) {
      const m = IMAGE_MODELS[decodeURIComponent(ep[1])];
      if (!m) return err(res, 404, "not found");
      return json(res, 200, { id: ep[1], endpoints: [{ provider_name: "MockImg", pricing: [{ billable: "output_image", unit: m.unit, cost_usd: m.cost }] }] });
    }

    if (!key.startsWith("sk-or-")) return err(res, 401, "No auth credentials found");
    if (scenario === "bad") return err(res, 401, "User not found.");

    if (req.method === "GET" && p === "/key") {
      stats.key++;
      return json(res, 200, { data: { label: "mock key", limit: 10, limit_remaining: 9.5, limit_reset: "monthly", usage: 0.5, usage_daily: 0.1, usage_monthly: 0.5, is_free_tier: false } });
    }
    if (req.method === "GET" && p === "/generation") {
      stats.generation++;
      const g = generations.get(url.searchParams.get("id"));
      if (!g) return err(res, 404, "Generation not found");
      return json(res, 200, { data: { id: url.searchParams.get("id"), total_cost: g.cost, usage: g.cost, model: g.model, native_tokens_prompt: g.pt, native_tokens_completion: g.ct, latency: 100 } });
    }
    if (req.method === "POST" && p === "/chat/completions") {
      stats.chat++;
      stats.bodies.push({ model: body.model, models: body.models, provider: body.provider, plugins: body.plugins, max_tokens: body.max_tokens, response_format: body.response_format, reasoning: body.reasoning });
      if (scenario === "nocredit") return err(res, 402, "Insufficient credits. Add more using https://openrouter.ai/credits");
      const c0 = body.messages?.[0]?.content;
      const prompt = Array.isArray(c0) ? c0.filter((x) => x?.type === "text").map((x) => x.text).join("\n") : String(c0 ?? "");
      let order = Array.isArray(body.models) && body.models.length ? body.models : [body.model];
      if (body.model === "openrouter/auto") {
        const allowed = body.plugins?.find((x) => x.id === "auto-router")?.allowed_models ?? Object.keys(TEXT_MODELS);
        order = allowed.filter((m) => TEXT_MODELS[m] && !m.includes("fail"));
      }
      let lastErr = [404, "No endpoints found"];
      for (const id of order) {
        const m = TEXT_MODELS[id];
        if (!m) {
          lastErr = [404, `${id} is not a valid model ID`];
          continue;
        }
        if (id === "mockai/fail429") {
          lastErr = [429, "Rate limit exceeded"];
          continue;
        }
        if (id === "mockai/fail500") {
          lastErr = [502, "Provider returned error"];
          continue;
        }
        if (id === "mockai/collector" && body.provider?.data_collection === "deny") {
          lastErr = [404, "No endpoints found matching your data policy"];
          continue;
        }
        const maxP = body.provider?.max_price;
        if (maxP && (m.p * 1e6 > maxP.prompt + 1e-9 || m.c * 1e6 > maxP.completion + 1e-9)) {
          lastErr = [404, "No endpoints found that satisfy your max_price"];
          continue;
        }
        if (id === "mockai/slow") await new Promise((r) => setTimeout(r, 7000));
        if (id === "mockai/retry429" && (retry429Calls++ % 2 === 0)) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
          return res.end(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded (retry after 1 s)" } }));
        }
        const shaped = { "mockai/verdict": "User Safety: safe", "mockai/prose": "Sure! Here is a helpful explanation of the topic without any JSON at all.", "mockai/cutoff": '{"concept": "Acute angle-closure glaucoma presents with a painful red eye and', "mockai/thinker": "" }[id];
        if (shaped !== undefined) {
          const gid = `gen-mock-${Date.now()}-${++seq}`;
          generations.set(gid, { cost: 0, model: id, pt: 10, ct: 10 });
          const finish = id === "mockai/cutoff" || id === "mockai/thinker" ? "length" : "stop";
          return json(res, 200, { id: gid, model: id, choices: [{ message: { role: "assistant", content: shaped, ...(id === "mockai/thinker" ? { reasoning: "Let me think step by step about every option..." } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.000001 } });
        }
        if (id === "mockai/drip") {
          const answer = JSON.stringify({ id: `gen-mock-drip-${++seq}`, model: id, choices: [{ message: { role: "assistant", content: evalAnswer(prompt) ?? answerFor(prompt, "valid") }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.000001 } });
          res.writeHead(200, { "content-type": "application/json" });
          for (let i = 0; i < answer.length; i += Math.ceil(answer.length / 8)) {
            res.write(answer.slice(i, i + Math.ceil(answer.length / 8)));
            await new Promise((r) => setTimeout(r, 1000));
          }
          return res.end();
        }
        let text = id === "mockai/empty" ? "" : (evalAnswer(prompt) ?? answerFor(prompt, "valid"));
        const pt = Math.ceil(prompt.length / 4);
        let ct = Math.ceil(text.length / 4);
        let finish = "stop";
        if (body.max_tokens && ct > body.max_tokens) {
          text = text.slice(0, body.max_tokens * 4);
          ct = body.max_tokens;
          finish = "length";
        }
        const cost = Math.round((pt * m.p + ct * m.c) * 1e12) / 1e12;
        const gid = `gen-mock-${Date.now()}-${++seq}`;
        generations.set(gid, { cost, model: id, pt, ct });
        const usage = { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct };
        if (id !== "mockai/nocost") usage.cost = cost;
        return json(res, 200, { id: gid, model: id, choices: [{ message: { role: "assistant", content: text }, finish_reason: finish }], usage });
      }
      return err(res, lastErr[0], lastErr[1]);
    }
    if (req.method === "POST" && p === "/images") {
      stats.images++;
      stats.bodies.push({ image: true, model: body.model, provider: body.provider, aspect_ratio: body.aspect_ratio, resolution: body.resolution });
      if (scenario === "nocredit") return err(res, 402, "Insufficient credits");
      const m = IMAGE_MODELS[body.model];
      if (!m) return err(res, 404, "model not found");
      if (body.model === "mockimg/fail") return err(res, 502, "Image generation failed");
      const cost = m.unit === "image" ? m.cost : m.cost * 1290;
      const gid = `img-mock-${++seq}`;
      generations.set(gid, { cost, model: body.model, pt: 0, ct: 0 });
      return json(res, 200, { id: gid, model: body.model, created: Date.now(), data: [{ b64_json: PNG, media_type: "image/png" }], usage: { cost } });
    }
    return err(res, 404, `mock: no route ${req.method} ${p}`);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stats, fx })));
}

if (process.argv[1] && process.argv[1].endsWith("mock-openrouter.mjs")) {
  const port = Number(process.argv[2] ?? 3193);
  startMockOpenRouter(port).then(() => console.log(`mock OpenRouter on 127.0.0.1:${port}`));
}
