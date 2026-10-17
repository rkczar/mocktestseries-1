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
 *   mockvision/fail     vision, always 502 (fallback test)
 *   mockvision/pricey   0.00005 / 0.00015      vision — exceeds the per-request ceiling
 *   mockvision/slow     vision, answers after 6 s (interrupt test)
 *   mocktext/classifier 0.0000001 / 0.0000004  text only
 * GET /__mock/stats · POST /__mock/reset
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import sharp from "sharp";

const port = Number(process.argv[2] || 3501);
const fixtures = JSON.parse(readFileSync(process.argv[3], "utf8"));

const MODELS = {
  "mockvision/reader": { p: 0.0000005, c: 0.000003, vision: true },
  "mockvision/checker": { p: 0.00000025, c: 0.000002, vision: true },
  "mockvision/fail": { p: 0.0000004, c: 0.000002, vision: true },
  "mockvision/pricey": { p: 0.00005, c: 0.00015, vision: true },
  "mockvision/slow": { p: 0.0000005, c: 0.000003, vision: true },
  "mocktext/classifier": { p: 0.0000001, c: 0.0000004, vision: false },
};
const PALETTE = [[0, 0, 0], [230, 0, 0], [0, 150, 0], [0, 0, 230], [240, 140, 0], [150, 0, 150], [0, 160, 170]];
const markerRgb = (n) => ({ r: PALETTE[n][0], g: PALETTE[n][1], b: PALETTE[n][2] });

const stats = { chat: 0, byModel: {}, byTask: {}, byMarker: {}, privacy: [], bodies: 0 };
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
    Object.assign(stats, { chat: 0, byModel: {}, byTask: {}, byMarker: {}, privacy: [], bodies: 0 });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/v1/latest") return json(res, 200, { amount: 1, base: "USD", date: "2026-10-16", rates: { INR: 95 } });
  const p = url.pathname.replace(/^\/api\/v1/, "");
  if (req.method === "GET" && p === "/models") {
    return json(res, 200, {
      data: Object.entries(MODELS).map(([id, m]) => ({ id, name: id, context_length: 200000, architecture: { input_modalities: m.vision ? ["text", "image"] : ["text"], output_modalities: ["text"] }, pricing: { prompt: String(m.p), completion: String(m.c) }, top_provider: { max_completion_tokens: 16000 }, supported_parameters: ["max_tokens", "temperature"] })),
    });
  }
  if (req.method === "GET" && p === "/images/models") return json(res, 200, { data: [] });
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer sk-or-")) return err(res, 401, "No auth credentials found");
  if (req.method === "GET" && p === "/key") return json(res, 200, { data: { label: "mock", limit: 10, limit_remaining: 9, usage: 1 } });
  if (req.method === "POST" && p === "/chat/completions") {
    stats.chat++;
    stats.privacy.push(body.provider?.data_collection ?? null);
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
      const m = MODELS[id];
      if (!m) {
        last = [404, `${id} is not a valid model ID`];
        continue;
      }
      if (image && !m.vision) {
        last = [404, "No endpoints found that support image input"];
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
      stats.byModel[id] = (stats.byModel[id] ?? 0) + 1;
      let out;
      if (task === "extract") {
        const marker = image ? await markerOf(image) : null;
        stats.byMarker[marker ?? "none"] = (stats.byMarker[marker ?? "none"] ?? 0) + 1;
        const fx = marker ? fixtures.pages[marker] : null;
        if (!fx) out = { questions: [], answer_key: [], page_notes: "nothing recognized" };
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
      const cost = Math.round((pt * m.p + ct * m.c) * 1e12) / 1e12;
      return json(res, 200, { id: `gen-vision-${Date.now()}-${++seq}`, model: id, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct, cost } });
    }
    return err(res, last[0], last[1]);
  }
  return err(res, 404, `mock: no route ${req.method} ${p}`);
});
server.listen(port, "127.0.0.1", () => console.log(`mock-openrouter-vision on 127.0.0.1:${port}`));
