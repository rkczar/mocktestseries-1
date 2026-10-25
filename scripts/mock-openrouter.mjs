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
 * Text answers reuse scripts/mock-anthropic.mjs#answerFor (the app's real prompts); AI Video Studio
 * script prompts get a valid scene plan (videoScript below).
 * POST /audio/speech → a WAV tone (length follows the text); POST /audio/transcriptions → verbose_json
 * with word timestamps and usage.cost.
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
  if (prompt.startsWith("You write short educational videos for MockTestSeries.in")) return videoScript(prompt);
  if (prompt.startsWith("You plan short motion-graphics teaching videos for MockTestSeries.in")) return motionScript(prompt);
  return null;
}

/** A scene plan for the AI Video Studio script prompt: uses the listed questionIds / assets, flags one claim for review. */
function videoScript(prompt) {
  const regen = /Rewrite ONLY scene (\d+)/.exec(prompt);
  const qids = [...prompt.matchAll(/- questionId ([a-z0-9]{20,40}) \(/g)].map((m) => m[1]);
  const assetBlock = /Assets you may show on screen[^\n]*\n((?:\d+: [^\n]*\n?)+)/.exec(prompt);
  const assets = assetBlock ? assetBlock[1].trim().split("\n").length : 0;
  const n = Math.max(3, Math.min(8, Number(/ in (\d+) scenes/.exec(prompt)?.[1] ?? 5)));
  const scene = (narration, onScreenText, visual, needsReview = false, reviewNote = "") => ({ narration, onScreenText, visual, needsReview, reviewNote });
  const middle = [
    scene("Troponin I सबसे specific cardiac marker है। यह myocardial injury के तीन से छह घंटे बाद बढ़ता है।", "Troponin I: most specific", { kind: "bullets", title: "Cardiac markers", items: ["Troponin I — most specific", "CK-MB — reinfarction", "Myoglobin — earliest"] }),
    scene("Mechanism समझिए: plaque rupture, फिर thrombus, फिर ischemia और अंत में necrosis।", "Plaque → Thrombus → Necrosis", { kind: "diagram", title: "MI pathway", nodes: ["Plaque rupture", "Thrombus", "Ischemia", "Necrosis"] }),
    scene("CK-MB दो से तीन दिन में normal हो जाता है, इसलिए reinfarction पकड़ने में useful है।", "CK-MB: reinfarction", { kind: "title", title: "CK-MB", subtitle: "Normal in 2–3 days" }, true, "Check the CK-MB normalisation window against the current textbook."),
  ];
  const scenes = [scene("क्या आप जानते हैं कि heart attack के बाद सबसे पहले कौन सा marker बढ़ता है?", "Which marker rises first?", { kind: "title", title: "Cardiac markers", subtitle: "NEET PG high-yield" })];
  for (const id of qids) scenes.push(scene("अब यह question देखिए और answer सोचिए।", "Your turn", { kind: "question", questionId: id, revealAtSec: 4 }));
  for (let i = 0; i < Math.min(assets, 2); i++) scenes.push(scene("इस image में key finding को ध्यान से देखिए।", "Look closely", { kind: "image", assetIndex: i, title: "Key finding", caption: "From your upload" }));
  for (const m of middle) if (scenes.length < n - 1) scenes.push(m);
  scenes.push(scene("ऐसे और high-yield revision videos के लिए MockTestSeries.in पर practice कीजिए।", "Practice on MockTestSeries.in", { kind: "cta", title: "Practice now", subtitle: "MockTestSeries.in" }));
  if (regen) return JSON.stringify({ scenes: [scene("यह scene दोबारा लिखा गया है: Troponin I और T दोनों specific हैं।", "Troponin I and T", { kind: "title", title: "Troponins", subtitle: "Rewritten scene" })] });
  return JSON.stringify({ title: "Cardiac markers in 60 seconds", caption: "Troponin, CK-MB and myoglobin — the high-yield timeline. #NEETPG", scenes });
}

/** A script + storyboard for the Motion Workflow Studio prompt (uses the listed questionId; one flagged frame; motions from the style list). */
function motionScript(prompt) {
  const motions = (/exactly one of ([a-z_, ]+), \(4\)/.exec(prompt)?.[1] ?? "pop").split(",").map((s) => s.trim()).filter(Boolean);
  const qid = /- questionId ([a-z0-9]{20,40}) \(/.exec(prompt)?.[1];
  const m = (i) => motions[i % motions.length];
  const frames = [
    { sentence: "Heart attack के बाद सबसे पहले कौन सा marker बढ़ता है?", onScreen: "Which marker rises first?", highlight: "first", motion: m(0), tag: "Level 1", visual: { type: "statement" } },
    { sentence: "Myoglobin सबसे पहले बढ़ता है, लेकिन यह specific नहीं है।", onScreen: "Myoglobin: earliest", highlight: "Myoglobin", motion: m(1), tag: "Level 2", visual: { type: "compare", left: "Myoglobin", right: "Troponin I" } },
    { sentence: "Plaque rupture, फिर thrombus, और फिर myocardial necrosis होता है।", onScreen: "MI pathway", highlight: "pathway", motion: m(2), tag: "Level 3", visual: { type: "diagram", nodes: ["Plaque rupture", "Thrombus", "Necrosis"] } },
    { sentence: "Troponin I 6 घंटे में बढ़ता है और दस दिन तक high रहता है।", onScreen: "Troponin I rises by 6 hours", highlight: "Troponin", motion: m(3), tag: "Level 4", visual: { type: "stat", value: "6", unit: "hours" }, needsReview: true, reviewNote: "Check the 10-day persistence against the current textbook." },
  ];
  if (qid) frames.push({ sentence: "अब boss question का answer सोचिए।", onScreen: "Boss question", highlight: "Boss", motion: m(4), tag: "Boss", visual: { type: "question", questionId: qid, revealAtSec: 3 } });
  frames.push({ sentence: "ऐसे और high-yield videos के लिए MockTestSeries.in पर practice कीजिए।", onScreen: "Practice on MockTestSeries.in", highlight: "Practice", motion: m(5), tag: "Done", visual: { type: "cta" } });
  return JSON.stringify({ title: "Cardiac markers, frame by frame", caption: "Myoglobin first, Troponin I most specific. #NEETPG", frames });
}

/**
 * 16 kHz mono 16-bit PCM WAV with a soft tone (stands in for narration audio).
 * The spoken text rides along in a private "mtsx" chunk (decoders skip unknown
 * chunks), so the transcription mock can return the words that were "spoken"
 * with times spread over the real audio length.
 */
function wavTone(sec, text = "") {
  const rate = 16000;
  const n = Math.round(sec * rate);
  const tb = Buffer.from(text, "utf8");
  const tl = tb.length + (tb.length % 2);
  const extra = tb.length ? 8 + tl : 0;
  const b = Buffer.alloc(44 + extra + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + extra + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  let o = 36;
  if (tb.length) {
    b.write("mtsx", o);
    b.writeUInt32LE(tb.length, o + 4);
    tb.copy(b, o + 8);
    o += 8 + tl;
  }
  b.write("data", o);
  b.writeUInt32LE(n * 2, o + 4);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 2500 * Math.min(1, i / 800, (n - i) / 800)), o + 8 + i * 2);
  return b;
}

/** Words "heard" in a mock WAV: its mtsx text spread over its data length; null when the audio carries no text. */
function heardWords(buf) {
  if (buf.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  let o = 12;
  let text = null;
  let dataBytes = 0;
  while (o + 8 <= buf.length) {
    const id = buf.subarray(o, o + 4).toString("latin1");
    const len = buf.readUInt32LE(o + 4);
    if (id === "mtsx") text = buf.subarray(o + 8, o + 8 + len).toString("utf8");
    if (id === "data") dataBytes = len;
    o += 8 + len + (len % 2);
  }
  if (!text) return null;
  const sec = dataBytes / 32000;
  const ws = text.split(/\s+/).filter(Boolean);
  const per = (sec - 0.4) / Math.max(1, ws.length);
  return { sec, words: ws.map((w, i) => ({ word: w, start: Math.round((0.2 + i * per) * 1000) / 1000, end: Math.round((0.2 + (i + 0.85) * per) * 1000) / 1000 })) };
}

const SPOKEN = "नमस्ते students आज हम cardiac markers पढ़ेंगे Troponin I सबसे specific marker है CK-MB reinfarction में useful है".split(" ");

export function startMockOpenRouter(port) {
  const stats = { chat: 0, images: 0, speech: 0, transcriptions: 0, key: 0, models: 0, generation: 0, fx: 0, bodies: [], authHeaders: 0 };
  const fx = { rate: 95.5, status: 200 };
  const generations = new Map();
  let seq = 0;
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
      Object.assign(stats, { chat: 0, images: 0, speech: 0, transcriptions: 0, key: 0, models: 0, generation: 0, fx: 0, bodies: [], authHeaders: 0 });
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
        supported_parameters: ["max_tokens", "temperature", "response_format"],
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
      stats.bodies.push({ model: body.model, models: body.models, provider: body.provider, plugins: body.plugins, max_tokens: body.max_tokens });
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
    if (req.method === "POST" && p === "/audio/speech") {
      stats.speech++;
      stats.bodies.push({ speech: true, model: body.model, voice: body.voice, chars: [...String(body.input ?? "")].length, provider: body.provider });
      if (scenario === "nocredit") return err(res, 402, "Insufficient credits");
      if (!body.model || !body.voice || !body.input) return err(res, 400, "model, voice and input are required");
      const wav = wavTone(Math.min(120, Math.max(1.5, [...String(body.input)].length / 14)), String(body.input));
      res.writeHead(200, { "content-type": "audio/wav", "x-generation-id": `tts-mock-${Date.now()}-${++seq}` });
      return res.end(wav);
    }
    if (req.method === "POST" && p === "/audio/transcriptions") {
      stats.transcriptions++;
      stats.bodies.push({ transcription: true, model: body.model, language: body.language, bytes: String(body.input_audio?.data ?? "").length, provider: body.provider });
      if (scenario === "nocredit") return err(res, 402, "Insufficient credits");
      if (!body.input_audio?.data) return err(res, 400, "input_audio is required");
      const heard = heardWords(Buffer.from(String(body.input_audio.data), "base64"));
      const words = heard ? heard.words : SPOKEN.map((w, i) => ({ word: w + (i === 7 || i === SPOKEN.length - 1 ? "।" : ""), start: 0.3 + i * 0.42, end: 0.3 + i * 0.42 + 0.36 }));
      const seconds = heard ? Math.round(heard.sec) : 8;
      return json(res, 200, { id: `stt-mock-${Date.now()}-${++seq}`, text: words.map((w) => w.word).join(" "), language: body.language ?? "hi", words, segments: [], usage: { cost: Math.max(0.00042, Math.round(seconds * 0.0001 * 1e6) / 1e6), seconds } });
    }
    return err(res, 404, `mock: no route ${req.method} ${p}`);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, stats, fx })));
}

if (process.argv[1] && process.argv[1].endsWith("mock-openrouter.mjs")) {
  const port = Number(process.argv[2] ?? 3193);
  startMockOpenRouter(port).then(() => console.log(`mock OpenRouter on 127.0.0.1:${port}`));
}
