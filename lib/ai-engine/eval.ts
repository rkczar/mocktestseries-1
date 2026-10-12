import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateTextViaOpenRouter } from "@/lib/ai-engine/engine";

/**
 * Medical model quality evaluation (Admin → AI → Models → Evaluate).
 *
 * The model under test answers a random sample of PUBLISHED single-correct
 * PYQ questions blind (no answer key in the prompt). The run measures answer
 * agreement with the verified key, confident-but-wrong answers (a hallucination
 * proxy), structured-output (JSON) reliability, latency and the reported cost.
 * It is a paid run, so it starts only from an approved AI Cost Preview.
 *
 * Nothing in the Question Bank is ever changed: a disagreement is only listed
 * here for editorial review. Medical approval stays a manual admin decision.
 */

export const EVAL_SETTING_KEY = "ai.eval";
export const EVAL_MAX_QUESTIONS = 10;

export interface EvalItem {
  questionId: string;
  code: string;
  key: string;
  answer: string | null;
  confidence: number | null;
  correct: boolean;
  jsonOk: boolean;
  latencyMs: number;
  /** The model's short reason, kept only for an admin spot-check of explanation quality. */
  reason: string | null;
  error: string | null;
}

export interface EvalResult {
  model: string;
  at: string;
  n: number;
  correct: number;
  jsonOk: number;
  confidentWrong: number;
  failed: number;
  avgLatencyMs: number;
  costInr: number | null;
  items: EvalItem[];
}

function buildSolvePrompt(q: { text: string; options: { label: string; text: string }[] }): string {
  return [
    "You are an expert Indian medical examiner. Answer this single-best-answer MCQ.",
    "Reply with ONLY a JSON object, no other text:",
    '{"answer": "<option label>", "confidence": <0.0-1.0>, "reason": "<at most 60 words: the key medical fact>"}',
    "",
    q.text,
    ...q.options.map((o) => `${o.label}. ${o.text}`),
  ].join("\n");
}

export function parseSolve(text: string, labels: string[]): { answer: string | null; confidence: number | null; reason: string | null; jsonOk: boolean } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { answer: null, confidence: null, reason: null, jsonOk: false };
  try {
    const o = JSON.parse(m[0]) as { answer?: unknown; confidence?: unknown; reason?: unknown };
    const answer = typeof o.answer === "string" ? o.answer.trim().replace(/[^A-Za-z0-9]/g, "").toUpperCase() : null;
    const valid = answer !== null && labels.map((l) => l.toUpperCase()).includes(answer);
    const confidence = typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : null;
    return { answer: valid ? answer : null, confidence, reason: typeof o.reason === "string" ? o.reason.slice(0, 400) : null, jsonOk: valid };
  } catch {
    return { answer: null, confidence: null, reason: null, jsonOk: false };
  }
}

/** Random PYQ sample with exactly one correct option, plain text, no images (read-only). */
export async function sampleQuestions(n: number) {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT q."id" FROM "Question" q
    WHERE q."status" = 'PUBLISHED' AND q."parentQuestionId" IS NULL AND q."questionType" = 'SINGLE_CORRECT'
      AND q."contentFormat" = 'PLAIN' AND q."imageUrl" IS NULL AND q."previousYearPaperId" IS NOT NULL AND NOT q."reviewRequired"
      AND (SELECT COUNT(*) FROM "QuestionOption" o WHERE o."questionId" = q."id" AND o."isCorrect") = 1
      AND NOT EXISTS (SELECT 1 FROM "QuestionOption" o WHERE o."questionId" = q."id" AND o."imageUrl" IS NOT NULL)
    ORDER BY random() LIMIT ${Math.min(EVAL_MAX_QUESTIONS, Math.max(1, n))}`;
  return prisma.question.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    select: { id: true, code: true, text: true, options: { orderBy: { order: "asc" }, select: { label: true, text: true, isCorrect: true } } },
  });
}

export async function runModelEvaluation(input: { model: string; n: number; actorId: string; quoteId: string }): Promise<EvalResult> {
  const questions = await sampleQuestions(input.n);
  const items: EvalItem[] = [];
  const started = new Date();
  for (const q of questions) {
    const key = q.options.find((o) => o.isCorrect)!.label.toUpperCase();
    const t0 = Date.now();
    try {
      const r = await generateTextViaOpenRouter("explanation_admin", buildSolvePrompt(q), { temperature: 0, maxOutputTokens: 300 }, { actorId: input.actorId, quoteId: input.quoteId, modelOverride: input.model, evaluation: true });
      const p = parseSolve(r.text, q.options.map((o) => o.label));
      items.push({ questionId: q.id, code: q.code, key, answer: p.answer, confidence: p.confidence, correct: p.answer === key, jsonOk: p.jsonOk, latencyMs: Date.now() - t0, reason: p.reason, error: null });
    } catch (error) {
      items.push({ questionId: q.id, code: q.code, key, answer: null, confidence: null, correct: false, jsonOk: false, latencyMs: Date.now() - t0, reason: null, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
      // A budget / configuration refusal will repeat for every question — stop early.
      if (error instanceof Error && /budget|stopped|not configured|limit/i.test(error.message)) break;
    }
  }
  const cost = await prisma.aiGatewayCall.aggregate({ where: { quoteId: input.quoteId, createdAt: { gte: started } }, _sum: { actualCostInr: true }, _count: { actualCostInr: true } });
  const answered = items.filter((i) => !i.error);
  const result: EvalResult = {
    model: input.model,
    at: started.toISOString(),
    n: items.length,
    correct: items.filter((i) => i.correct).length,
    jsonOk: items.filter((i) => i.jsonOk).length,
    confidentWrong: items.filter((i) => !i.correct && i.answer !== null && (i.confidence ?? 0) >= 0.8).length,
    failed: items.filter((i) => i.error).length,
    avgLatencyMs: answered.length ? Math.round(answered.reduce((s, i) => s + i.latencyMs, 0) / answered.length) : 0,
    costInr: cost._count.actualCostInr ? (cost._sum.actualCostInr ?? 0) : null,
    items,
  };
  const row = await prisma.setting.findUnique({ where: { key: EVAL_SETTING_KEY } });
  const prev = ((row?.value as { runs?: EvalResult[] } | undefined)?.runs ?? []).filter((r) => r.model !== input.model || Date.parse(r.at) > Date.now() - 90 * 86_400_000);
  const runs = [result, ...prev].slice(0, 30);
  await prisma.setting.upsert({ where: { key: EVAL_SETTING_KEY }, update: { value: { runs } as unknown as Prisma.InputJsonValue }, create: { key: EVAL_SETTING_KEY, value: { runs } as unknown as Prisma.InputJsonValue } });
  return result;
}

export async function listEvaluations(): Promise<EvalResult[]> {
  const row = await prisma.setting.findUnique({ where: { key: EVAL_SETTING_KEY } });
  return (row?.value as { runs?: EvalResult[] } | undefined)?.runs ?? [];
}
