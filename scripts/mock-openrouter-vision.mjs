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
 * Request-parameter / price-integrity fixtures (config {paramModels: true}; off by default): mockparam/notemp — the
 * cheapest priced vision model, but its only route accepts max_tokens only (no temperature), like a route OpenRouter
 * refuses under require_parameters; mockparam/zeroout — vision, ₹0 output price but a non-zero input price.
 * Every chat request with provider.require_parameters is refused (404 "No endpoints found that can handle the
 * requested parameters.") when the model's routes do not list every parameter the request sends.
 * Reliability fixtures (2026-10-20): config {reasonModels: true} adds mockreason/think — a vision model whose routes
 * accept `reasoning`; WITHOUT a `reasoning` setting it spends the whole max_tokens thinking and returns no text
 * (finish_reason "length"), with {effort} or {max_tokens} (a thinking budget) it answers normally. config {batchModels: true} adds
 * mockvision/cheap:batch — the cheapest vision model, refused on chat/completions like OpenRouter's batch variants.
 * config {structModels: true} adds mockstruct/reader, whose routes accept response_format + structured_outputs;
 * stats.responseFormat records each request's response_format type (null when absent) — importer-reliability-2.
 * config {script: {id: [mode, …]}} answers the next requests to a model with an unusable answer, one mode each:
 * "empty" | "length" | "malformed" (cut-off JSON) | "shape" (options as plain strings, null labels / list keys,
 * numbers as strings) | "latex" (unescaped LaTeX backslashes + trailing commas) | "badcodes" (classification codes
 * not on the list). config {keyHeader: {...}} is returned as the answer key's printed header.
 * stats.reasoning records each chat request's `reasoning` setting (null when absent). Script mode "refusal" answers with
 * a plain-text refusal; config {classifyShift: true} makes classification echo the NEXT question's key words and topic
 * (shifted answers), {classifyNoAbout: true} leaves the key words out, {classifyKeep: n} returns only the first n
 * answers (2026-10-23). Script modes "terminated" (HTTP 502 "terminated", a dropped connection) and "baditem" (the first
 * classification result replaced by a malformed entry) — 2026-10-25.
 * Full-paper verification fixtures (2026-10-22): a page fixture may carry `byModel: {id: {questions}}` (what that model
 * reads); `text: [{match, questions, checker?, byModel?}]` answers page-reading requests WITHOUT an image (Verify 2 of a
 * DOCX / sheet) with the first entry whose `match` string occurs in the request text.
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
const REASON = {
  "mockreason/think": { p: 0.00000004, c: 0.00000028, vision: true, json: true, params: ["max_tokens", "temperature", "reasoning"], thinks: true },
};
/** importer-reliability-2: a vision model whose routes accept structured outputs (json_schema / JSON mode). */
const STRUCT = {
  "mockstruct/reader": { p: 0.00000006, c: 0.0000003, vision: true, json: true, params: ["max_tokens", "temperature", "response_format", "structured_outputs"] },
};
const BATCH = {
  "mockvision/cheap:batch": { p: 0.000000005, c: 0.00000005, vision: true, batch: true },
};
const PARAM = {
  "mockparam/notemp": { p: 0.00000002, c: 0.0000001, vision: true, json: true, params: ["max_tokens"] },
  "mockparam/zeroout": { p: 0.00000003, c: 0, vision: true, json: true },
};
const M = () => ({ ...MODELS, ...(config.extraModels ? EXTRA : {}), ...(config.paramModels ? PARAM : {}), ...(config.reasonModels ? REASON : {}), ...(config.batchModels ? BATCH : {}), ...(config.structModels ? STRUCT : {}) });
const paramsOf = (m) => m.params ?? ["max_tokens", "temperature", ...(m.json ? ["response_format"] : [])];
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
    supported_parameters: m.params ?? ["max_tokens", "temperature"],
    pricing: { prompt: String(m.p * f), completion: String(m.c * f), ...(m.image ? { image: m.image } : {}) },
  }));
};
const zdrRoute = (id) => !config.zdrRemoved.includes(id) && routesOf(id).some((r) => r.tag !== "mockprov/std");
const DEFAULT_CONFIG = { classifyKeep: null, classifyShift: false, classifyNoAbout: false, keyLimitRemaining: 9, costMultiplier: 1, modelsStatus: null, chatDelayMs: 0, endpointsStatus: null, zdrStatus: null, routeStatus: {}, noEndpoint: [], zdrRemoved: [], extraModels: false, paramModels: false, reasonModels: false, batchModels: false, script: {}, keyHeader: null, rateLimit: {}, badRequest: {}, failTask: {} };
const config = structuredClone(DEFAULT_CONFIG);
const PALETTE = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170]];
const markerRgb = (n) => ({ r: PALETTE[n][0], g: PALETTE[n][1], b: PALETTE[n][2] });

