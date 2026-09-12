"use server";

import { redirect } from "next/navigation";
import { requireStudent } from "@/lib/student-session";
import { saveAnswer, submitAttempt, type QuestionSnapshot } from "@/lib/test-attempt";
import { getOrCreateExplanation, AiNotConfiguredError } from "@/lib/ai-explanation";

export async function saveAnswerAction(
  attemptId: string,
  questionId: string,
  selectedOptionLabel: string | null,
  markForReview: boolean
) {
  const student = await requireStudent();
  await saveAnswer(attemptId, student.id, questionId, selectedOptionLabel, markForReview);
}

export async function submitAttemptAction(attemptId: string) {
  const student = await requireStudent();
  await submitAttempt(attemptId, student.id);
  redirect(`/student/attempt/${attemptId}/result`);
}

export async function getExplanationAction(questionId: string, snapshot: QuestionSnapshot) {
  await requireStudent();
  try {
    const explanation = await getOrCreateExplanation(questionId, snapshot);
    return { ok: true as const, content: explanation.content as Record<string, string> };
  } catch (error) {
    if (error instanceof AiNotConfiguredError) {
      return { ok: false as const, error: error.message };
    }
    return { ok: false as const, error: error instanceof Error ? error.message : "Something went wrong generating the explanation." };
  }
}
