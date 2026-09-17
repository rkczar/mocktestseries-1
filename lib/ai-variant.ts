import "server-only";
import { AiGenerationStatus, AiSlot, AiVariantType, Prisma, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getGeminiApiKey, getGeminiConfig } from "@/lib/gemini-config";
import { AiNotConfiguredError } from "@/lib/ai-explanation";

/**
 * AI-generated alternate practice questions (AI01–AI05) — see Step 7.1–7.3.
 * Reuses the same Gemini provider as lib/ai-explanation.ts (one AI surface
 * in the app). A variant's DB primary key is authoritative, as required;
 * `code` (`<parent code> AI0<n>`) is a human-readable label derived from it,
 * matching the existing Question-code convention (lib/question-code.ts)
 * without needing a new atomic counter — the slot itself is the sequence.
 */

export class MaxVariantsReachedError extends Error {}
export class InvalidVariantSourceError extends Error {}

export const VARIANT_PROMPT_VERSION = "variant-v1";
const ALL_SLOTS: AiSlot[] = [AiSlot.AI01, AiSlot.AI02, AiSlot.AI03, AiSlot.AI04, AiSlot.AI05];

type ParentQuestion = Prisma.QuestionGetPayload<{ include: { options: true } }>;

interface GeneratedVariant {
  text: string;
  options: { label: string; text: string; isCorrect: boolean }[];
}

function buildPrompt(parent: ParentQuestion, variantType: AiVariantType): string {
  const optionsText = parent.options.map((o) => `${o.label}. ${o.text}`).join("\n");
  const instruction =
    variantType === AiVariantType.AI_SIMILAR
      ? "Write a NEW question testing the exact same underlying concept/fact, rephrased or with changed numbers/context so it is not a copy, but still fair and unambiguous."
      : "Write a NEW question testing the exact same underlying concept, but designed as a plausible 'trap' — it should look similar to the source question and tempt the same common mistake, while still having exactly one clearly, objectively correct answer.";

  return `You are an exam-question author. Given this source multiple-choice question:

Question:
${parent.text}

Options:
${optionsText}

${instruction}

Respond with ONLY a JSON object (no markdown fences) shaped exactly like:
{"text": "...", "options": [{"label":"A","text":"...","isCorrect":false}, {"label":"B","text":"...","isCorrect":true}, {"label":"C","text":"...","isCorrect":false}, {"label":"D","text":"...","isCorrect":false}]}

Requirements: exactly 4 options labeled A, B, C, D; exactly ONE option with "isCorrect": true; every option's text must be non-empty and distinct; the new question must not be textually identical to the source question.`;
}

function normalizeForDuplicateCheck(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Exported (only) so scripts/verify-ai-variants.ts can exercise the exact validation logic with known-good/bad payloads, without a live Gemini call. */
export function validateGenerated(raw: string): GeneratedVariant | null {
  let parsed: unknown;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as { text?: unknown; options?: unknown };
  if (typeof obj.text !== "string" || obj.text.trim().length === 0) return null;
  if (!Array.isArray(obj.options) || obj.options.length !== 4) return null;

  const labels = new Set<string>();
  const texts = new Set<string>();
  let correctCount = 0;
  const options: GeneratedVariant["options"] = [];
  for (const raw of obj.options) {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as { label?: unknown; text?: unknown; isCorrect?: unknown };
    if (typeof o.label !== "string" || !["A", "B", "C", "D"].includes(o.label)) return null;
    if (typeof o.text !== "string" || o.text.trim().length === 0) return null;
    if (typeof o.isCorrect !== "boolean") return null;
    if (labels.has(o.label)) return null;
    const normalizedText = normalizeForDuplicateCheck(o.text);
    if (texts.has(normalizedText)) return null; // two identical option texts
    labels.add(o.label);
    texts.add(normalizedText);
    if (o.isCorrect) correctCount += 1;
    options.push({ label: o.label, text: o.text.trim(), isCorrect: o.isCorrect });
  }
  if (correctCount !== 1) return null; // exactly one correct option, no more, no less
  if (labels.size !== 4) return null;

  return { text: obj.text.trim(), options };
}

async function callGemini(parent: ParentQuestion, variantType: AiVariantType, apiKey: string, model: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(parent, variantType) }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 600 },
      }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ? `Gemini rejected the request: ${body.error.message}` : `AI variant request failed (${res.status}).`);
  }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}