const stats = { chat: 0, byModel: {}, byTask: {}, byMarker: {}, privacy: [], zdr: [], requireParams: [], reasoning: [], routeReads: 0, bodies: 0, attempts: {}, rateLimited: 0, responseFormat: [], inflight: 0, maxInflight: 0 };
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
    const s = /^SUBJECT (\S+) = (.+?)(?: \(syllabus: .*\))?$/.exec(line);
    const t = /^\s+TOPIC (\S+) = (.+?)(?: \(syllabus: .*\))?$/.exec(line);
    if (s) subjects.push((cur = { id: s[1], name: s[2], topics: [] }));
    else if (t && cur) cur.topics.push({ id: t[1], name: t[2] });
  }
  const results = [];
  const qs = [...text.matchAll(/^\[([A-Za-z0-9]+)\] (.*)$/gm)];
  // Key words echoed from the question (as the prompt asks); config.classifyShift echoes the NEXT question's words
  // and topic (a model that shifted its answers), config.classifyNoAbout leaves them out.
  const about = (t) => t.split(/[^A-Za-z]+/).filter((w) => w.length >= 5).slice(0, 3);
  qs.forEach((m, i) => {
    const src = config.classifyShift ? (qs[i + 1] ?? qs[0]) : m;
    const q = src[2].toLowerCase();
    let hit = null;
    for (const s of subjects) for (const t of s.topics) if (!hit && q.includes(t.name.toLowerCase())) hit = { s, t };
    const r = hit ? { q: m[1], subject: hit.s.id, topic: hit.t.id, confidence: 0.9 } : { q: m[1], subject: subjects[0]?.id ?? null, topic: null, confidence: 0.3 };
    results.push(config.classifyNoAbout ? r : { ...r, about: about(src[2]), reason: "mock" });
  });
  // config.classifyKeep: only the first n answers (a model that stops early / drops questions — 2026-10-23 production).
  return { results: typeof config.classifyKeep === "number" ? results.slice(0, config.classifyKeep) : results };
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
    Object.assign(stats, { chat: 0, byModel: {}, byTask: {}, byMarker: {}, privacy: [], zdr: [], requireParams: [], reasoning: [], routeReads: 0, bodies: 0, attempts: {}, rateLimited: 0, responseFormat: [], inflight: 0, maxInflight: 0 });
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
      data: Object.entries(M()).map(([id, m]) => ({ id, name: id, context_length: 200000, architecture: { input_modalities: m.vision ? ["text", "image"] : ["text"], output_modalities: ["text"] }, pricing: { prompt: String(m.p), completion: String(m.c), ...(m.image ? { image: m.image } : {}) }, top_provider: { max_completion_tokens: 16000 }, supported_parameters: paramsOf(m) })),
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
    stats.reasoning.push(body.reasoning ?? null);
    stats.responseFormat.push(body.response_format?.type ?? null);
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
      // require_parameters: a route must support every parameter sent (as OpenRouter enforces it).
      const sentParams = ["max_tokens", "temperature", "response_format", "reasoning"].filter((k) => body[k] !== undefined);
      if (body.provider?.require_parameters === true && sentParams.some((k) => !(m.params ?? ["max_tokens", "temperature"]).includes(k))) {
        last = [404, "No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection"];
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
      if (m.batch) {
        last = [404, `${id} cannot be used with the chat/completions endpoint (adapter MockBatchAdapter).`];
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
      if (config.chatDelayMs) {
        // stats.maxInflight: the most requests answered at the same time (parallel Verify 2 parts, importer-reliability-2).
        stats.inflight = (stats.inflight ?? 0) + 1;
        stats.maxInflight = Math.max(stats.maxInflight ?? 0, stats.inflight);
        await new Promise((r) => setTimeout(r, config.chatDelayMs));
        stats.inflight--;
      }
      stats.byModel[id] = (stats.byModel[id] ?? 0) + 1;
      let out;
      if (task === "extract") {
        const marker = image ? await markerOf(image) : null;
        stats.byMarker[marker ?? "none"] = (stats.byMarker[marker ?? "none"] ?? 0) + 1;
        const fx = marker ? fixtures.pages[marker] : null;
        // Marker 5: a synthetic multi-page scanned paper — two questions per page, numbered from the page number.
        const pageNo = Number(/Page (\d+) of/.exec(text)?.[1] ?? 0);
        if (marker === "5") out = { questions: [1, 2].map((k) => ({ number: 2 * pageNo - 2 + k, type: "SINGLE_CORRECT", stem: `Synthetic scanned page ${pageNo}, item ${k}: which option is the synthetic answer?`, options: ["Alpha", "Beta", "Gamma", "Delta"].map((t, i) => ({ label: `(${"ABCD"[i]})`, text: `${t} ${pageNo}.${k}` })), figures: [], confidence: 0.95 })), answer_key: [], page_notes: "" };
        else if (!image && Array.isArray(fixtures.text)) {
          // Document text without a page image (Verify 2 of DOCX / sheets): the first fixture whose `match` is in the text.
          const tf = fixtures.text.find((x) => text.includes(x.match));
          out = tf ? { questions: (tf.byModel?.[id] ?? (id === "mockvision/checker" && tf.checker ? tf.checker : tf)).questions, answer_key: [], page_notes: "" } : { questions: [], answer_key: [], page_notes: "nothing recognized" };
        } else if (!fx) out = { questions: [], answer_key: [], page_notes: "nothing recognized" };
        else out = { questions: fx.byModel?.[id]?.questions ?? (id === "mockvision/checker" && fx.checker ? fx.checker.questions : fx.questions), answer_key: fx.answer_key ?? [], page_notes: "" };
      } else if (task === "key") {
        const marker = image ? await markerOf(image) : null;
        out = marker && fixtures.keys[marker] ? { ...(config.keyHeader ? { header: config.keyHeader } : {}), entries: fixtures.keys[marker].entries, unreadable: [] } : { entries: [], unreadable: ["nothing"] };
      } else if (task === "solve") out = { answer: ["B"], confidence: 0.8, defective: false, reason: "mock" };
      else if (task === "classify") out = classify(text);
      else out = { error: "unknown task" };
      let content = JSON.stringify(out);
      let finish = "stop";
      let ctOverride = null;
      // config {scriptMarker: {id: {marker: [mode, …]}}}: like `script`, but only for requests carrying that page image
      // (deterministic when pages are read in parallel — importer-reliability-2).
      const pageMarker = image && config.scriptMarker?.[id] ? await markerOf(image) : null;
      const byMarker = pageMarker && Array.isArray(config.scriptMarker[id][pageMarker]) && config.scriptMarker[id][pageMarker].length ? config.scriptMarker[id][pageMarker].shift() : null;
      // config {scriptPart: {id: {n: [mode, …]}}}: the same for document parts ("part n of m" in the request text), which
      // Verify 2 also reads in parallel — a plain `script` answers whichever part arrives first (2026-10-31).
      const partNo = config.scriptPart?.[id] ? /\bpart (\d+) of \d+/.exec(text)?.[1] : null;
      const byPart = partNo && Array.isArray(config.scriptPart[id][partNo]) && config.scriptPart[id][partNo].length ? config.scriptPart[id][partNo].shift() : null;
      const mode = m.thinks && !body.reasoning?.effort && !body.reasoning?.max_tokens ? "length" : byMarker ?? byPart ?? (Array.isArray(config.script[id]) && config.script[id].length ? config.script[id].shift() : null);
      // 2026-10-25: a connection the provider drops mid-request, and a classification list with one malformed entry.
      if (mode === "terminated") return err(res, 502, "terminated");
      if (mode === "baditem" && out.results) content = JSON.stringify({ results: [{ bogus: true }, ...out.results.slice(1)] });
      else if (mode === "refusal") content = "I'm sorry, but I can't help with transcribing this document.";
      else if (mode === "empty") {
        content = "";
        ctOverride = 0;
      } else if (mode === "length") {
        content = "";
        finish = "length";
        ctOverride = body.max_tokens;
      } else if (mode === "malformed") content = content.slice(0, Math.max(20, Math.floor(content.length / 2)));
      else if (mode === "shape" && out.questions) {
        content = JSON.stringify({ ...out, questions: out.questions.map((q) => ({ ...q, number: String(q.number), stem: q.stem ?? null, options: q.options.map((o, i) => (i % 2 ? o.text : { label: null, text: o.text })), list_i: [{ key: null, text: "first entry" }], confidence: "0.9", printed_answer: null })) });
      } else if (mode === "latex") content = content.replace(/\\\\/g, "\\").replace(/\]/g, ",]").replace(/}$/, ",}");
      else if (mode === "badcodes" && out.results) content = JSON.stringify({ results: out.results.map((r) => ({ ...r, subject: "cmzzzzzzzzzzzzzzzzzzzzzzz", topic: "nonsense" })) });
      const pt = Math.ceil((system.length + text.length) / 4) + (image ? 1200 : 0);
      const ct = ctOverride ?? Math.ceil(content.length / 4);
      const cost = Math.round((pt * m.p + ct * m.c + (image && m.image ? Number(m.image) || 0 : 0)) * config.costMultiplier * 1e12) / 1e12;
      return json(res, 200, { id: `gen-vision-${Date.now()}-${++seq}`, model: id, choices: [{ message: { role: "assistant", content }, finish_reason: finish }], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, cost } });
    }
    return err(res, last[0], last[1]);
  }
  return err(res, 404, `mock: no route ${req.method} ${p}`);
});
server.listen(port, "127.0.0.1", () => console.log(`mock-openrouter-vision on 127.0.0.1:${port}`));
