import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { prisma } from "@/lib/db";

const MODEL = "claude-sonnet-5";

export class AIExplanationUnavailableError extends Error {}

type ExplainableQuestion = {
  id: string;
  stem: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: string;
  explanation: string | null;
  aiExplanation: string | null;
};

function buildPrompt(question: ExplainableQuestion) {
  return [
    "You are a patient exam tutor. A student got this multiple-choice question wrong and wants",
    "a clearer walkthrough than the short official explanation gives them.",
    "",
    `Question: ${question.stem}`,
    `A. ${question.optionA}`,
    `B. ${question.optionB}`,
    `C. ${question.optionC}`,
    `D. ${question.optionD}`,
    `Correct answer: ${question.correctAnswer}`,
    question.explanation ? `Official explanation: ${question.explanation}` : "",
    "",
    "Write a concise step-by-step explanation of why the correct option is right and, briefly,",
    "why each of the other options is wrong. Plain text, no markdown headings, under 200 words.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Single-flight guard: two requests for the same question arriving close together (a double
// click, or two students hitting the same unexplained question at once) join the one in-flight
// generation instead of each paying for and racing a separate model call. Only dedupes within
// this process — a fleet of multiple app instances would still allow one call per instance,
// which the DB write guard below then reconciles safely.
const inFlight = new Map<string, Promise<string>>();

/**
 * Returns a cached explanation if one already exists on the question, otherwise generates one
 * and caches it — the explanation is the same for every student, so it's paid for once per
 * question rather than once per request.
 */
export async function getOrCreateAIExplanation(questionId: string): Promise<string> {
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    select: {
      id: true,
      stem: true,
      optionA: true,
      optionB: true,
      optionC: true,
      optionD: true,
      correctAnswer: true,
      explanation: true,
      aiExplanation: true,
    },
  });
  if (!question) throw new AIExplanationUnavailableError("Question not found.");
  if (question.aiExplanation) return question.aiExplanation;

  const pending = inFlight.get(questionId);
  if (pending) return pending;

  const generation = generateAndCache(question).finally(() => inFlight.delete(questionId));
  inFlight.set(questionId, generation);
  return generation;
}

async function generateAndCache(question: ExplainableQuestion): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AIExplanationUnavailableError(
      "AI explanations aren't configured yet — set ANTHROPIC_API_KEY.",
    );
  }

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: buildPrompt(question) }],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) throw new AIExplanationUnavailableError("The model returned an empty explanation.");

  // Guarded by `aiExplanation: null` — if another process (or a request that started just
  // before this one finished) already cached an explanation first, keep that one instead of
  // overwriting it, and hand back the winner rather than this call's own (possibly different) text.
  const { count } = await prisma.question.updateMany({
    where: { id: question.id, aiExplanation: null },
    data: { aiExplanation: text, aiExplanationModel: MODEL, aiExplanationGeneratedAt: new Date() },
  });
  if (count === 0) {
    const winner = await prisma.question.findUnique({
      where: { id: question.id },
      select: { aiExplanation: true },
    });
    return winner?.aiExplanation ?? text;
  }

  return text;
}
