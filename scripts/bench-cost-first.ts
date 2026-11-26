/* eslint-disable @typescript-eslint/no-explicit-any -- benchmark tool parsing untyped provider JSON */
/**
 * Cost-first benchmark (student explanation + variant). Synthetic MCQs, raw OpenRouter calls, no DB writes.
 * Key from OR_KEY_CIPHER + AUTH_SECRET (never printed). Hard stop at BENCH_MAX_USD summed reported cost.
 * Variants are graded by one judge model (JUDGE) through OpenRouter.
 */
import { decryptSecret } from "@/lib/secret-cipher";

const KEY = decryptSecret(process.env.OR_KEY_CIPHER)?.trim();
if (!KEY) throw new Error("no key");
const MAX_USD = Number(process.env.BENCH_MAX_USD ?? 1.5);
const MODELS = (process.env.BENCH_MODELS ?? "").split(",").filter(Boolean);
const EXPL_ONLY = new Set((process.env.BENCH_EXPL_ONLY ?? "").split(",").filter(Boolean));
const JUDGE = "google/gemini-3.1-flash-lite";

// Synthetic, textbook-settled facts (one per subject).
const QS = [
  ["Pharmacology", "Drug of choice for absence seizures in a 7-year-old with no other seizure type?", { A: "Phenytoin", B: "Carbamazepine", C: "Ethosuximide", D: "Phenobarbitone" }, "C"],
  ["Physiology", "Which hormone is secreted by the juxtaglomerular cells of the kidney?", { A: "Renin", B: "Aldosterone", C: "Erythropoietin only from JG cells", D: "ADH" }, "A"],
  ["Pathology", "Reed–Sternberg cells are characteristic of which condition?", { A: "Burkitt lymphoma", B: "Hodgkin lymphoma", C: "Multiple myeloma", D: "CML" }, "B"],
  ["Microbiology", "Rice-water stools are classically caused by:", { A: "Shigella dysenteriae", B: "Vibrio cholerae", C: "Entamoeba histolytica", D: "Salmonella typhi" }, "B"],
  ["Obstetrics", "Drug of choice for prevention and treatment of eclamptic seizures:", { A: "Diazepam", B: "Phenytoin", C: "Magnesium sulphate", D: "Labetalol" }, "C"],
  ["PSM", "Herd immunity is NOT seen with which of these?", { A: "Measles", B: "Polio", C: "Tetanus", D: "Diphtheria" }, "C"],
  ["Medicine", "Most common cause of community-acquired pneumonia in adults:", { A: "Streptococcus pneumoniae", B: "Klebsiella pneumoniae", C: "Staphylococcus aureus", D: "Pseudomonas aeruginosa" }, "A"],
  ["Surgery", "Most common site of carcinoid tumour in the gastrointestinal tract (classical teaching):", { A: "Stomach", B: "Appendix", C: "Rectum", D: "Oesophagus" }, "B"],
] as const;

const qText = (q: (typeof QS)[number]) => `${q[1]} A) ${q[2].A} B) ${q[2].B} C) ${q[2].C} D) ${q[2].D}. Correct: ${q[3]}`;
const TASKS = {
  explanation: {
    maxTokens: 500,
    prompt: (q: (typeof QS)[number]) => `Medical exam tutor. ${qText(q)}\nReturn JSON only: {"correctOption":"${q[3]}","explanation":"<80-150 words>","keyPoints":["3 short points"]}`,
    check: (j: any, q: (typeof QS)[number]) => j?.correctOption === q[3] && typeof j.explanation === "string" && j.explanation.length > 200 && Array.isArray(j.keyPoints) && j.keyPoints.length >= 2,
  },
  variant: {
    maxTokens: 1400,
    prompt: (q: (typeof QS)[number]) => `Write 3 NEW exam MCQs on the same concept (${q[0]}), not copies. Source: ${qText(q)}\nReturn JSON only: {"variants":[{"stem":"","options":{"A":"","B":"","C":"","D":""},"correctOption":"A","explanation":"<40-80 words>"}]}`,
    check: (j: any) => Array.isArray(j?.variants) && j.variants.length === 3 && j.variants.every((v: any) => v.stem?.length > 20 && ["A", "B", "C", "D"].every((k) => typeof v.options?.[k] === "string" && v.options[k]) && /^[ABCD]$/.test(v.correctOption) && v.explanation?.length > 60),
  },
} as const;

