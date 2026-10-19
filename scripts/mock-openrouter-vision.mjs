/**
 * Mock of OpenRouter (+ the Frankfurter USD→INR endpoint) for the AI Question
 * Importer suites. Never talks to OpenRouter. Bound to 127.0.0.1; the app
 * uses it through OPENROUTER_TEST_BASE_URL / FX_TEST_BASE_URL.
 *
 *   node scripts/mock-openrouter-vision.mjs <port> <fixtures/mock-vision.json>
 *
 * Page images carry a coloured marker square in the top-right corner
 * (scripts/ai-import-fixtures.ts → markerRgb); the mock decodes it to pick
 * the scripted page answer, as a vision model would read the page.
 * Models (USD per token):
 *   mockvision/reader   0.0000005 / 0.000003   vision — primary extractor
 *   mockvision/checker  0.00000025 / 0.000002  vision — independent second read (fixture `checker` variant)
 *   mockvision/fail     0.0000005 / 0.000003   vision, always 502 (fallback test; same price as reader)
 *   mockvision/pricey   0.00005 / 0.00015      vision — exceeds the per-request ceiling
 *   mockvision/slow     vision, answers after 6 s (interrupt test)
 *   mocktext/classifier 0.0000001 / 0.0000004  text only
 *   mockvision/imgpriced 0.0000005 / 0.000003, pricing.image 0.00001 — input-image price on top of tokens
 *   mockvision/badimg   vision, pricing.image "n/a" (unreadable image price → unusable)
 * GET /__mock/stats · POST /__mock/reset
 * POST /__mock/config {keyLimitRemaining: number|null, costMultiplier: number, modelsStatus: number|null, chatDelayMs: number,
 *   endpointsStatus: number|null, zdrStatus: number|null, routeStatus: {id: status}, noEndpoint: [id], zdrRemoved: [id]}
 *   — key credit left (null = key without a limit), reported cost × multiplier, /models failure, route-metadata
 *   failures, per-model route status, models chat answers "no endpoints" for, models taken off the ZDR list.
 * GET /models/{id}/endpoints and GET /endpoints/zdr serve the routes (stats.routeReads counts them).
 * Model Assistant / reliability fixtures (config {extraModels: true}; off by default so the other suites see the
 * usual catalog): mockfree/reader + mockfree/checker (published price 0), mockpaid/ocr + mockpaid/verify (priced
 * vision), mocktext/cheap (text only). config {rateLimit: {id: n}} answers the next n requests to a model with
 * HTTP 429 "Provider returned error" (n = -1: always); {badRequest: {id: message}} answers HTTP 400;
 * {failTask: {extract|key|solve|classify: [status, message]}} fails every request of one importer task.
 * stats.attempts counts every chat attempt per model (rate-limited ones included).
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const port = Number(process.argv[2] || 3501);
const fixtures = JSON.parse(readFileSync(process.argv[3], "utf8"));

// Prices fit the importer's pilot ceiling (₹1 per request) at the mock rate of ₹95/USD.
const MODELS = {
  "mockvision/reader": { p: 0.00000005, c: 0.0000003, vision: true, routes: [["mockprov/zdr", 1], ["mockprov/zdr-eu", 1.1]] },
  "mockvision/checker": { p: 0.00000008, c: 0.0000004, vision: true },
  "mockvision/fail": { p: 0.00000005, c: 0.0000003, vision: true, routes: [["mockprov/zdr", 1], ["mockprov/zdr-eu", 1.1]] },
  "mockvision/pricey": { p: 0.00005, c: 0.00015, vision: true },
  "mockvision/slow": { p: 0.00000005, c: 0.0000003, vision: true },
  "mocktext/classifier": { p: 0.0000001, c: 0.0000004, vision: false },
  "mockvision/imgpriced": { p: 0.00000005, c: 0.0000003, vision: true, image: "0.0000005" },
  "mockvision/badimg": { p: 0.00000005, c: 0.0000003, vision: true, image: "n/a" },
  // Automatic selection fixtures: the cheapest vision model has no Zero-Data-Retention route;
  // "down" is cheap but its only route is unhealthy; "mid" sits between reader and checker.
  "mockvision/cheapnozdr": { p: 0.00000001, c: 0.0000001, vision: true, zdr: false },
  "mockvision/down": { p: 0.00000002, c: 0.0000002, vision: true, status: -5 },
  "mockvision/mid": { p: 0.00000006, c: 0.00000035, vision: true },
};
const EXTRA = {
  "mockfree/reader": { p: 0, c: 0, vision: true, json: true },
  "mockfree/checker": { p: 0, c: 0, vision: true, json: true },
  "mockpaid/ocr": { p: 0.00000004, c: 0.00000025, vision: true, json: true },
  "mockpaid/verify": { p: 0.00000007, c: 0.00000035, vision: true, json: true },
  "mocktext/cheap": { p: 0.00000005, c: 0.0000002, vision: false, json: true },
};
const M = () => (config.extraModels ? { ...MODELS, ...EXTRA } : MODELS);
/** Provider routes of a model: [tag, price factor]; every model is ZDR unless `zdr: false`. */
const routesOf = (id) => {
  const m = M()[id];
  return (m.routes ?? [[m.zdr === false ? "mockprov/std" : "mockprov/zdr", 1]]).map(([tag, f]) => ({
    name: `Mock | ${id}`,
    model_id: id,
    provider_name: "MockProvider",
    tag,
    status: config.routeStatus[id] ?? m.status ?? 0,
    context_length: 200000,
    max_completion_tokens: 16000,
    supported_parameters: ["max_tokens", "temperature"],
    pricing: { prompt: String(m.p * f), completion: String(m.c * f), ...(m.image ? { image: m.image } : {}) },
  }));
};
const zdrRoute = (id) => !config.zdrRemoved.includes(id) && routesOf(id).some((r) => r.tag !== "mockprov/std");
const DEFAULT_CONFIG = { keyLimitRemaining: 9, costMultiplier: 1, modelsStatus: null, chatDelayMs: 0, endpointsStatus: null, zdrStatus: null, routeStatus: {}, noEndpoint: [], zdrRemoved: [], extraModels: false, rateLimit: {}, badRequest: {}, failTask: {} };
const config = structuredClone(DEFAULT_CONFIG);
const PALETTE = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170]];
const markerRgb = (n) => ({ r: PALETTE[n][0], g: PALETTE[n][1], b: PALETTE[n][2] });

