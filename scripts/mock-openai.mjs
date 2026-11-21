/**
 * Mock of OpenAI Chat Completions for the importer's direct-OpenAI route (OPENAI_TEST_BASE_URL). Loopback only, never
 * talks to OpenAI. Answers the importer's independent-answer prompt from a marker in the question ("MOCKANS=C").
 * Reports usage with cached tokens (half the prompt from the 2nd request on, like automatic prompt caching).
 *   node scripts/mock-openai.mjs <port>      GET /__mock/stats · POST /__mock/reset
 */
import http from "node:http";

const port = Number(process.argv[2] || 3572);
let stats = { chat: 0, auth: 0, bodies: [] };
http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/__mock/stats") return send(200, stats);
      if (req.url === "/__mock/reset") return (stats = { chat: 0, auth: 0, bodies: [] }), send(200, {});
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(404, { error: { message: "not found" } });
      const body = JSON.parse(raw || "{}");
      stats.chat++;
      if (/^Bearer sk-mock-openai-/.test(req.headers.authorization ?? "")) stats.auth++;
      else return send(401, { error: { message: "Incorrect API key provided" } });
      stats.bodies.push({ model: body.model, max_completion_tokens: body.max_completion_tokens, max_tokens: body.max_tokens, reasoning_effort: body.reasoning_effort, response_format: body.response_format?.type ?? null, temperature: body.temperature });
      const text = (body.messages ?? []).map((m) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("\n") : String(m.content ?? ""))).join("\n");
      if (body.model === "gpt-mock-ratelimit") return send(429, { error: { message: "Rate limit reached" } });
      const m = /MOCKANS=([A-D]|DEFECTIVE)/.exec(text)?.[1];
      const answer = m === "DEFECTIVE" ? { answer: [], confidence: 0.7, defective: true, reason: "no option fits" } : { answer: [m ?? "B"], confidence: 0.9, defective: false, reason: "openai mock" };
      const prompt = Math.ceil(text.length / 4);
      send(200, { id: `chatcmpl-mock-${stats.chat}`, model: `${body.model}-2026-01-01`, choices: [{ message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }], usage: { prompt_tokens: prompt, completion_tokens: 20, prompt_tokens_details: { cached_tokens: stats.chat > 1 ? Math.floor(prompt / 2) : 0 } } });
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`mock openai on ${port}`));