/** Runs generation against an already-claimed (GENERATING) variant row, writing COMPLETED/FAILED in place. */
async function runGeneration(variantId: string, parent: ParentQuestion, variantType: AiVariantType, apiKey: string, model: string) {
  try {
    const raw = await callGemini(parent, variantType, apiKey, model);
    const validated = validateGenerated(raw);
    if (!validated) {
      throw new Error("AI returned a malformed question (wrong option count, no single correct option, or empty/duplicate option text).");
    }
    if (normalizeForDuplicateCheck(validated.text) === normalizeForDuplicateCheck(parent.text)) {
      throw new Error("AI returned a near-duplicate of the source question.");
    }
    const siblings = await prisma.question.findMany({
      where: { parentQuestionId: parent.id, id: { not: variantId } },
      select: { text: true },
    });
    if (siblings.some((s) => normalizeForDuplicateCheck(s.text) === normalizeForDuplicateCheck(validated.text))) {
      throw new Error("AI returned a duplicate of an existing sibling variant.");
    }

    await prisma.$transaction([
      prisma.questionOption.deleteMany({ where: { questionId: variantId } }),
      prisma.questionOption.createMany({
        data: validated.options.map((o, order) => ({ questionId: variantId, label: o.label, text: o.text, isCorrect: o.isCorrect, order })),
      }),
      prisma.question.update({
        where: { id: variantId },
        data: {
          text: validated.text,
          status: QuestionStatus.PUBLISHED, // only now, once validated — a failed generation never becomes usable (Step 7.2)
          aiGenerationStatus: AiGenerationStatus.COMPLETED,
          aiGeneratedAt: new Date(),
          aiErrorMessage: null,
        },
      }),
    ]);
  } catch (error) {
    await prisma.question.update({
      where: { id: variantId },
      data: {
        status: QuestionStatus.DRAFT, // stays out of every PUBLISHED-only student-facing query
        aiGenerationStatus: AiGenerationStatus.FAILED,
        aiErrorMessage: error instanceof Error ? error.message : "Generation failed.",
      },
    });
    throw error;
  }

  return prisma.question.findUniqueOrThrow({ where: { id: variantId }, include: { options: { orderBy: { order: "asc" } } } });
}

/**
 * Generates a new AI01–AI05 variant for a canonical question. The claim
 * (create a GENERATING placeholder row in the next free slot) and the max-5
 * enforcement both ride on `@@unique([parentQuestionId, aiSlot])` — two
 * concurrent requests can never claim the same slot, and once all 5 slots
 * exist the create is refused by `nextAvailableSlot` returning null before
 * any DB write happens.
 */
export async function generateVariant(parentQuestionId: string, variantType: AiVariantType) {
  const parent = await prisma.question.findUnique({ where: { id: parentQuestionId }, include: { options: { orderBy: { order: "asc" } } } });
  if (!parent) throw new Error("Source question not found.");
  if (parent.parentQuestionId) throw new InvalidVariantSourceError("Cannot generate a variant of a variant — pick the canonical (parent) question.");

  const geminiConfig = await getGeminiConfig();
  if (!geminiConfig.configured) throw new AiNotConfiguredError("AI variants aren't configured yet. An admin needs to add a Gemini API key under Settings → Authentication.");
  const apiKey = await getGeminiApiKey();
  if (!apiKey) throw new AiNotConfiguredError("AI variants aren't configured yet. An admin needs to add a Gemini API key under Settings → Authentication.");

  const existingSlots = new Set((await prisma.question.findMany({ where: { parentQuestionId }, select: { aiSlot: true } })).map((r) => r.aiSlot));
  const slot = ALL_SLOTS.find((s) => !existingSlots.has(s));
  if (!slot) throw new MaxVariantsReachedError("This question already has the maximum of 5 AI variants.");

  let variantId: string;
  try {
    const created = await prisma.question.create({
      data: {
        code: `${parent.code} ${slot}`,
        examId: parent.examId,
        subjectId: parent.subjectId,
        topicId: parent.topicId,
        subTopicId: parent.subTopicId,
        text: "Generating…",
        difficulty: parent.difficulty,
        status: QuestionStatus.DRAFT,
        source: parent.source,
        parentQuestionId,
        aiVariantType: variantType,
        aiSlot: slot,
        aiGenerationStatus: AiGenerationStatus.GENERATING,
        aiProvider: "gemini",
        aiModel: geminiConfig.model,
        aiPromptVersion: VARIANT_PROMPT_VERSION,
      },
    });
    variantId = created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new MaxVariantsReachedError("Another request just claimed this slot — please try again.");
    }
    throw error;
  }

  return runGeneration(variantId, parent, variantType, apiKey, geminiConfig.model);
}

/**
 * Retries a FAILED variant in place (same row, same slot, same code) —
 * failed generations are never deleted (auditability), just re-attempted.
 * The conditional `updateMany` is the same compare-and-swap pattern as
 * lib/ai-explanation.ts's claimGeneration: only one concurrent retry click
 * can ever win.
 */
export async function retryFailedVariant(variantId: string) {
  const variant = await prisma.question.findUnique({ where: { id: variantId } });
  if (!variant || !variant.parentQuestionId || !variant.aiVariantType) throw new InvalidVariantSourceError("Not an AI variant.");
  if (variant.aiGenerationStatus !== AiGenerationStatus.FAILED) throw new Error("Only a failed variant can be retried.");

  const parent = await prisma.question.findUnique({ where: { id: variant.parentQuestionId }, include: { options: { orderBy: { order: "asc" } } } });
  if (!parent) throw new Error("Source question no longer exists.");

  const geminiConfig = await getGeminiConfig();
  if (!geminiConfig.configured) throw new AiNotConfiguredError("AI variants aren't configured yet. An admin needs to add a Gemini API key under Settings → Authentication.");
  const apiKey = await getGeminiApiKey();
  if (!apiKey) throw new AiNotConfiguredError("AI variants aren't configured yet. An admin needs to add a Gemini API key under Settings → Authentication.");

  const claim = await prisma.question.updateMany({
    where: { id: variantId, aiGenerationStatus: AiGenerationStatus.FAILED },
    data: { aiGenerationStatus: AiGenerationStatus.GENERATING, aiPromptVersion: VARIANT_PROMPT_VERSION, aiModel: geminiConfig.model },
  });
  if (claim.count !== 1) throw new Error("This variant is already being retried elsewhere.");

  return runGeneration(variantId, parent, variant.aiVariantType, apiKey, geminiConfig.model);
}