const stats = { chat: 0, byModel: {}, byTask: {}, byMarker: {}, privacy: [], zdr: [], requireParams: [], routeReads: 0, bodies: 0, attempts: {}, rateLimited: 0 };
let seq = 0;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const err = (res, status, message) => json(res, status, { error: { code: status, message } });

async function markerOf(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const img = sharp(Buffer.from(b64, "base64"));
  const { width, height } = await img.metadata();
  const size = Math.max(4, Math.round(width * 0.02));
  const { data } = await img.extract({ left: width - Math.round(width * 0.035), top: Math.round(height * 0.005), width: size, height: size }).raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i + 2 < data.length; i += 3) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  r /= n;
  g /= n;
  b /= n;
  let best = null;
  for (let id = 1; id < PALETTE.length; id++) {
    const c = markerRgb(id);
    const d = Math.hypot(c.r - r, c.g - g, c.b - b);
    if (d < 70 && (!best || d < best.d)) best = { id, d };
  }
  return best ? String(best.id) : null;
}

function classify(text) {
  const subjects = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const s = /^SUBJECT (\S+) = (.+)$/.exec(line);
    const t = /^\s+TOPIC (\S+) = (.+)$/.exec(line);
    if (s) subjects.push((cur = { id: s[1], name: s[2], topics: [] }));
    else if (t && cur) cur.topics.push({ id: t[1], name: t[2] });
  }
  const results = [];
  for (const m of text.matchAll(/^\[([a-z0-9]+)\] (.*)$/gm)) {
    const q = m[2].toLowerCase();
    let hit = null;
    for (const s of subjects) for (const t of s.topics) if (!hit && q.includes(t.name.toLowerCase())) hit = { s, t };
    results.push(hit ? { q: m[1], subject: hit.s.id, topic: hit.t.id, confidence: 0.9 } : { q: m[1], subject: subjects[0]?.id ?? null, topic: null, confidence: 0.3 });
  }
  return { results };
}

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
  if (url.pathname === "/__mock/stats") return json(res, 200, stats);
  if (url.pathname === "/__mock/reset") {
    Object.assign(stats, { chat: 0, byModel: {}, byTask: {}, byMarker: {}, privacy: [], zdr: [], requireParams: [], routeReads: 0, bodies: 0, attempts: {}, rateLimited: 0 });
    Object.assign(config, structuredClone(DEFAULT_CONFIG));
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/__mock/config") {
    Object.assign(config, body);
    return json(res, 200, config);
  }
  if (url.pathname === "/v1/latest") return json(res, 200, { amount: 1, base: "USD", date: "2026-10-16", rates: { INR: 95 } });
  const p = url.pathname.replace(/^\/api\/v1/, "");
  if (req.method === "GET" && p === "/models") {
    if (config.modelsStatus) return err(res, config.modelsStatus, "mock: models unavailable");
    return json(res, 200, {
      data: Object.entries(M()).map(([id, m]) => ({ id, name: id, context_length: 200000, architecture: { input_modalities: m.vision ? ["text", "image"] : ["text"], output_modalities: ["text"] }, pricing: { prompt: String(m.p), completion: String(m.c), ...(m.image ? { image: m.image } : {}) }, top_provider: { max_completion_tokens: 16000 }, supported_parameters: ["max_tokens", "temperature", ...(m.json ? ["response_format"] : [])] })),
    });
  }
  if (req.method === "GET" && p === "/images/models") return json(res, 200, { data: [] });
  if (req.method === "GET" && p === "/endpoints/zdr") {
    stats.routeReads++;
    if (config.zdrStatus) return err(res, config.zdrStatus, "mock: zdr list unavailable");
    return json(res, 200, { data: Object.keys(M()).filter(zdrRoute).flatMap((id) => routesOf(id).filter((r) => r.tag !== "mockprov/std")) });
  }
  const epm = /^\/models\/(.+)\/endpoints$/.exec(p);
  if (req.method === "GET" && epm) {
    stats.routeReads++;
    if (config.endpointsStatus) return err(res, config.endpointsStatus, "mock: endpoints unavailable");
    const id = decodeURIComponent(epm[1]);
    if (!M()[id]) return err(res, 404, "Model not found");
    return json(res, 200, { data: { id, name: id, endpoints: routesOf(id) } });
  }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer sk-or-")) return err(res, 401, "No auth credentials found");
  if (req.method === "GET" && p === "/key") return json(res, 200, { data: { label: "mock", limit: config.keyLimitRemaining === null ? null : 10, limit_remaining: config.keyLimitRemaining, usage: 1 } });
  if (req.method === "POST" && p === "/chat/completions") {
    stats.chat++;
    stats.privacy.push(body.provider?.data_collection ?? null);
    stats.zdr.push(body.provider?.zdr === true);
    stats.requireParams.push(body.provider?.require_parameters === true);
    const system = String(body.messages?.find((m) => m.role === "system")?.content ?? "");
    const user = body.messages?.find((m) => m.role === "user")?.content;
    const parts = Array.isArray(user) ? user : [{ type: "text", text: String(user ?? "") }];
    const text = parts.filter((x) => x.type === "text").map((x) => x.text).join("\n");
    const image = parts.find((x) => x.type === "image_url")?.image_url?.url ?? null;
    const task = system.includes("You transcribe ONE page") ? "extract" : system.includes("ANSWER KEY") ? "key" : system.includes("independent subject-matter checker") ? "solve" : system.includes("classify exam questions") ? "classify" : "other";
    stats.byTask[task] = (stats.byTask[task] ?? 0) + 1;
    const order = Array.isArray(body.models) && body.models.length ? body.models : [body.model];
    let last = [404, "No endpoints found"];
    for (const id of order) {
      const m = M()[id];
      if (!m) {
        last = [404, `${id} is not a valid model ID`];
        continue;
      }
      stats.attempts[id] = (stats.attempts[id] ?? 0) + 1;
      const rl = config.rateLimit[id];
      if (rl === -1 || rl > 0) {
        if (rl > 0) config.rateLimit[id] = rl - 1;
        stats.rateLimited++;
        last = [429, "Provider returned error"];
        continue;
      }
      if (config.badRequest[id]) {
        last = [400, config.badRequest[id]];
        continue;
      }
      if (config.failTask[task]) {
        last = config.failTask[task];
        continue;
      }
      if (image && !m.vision) {
        last = [404, "No endpoints found that support image input"];
        continue;
      }
      if (config.noEndpoint.includes(id) || (body.provider?.zdr === true && !zdrRoute(id))) {
        last = [404, "No endpoints found matching your data policy (Zero data retention)"];
        continue;
      }
      if (id === "mockvision/fail") {
        last = [502, "Provider returned error"];
        continue;
      }
      const maxP = body.provider?.max_price;
      if (maxP && (m.p * 1e6 > maxP.prompt + 1e-9 || m.c * 1e6 > maxP.completion + 1e-9)) {
        last = [404, "No endpoints found that satisfy your max_price"];
        continue;
      }
      if (id === "mockvision/slow") await new Promise((r) => setTimeout(r, 6000));
      if (config.chatDelayMs) await new Promise((r) => setTimeout(r, config.chatDelayMs));
      stats.byModel[id] = (stats.byModel[id] ?? 0) + 1;
      let out;
      if (task === "extract") {
        const marker = image ? await markerOf(image) : null;
        stats.byMarker[marker ?? "none"] = (stats.byMarker[marker ?? "none"] ?? 0) + 1;
        const fx = marker ? fixtures.pages[marker] : null;
        // Marker 5: a synthetic multi-page scanned paper — two questions per page, numbered from the page number.
        const pageNo = Number(/Page (\d+) of/.exec(text)?.[1] ?? 0);
        if (marker === "5") out = { questions: [1, 2].map((k) => ({ number: 2 * pageNo - 2 + k, type: "SINGLE_CORRECT", stem: `Synthetic scanned page ${pageNo}, item ${k}: which option is the synthetic answer?`, options: ["Alpha", "Beta", "Gamma", "Delta"].map((t, i) => ({ label: `(${"ABCD"[i]})`, text: `${t} ${pageNo}.${k}` })), figures: [], confidence: 0.95 })), answer_key: [], page_notes: "" };
        else if (!fx) out = { questions: [], answer_key: [], page_notes: "nothing recognized" };
        else out = { questions: id === "mockvision/checker" && fx.checker ? fx.checker.questions : fx.questions, answer_key: fx.answer_key ?? [], page_notes: "" };
      } else if (task === "key") {
        const marker = image ? await markerOf(image) : null;
        out = marker && fixtures.keys[marker] ? { entries: fixtures.keys[marker].entries, unreadable: [] } : { entries: [], unreadable: ["nothing"] };
      } else if (task === "solve") out = { answer: ["B"], confidence: 0.8, defective: false, reason: "mock" };
      else if (task === "classify") out = classify(text);
      else out = { error: "unknown task" };
      const content = JSON.stringify(out);
      const pt = Math.ceil((system.length + text.length) / 4) + (image ? 1200 : 0);
      const ct = Math.ceil(content.length / 4);
      const cost = Math.round((pt * m.p + ct * m.c + (image && m.image ? Number(m.image) || 0 : 0)) * config.costMultiplier * 1e12) / 1e12;
      return json(res, 200, { id: `gen-vision-${Date.now()}-${++seq}`, model: id, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, cost } });
    }
    return err(res, last[0], last[1]);
  }
  return err(res, 404, `mock: no route ${req.method} ${p}`);
});
server.listen(port, "127.0.0.1", () => console.log(`mock-openrouter-vision on 127.0.0.1:${port}`));