let spent = 0;
async function or(model: string, prompt: string, maxTokens: number, timeoutMs = 45_000) {
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "X-Title": "MTS cost benchmark" },
      body: JSON.stringify({
        model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0.2,
        response_format: { type: "json_object" }, usage: { include: true }, reasoning: { effort: "low", exclude: true },
        provider: { sort: "latency", data_collection: "deny" },
      }),
    });
    const body: any = await res.json().catch(() => null);
    const ms = Date.now() - t0;
    const cost = Number(body?.usage?.cost ?? 0) || 0;
    spent += cost;
    if (!res.ok) return { ms, cost, err: `http_${res.status}` as string, j: null as any };
    const ch = body?.choices?.[0];
    const text: string = ch?.message?.content ?? "";
    if (!text.trim()) return { ms, cost, err: ch?.finish_reason === "length" ? "truncated" : "empty", j: null };
    try {
      return { ms, cost, err: null, j: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")), outTok: body?.usage?.completion_tokens };
    } catch {
      return { ms, cost, err: ch?.finish_reason === "length" ? "truncated" : "invalid_json", j: null };
    }
  } catch (e) {
    return { ms: Date.now() - t0, cost: 0, err: (e as Error).name === "TimeoutError" ? "timeout" : "network", j: null };
  }
}

async function judge(v: any): Promise<{ correct: number; sound: number; n: number; cost: number }> {
  const r = await or(JUDGE, `You are a strict medical examiner. For each MCQ below answer whether the marked correctOption is medically correct and whether it is a sound single-best-answer MCQ. Return JSON only: {"grades":[{"correct":true,"sound":true}]} in order.\n${JSON.stringify(v.variants)}`, 700, 30_000);
  if (!Array.isArray(r.j?.grades)) return { correct: -1, sound: -1, n: v.variants.length, cost: r.cost }; // judge failed: not counted
  const g = Array.isArray(r.j?.grades) ? r.j.grades : [];
  return { correct: g.filter((x: any) => x?.correct === true).length, sound: g.filter((x: any) => x?.sound === true).length, n: v.variants.length, cost: r.cost };
}

async function main() {
  const jobs: [string, keyof typeof TASKS, number][] = [];
  for (let qi = 0; qi < QS.length; qi++) for (const m of MODELS) for (const t of (process.env.BENCH_TASKS ?? "explanation,variant").split(",") as (keyof typeof TASKS)[]) if (t === "explanation" || !EXPL_ONLY.has(m)) jobs.push([m, t, qi]);
  const out: any[] = [];
  let i = 0;
  const worker = async () => {
    while (i < jobs.length && spent < MAX_USD) {
      const [m, task, qi] = jobs[i++];
      const q = QS[qi];
      const T = TASKS[task];
      const r = await or(m, T.prompt(q), T.maxTokens);
      const valid = r.err === null;
      const ok = valid && T.check(r.j, q);
      const row: any = { model: m, task, q: qi, ms: r.ms, cost: r.cost, err: r.err ?? (ok ? null : "shape_check"), jsonValid: valid, ok, outTok: (r as any).outTok ?? null };
      if (ok && task === "variant") {
        const g = await judge(r.j);
        row.judge = g;
        row.variants = r.j.variants;
        row.qualityOk = g.correct < 0 ? null : g.correct === g.n && g.sound === g.n;
      } else if (task === "explanation") row.qualityOk = ok; // correctOption must equal the given key
      out.push(row);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(JSON.stringify({ spentUsd: spent, stopped: spent >= MAX_USD, judge: JUDGE, results: out }));
}
main();
