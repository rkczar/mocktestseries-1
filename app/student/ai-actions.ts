"use server";

import { requireStudent } from "@/lib/student-session";
import { getOrCreateExplanation, AiNotConfiguredError, AiGenerationInProgressError } from "@/lib/ai-explanation";
import { getStoredAiExplanation, isAiGenerationRateLimited, logActivity } from "@/lib/student-data";

/**
 * Shared by every context that shows a question with an "Ask AI" button
 * (attempt review, Saved Questions) — the explanation is cached per Question,
 * not per attempt or per page, so one action serves all of them.
 */
export async function getExplanationAction(questionId: string) {
  const student = await requireStudent();

  const cached = await getStoredAiExplanation(questionId);
  const isNewGeneration = cached?.status !== "COMPLETED";

  if (isNewGeneration && (await isAiGenerationRateLimited(student.id))) {
    return { ok: false as const, error: "You've requested a lot of new AI explanations recently — please wait a bit and try again." };
  }

  try {
    const explanation = await getOrCreateExplanation(questionId);
    if (isNewGeneration) await logActivity(student.id, "AI_EXPLANATION_GENERATED", { questionId });
    return { ok: true as const, content: explanation.content as Record<string, string> };
  } catch (error) {
    if (error instanceof AiNotConfiguredError) return { ok: false as const, error: error.message };
    if (error instanceof AiGenerationInProgressError) return { ok: false as const, error: error.message, retry: true as const };
    return { ok: false as const, error: error instanceof Error ? error.message : "Something went wrong generating the explanation." };
  }
}
