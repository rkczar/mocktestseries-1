import "server-only";
import { AiGenerationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getGeminiApiKey, getGeminiConfig } from "@/lib/gemini-config";

/**
 * Ask AI explanations — see AGENTS.md / commit history: this reuses the
 * SAME Gemini provider configuration the admin already manages under
 * Settings → Authentication (lib/gemini-config.ts: encrypted key storage,
 * DB-first with an env bootstrap, a live connection test). An earlier
 * version of this file called Anthropic directly through an unrelated,
 * unconfigured `ANTHROPIC_API_KEY` env var — a second, dangling AI
 * pathway with no admin UI behind it. Consolidated onto Gemini so there is
 * exactly one AI provider surface in the app.
 */

export class AiNotConfiguredError extends Error {}
export class AiGenerationInProgressError extends Error {}

/** Bump this whenever the prompt shape changes materially. Stored per explanation so old/new output is never silently mixed (Step 6/7.3). */
export const EXPLANATION_PROMPT_VERSION = "explain-v1";

/** A GENERATING/PENDING row older than this is assumed abandoned (crashed request, dead connection) and safe to reclaim. */
export const STALE_GENERATION_MS = 2 * 60_000;

export interface QuestionForExplanation {
  code: string;
  text: string;
  options: { label: string; text: string }[];
  correctLabel: string;
}

async function loadCanonicalQuestion(questionId: string): Promise<QuestionForExplanation> {
  const question = await prisma.question.findUnique({
    where: { id: questionId },
    include: { options: { orderBy: { order: "asc" } } },
  });
  if (!question) throw new Error("Question not found.");
  const correct = question.options.find((o) => o.isCorrect);
  if (!correct) throw new Error("This question has no correct option configured.");
  return {
    code: question.code,
    text: question.text,
    options: question.options.map((o) => ({ label: o.label, text: o.text })),
    correctLabel: correct.label,
  };
}

function buildPrompt(question: QuestionForExplanation) {
  const optionsText = question.options.map((o) => `${o.label}. ${o.text}`).join("\n");
  return `You are an expert exam tutor helping a student understand a multiple-choice question.

Question:
${question.text}

Options:
${optionsText}

The correct answer is ${question.correctLabel}.

Respond with ONLY a JSON object (no markdown fences) with these keys:
- "whyCorrect": why the correct option is right (under 60 words)
- "whyNot<Label>" for every incorrect option above (e.g. "whyNotA"), each under 40 words
- "coreConcept": the underlying concept this question is testing, in one or two sentences
- "memoryTrick": a short mnemonic or memory aid

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

async function callGemini(question: QuestionForExplanation, apiKey: string, model: string): Promise<Record<string, string>> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(question) }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 800 },
      }),
    }
  );

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ? `Gemini rejected the request: ${body.error.message}` : `AI explanation request failed (${res.status}).`);
  }

  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return parseExplanation(text);
}

/**
 * Global, per-Question cache with DB-level concurrency control (Step 6.2/6.3).
 *
 * `AIExplanation.questionId` is `@unique`, so the very first `create` for a
 * question is the only one that can ever succeed — every concurrent caller
 * that loses the race gets a unique-constraint error, catches it, and reads
 * back whatever the winner is doing. A GENERATING row older than
 * STALE_GENERATION_MS (crashed request, dropped connection) is reclaimed via
 * a conditional `updateMany` whose affected-row count is the compare-and-swap:
 * exactly one caller ever sees `count === 1` and becomes the new owner.
 * Nobody can get stuck waiting on a dead generation forever.
 */
export async function getOrCreateExplanation(questionId: string) {
  // A cached explanation must always be servable, even if the provider is
  // currently unconfigured (key rotated out, admin mid-setup) — "not
  // configured" only ever blocks a NEW generation, never a cache read.
  const existing = await prisma.aIExplanation.findUnique({ where: { questionId } });
  if (existing?.status === AiGenerationStatus.COMPLETED) return existing;

  const geminiConfig = await getGeminiConfig();
  if (!geminiConfig.configured) {
    throw new AiNotConfiguredError("AI explanations aren't configured yet. An admin needs to add a Gemini API key under Settings → Authentication.");
  }

  const owned = await claimGeneration(questionId, existing);
  if (!owned) {
    throw new AiGenerationInProgressError("This explanation is being generated — please try again in a few seconds.");
  }

  const question = await loadCanonicalQuestion(questionId);
  const apiKey = await getGeminiApiKey();
  if (!apiKey) throw new AiNotConfiguredError("AI explanations aren't configured yet. An admin needs to add a Gemini API key under Settings → Authentication.");

  try {
    const content = await callGemini(question, apiKey, geminiConfig.model);
    return await prisma.aIExplanation.update({
      where: { questionId },
      data: { status: AiGenerationStatus.COMPLETED, content: content as unknown as Prisma.InputJsonValue, generatedAt: new Date(), errorMessage: null },
    });
  } catch (error) {
    await prisma.aIExplanation.update({
      where: { questionId },
      data: { status: AiGenerationStatus.FAILED, errorMessage: error instanceof Error ? error.message : "Generation failed." },
    });
    throw error;
  }
}

/**
 * Tries to become the sole owner of generating this explanation. Returns
 * true iff this call won the claim. Exported (only) so
 * scripts/verify-ai-review.ts can exercise the exact concurrency/staleness
 * logic directly — including simulated concurrent races — without needing a
 * live Gemini call.
 */
export async function claimGeneration(
  questionId: string,
  existing: { status: AiGenerationStatus; updatedAt: Date } | null
): Promise<boolean> {
  if (!existing) {
    try {
      await prisma.aIExplanation.create({
        data: {
          questionId,
          status: AiGenerationStatus.GENERATING,
          content: {} as unknown as Prisma.InputJsonValue,
          model: (await getGeminiConfig()).model,
          provider: "gemini",
          promptVersion: EXPLANATION_PROMPT_VERSION,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return false; // someone else created it in the race between our findUnique and this create
      }
      throw error;
    }
  }

  const isStale = existing.status !== AiGenerationStatus.COMPLETED && Date.now() - existing.updatedAt.getTime() > STALE_GENERATION_MS;
  if (existing.status !== AiGenerationStatus.FAILED && !isStale) return false;

  const claim = await prisma.aIExplanation.updateMany({
    where: { questionId, status: existing.status, updatedAt: existing.updatedAt },
    data: { status: AiGenerationStatus.GENERATING, retryCount: { increment: 1 }, promptVersion: EXPLANATION_PROMPT_VERSION },
  });
  return claim.count === 1;
}
