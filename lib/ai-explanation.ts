import "server-only";
import { prisma } from "@/lib/prisma";
import type { QuestionSnapshot } from "@/lib/test-attempt";

export class AiNotConfiguredError extends Error {}

function buildPrompt(snapshot: QuestionSnapshot) {
  const optionsText = snapshot.options.map((o) => `${o.label}. ${o.text}`).join("\n");
  return `You are an expert exam tutor helping a student understand a multiple-choice question.

Question:
${snapshot.text}

Options:
${optionsText}

The correct answer is ${snapshot.correctLabel}.

Respond with ONLY a JSON object (no markdown fences) with these keys:
- "whyCorrect": why the correct option is right (under 60 words)
- "whyNot<Label>" for every incorrect option label above (e.g. "whyNotA"), each under 40 words
- "memoryTrick": a short mnemonic or memory aid
- "rephrase": one way this question could be asked differently

Keep the tone encouraging and exam-focused.`;
}

function parseExplanation(text: string): Record<string, string> {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    // fall through to raw-text fallback below
  }
  return { whyCorrect: text.trim() || "No explanation could be generated." };
}

/** Reuses a stored explanation if one exists; otherwise generates once and stores it for every future student. */
export async function getOrCreateExplanation(questionId: string, snapshot: QuestionSnapshot) {
  const existing = await prisma.aIExplanation.findUnique({ where: { questionId } });
  if (existing) return existing;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiNotConfiguredError(
      "AI explanations aren't configured yet. Add ANTHROPIC_API_KEY to enable this feature."
    );
  }

  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      messages: [{ role: "user", content: buildPrompt(snapshot) }],
    }),
  });

  if (!res.ok) {
    throw new Error(`AI explanation request failed (${res.status}). Please try again.`);
  }

  const data = (await res.json()) as { content?: { text?: string }[] };
  const text = data.content?.[0]?.text ?? "";
  const content = parseExplanation(text);

  return prisma.aIExplanation.create({ data: { questionId, content: content as never, model } });
}
