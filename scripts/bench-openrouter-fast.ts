/* eslint-disable @typescript-eslint/no-explicit-any -- benchmark tool parsing untyped provider JSON */
/**
 * Latency / reliability benchmark of OpenRouter models for student explanation + variant (synthetic prompts only).
 * Raw OpenRouter calls (no DB writes). The key comes from OR_KEY_CIPHER (the stored ciphertext) + AUTH_SECRET and is
 * never printed. Hard stop when the summed reported cost reaches BENCH_MAX_USD.
 *   OR_KEY_CIPHER=… AUTH_SECRET=… npx tsx scripts/bench-openrouter-fast.ts > out.json
 */
import { decryptSecret } from "@/lib/secret-cipher";

const KEY = decryptSecret(process.env.OR_KEY_CIPHER)?.trim();
if (!KEY) throw new Error("no key");
const MAX_USD = Number(process.env.BENCH_MAX_USD ?? 2);
const RUNS = Number(process.env.BENCH_RUNS ?? 6);
const TIMEOUT_MS = 45_000;
const MODELS = (process.env.BENCH_MODELS ?? "").split(",").filter(Boolean);

const Q = `Question: A 45-year-old man on long-term lithium therapy develops polyuria and polydipsia. Urine osmolality stays low after water deprivation and does not rise after desmopressin. Which is the most likely diagnosis?
(A) Central diabetes insipidus (B) Nephrogenic diabetes insipidus (C) Primary polydipsia (D) SIADH
Correct answer: B`;
const TASKS = {
  explanation: {
    maxTokens: 1200,
    prompt: `You are a medical exam tutor for Indian medical entrance students. ${Q}
Reply with ONE JSON object only: {"correctOption":"B","explanation":"<150-250 words, why B is correct>","keyPoints":["<3-5 short points>"],"whyOthersWrong":{"A":"…","C":"…","D":"…"}}`,
    check: (j: any) => j?.correctOption === "B" && typeof j.explanation === "string" && j.explanation.length > 300 && Array.isArray(j.keyPoints) && j.keyPoints.length >= 3 && j.whyOthersWrong && ["A", "C", "D"].every((k) => typeof j.whyOthersWrong[k] === "string"),
  },
  variant: {
    maxTokens: 3000,
    prompt: `You write NEW practice MCQs for Indian medical exams that test the same concept as this question but are not copies. ${Q}
Reply with ONE JSON object only: {"variants":[{"stem":"…","options":{"A":"…","B":"…","C":"…","D":"…"},"correctOption":"A|B|C|D","explanation":"<80-150 words>"}]} with exactly 3 variants.`,
    check: (j: any) => Array.isArray(j?.variants) && j.variants.length === 3 && j.variants.every((v: any) => v.stem?.length > 30 && ["A", "B", "C", "D"].every((k) => typeof v.options?.[k] === "string") && /^[ABCD]$/.test(v.correctOption) && v.explanation?.length > 150),
  },
} as const;

let spent = 0;
async function call(model: string, task: keyof typeof TASKS) {
  const t = TASKS[task];
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Title": "MTS latency benchmark" },
      body: JSON.stringify({
        model, messages: [{ role: "user", content: t.prompt }], max_tokens: t.maxTokens, temperature: 0.3,
        response_format: { type: "json_object" }, usage: { include: true },
        reasoning: { effort: "low", exclude: true },
        provider: { sort: "latency", data_collection: "deny", require_parameters: false },
      }),
    });
    const body: any = await res.json().catch(() => null);
    const ms = Date.now() - t0; // full answer received (headers can arrive early on OpenRouter)
    const cost = Number(body?.usage?.cost ?? 0) || 0;
    spent += cost;
    if (!res.ok) return { model, task, ms, ok: false, err: `http_${res.status}`, cost };
    const choice = body?.choices?.[0];
    const text: string = choice?.message?.content ?? "";
    if (!text.trim()) return { model, task, ms, ok: false, err: choice?.finish_reason === "length" ? "truncated" : "empty", cost };
    let j: any = null;
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return { model, task, ms, ok: false, err: choice?.finish_reason === "length" ? "truncated" : "invalid_json", cost }; }
    const good = t.check(j);
    return { model: body.model ?? model, asked: model, task, ms, ok: good, err: good ? null : "quality_check", cost, outTok: body?.usage?.completion_tokens ?? null, provider: body?.provider ?? null };
  } catch (e) {
    return { model, task, ms: Date.now() - t0, ok: false, err: (e as Error).name === "TimeoutError" ? "timeout" : "network", cost: 0 };
  }
}

async function main() {
  const jobs: [string, keyof typeof TASKS][] = [];
  for (let r = 0; r < RUNS; r++) for (const m of MODELS) for (const task of ["explanation", "variant"] as const) jobs.push([m, task]);
  const out: unknown[] = [];
  let i = 0;
  const worker = async () => {
    while (i < jobs.length && spent < MAX_USD) {
      const [m, task] = jobs[i++];
      out.push(await call(m, task));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  console.log(JSON.stringify({ spentUsd: spent, stopped: spent >= MAX_USD, results: out }));
}
main();
