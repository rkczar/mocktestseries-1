"use server";

import { redirect } from "next/navigation";
import type { ReportType } from "@prisma/client";
import { requireStudentOrLogin } from "@/lib/student-session";
import { revealAnswer, saveAnswer, submitAttempt } from "@/lib/test-attempt";
import { toggleSavedQuestion, reportQuestion } from "@/lib/student-data";
import { logEngine, SLOW_OP_MS, TestEngineError, type EngineErrorCode, type EngineOp } from "@/lib/test-engine-log";

/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH (see ops/TEST-ENGINE.md).
 *
 * Save/reveal return a structured result instead of throwing: production
 * Next.js replaces thrown messages with a generic digest, so the player
 * could never tell "time is up" from a network blip. Known failures carry a
 * safe code + student-facing message; anything unexpected is logged and
 * reported as INTERNAL (retryable). No stack traces reach the student.
 */
export type EngineResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: EngineErrorCode; message: string };

async function runEngineOp<T extends object>(
  op: EngineOp,
  ids: { attemptId: string; questionId?: string },
  fn: () => Promise<T>
): Promise<EngineResult<T>> {
  const t0 = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - t0;
    if (ms > SLOW_OP_MS) logEngine({ op, ...ids, code: "SLOW", ms });
    return { ok: true, ...value };
  } catch (error) {
    const ms = Date.now() - t0;
    if (error instanceof TestEngineError) {
      // Expected outcomes (time up / already submitted) are not worth a log line each.
      if (error.code !== "EXPIRED" && error.code !== "NOT_EDITABLE") logEngine({ op, ...ids, code: error.code, ms });
      return { ok: false, code: error.code, message: error.message };
    }
    logEngine({ op, ...ids, code: "INTERNAL", ms });
    console.error("[test-engine] internal error", error instanceof Error ? error.name : typeof error);
    return { ok: false, code: "INTERNAL", message: "Could not reach the server. Your answer is kept on this device." };
  }
}

export async function saveAnswerAction(
  attemptId: string,
  questionId: string,
  selectedOptionLabel: string | null,
  markForReview: boolean,
  seq?: number
): Promise<EngineResult<{ applied: boolean }>> {
  const student = await requireStudentOrLogin();
  return runEngineOp("save", { attemptId, questionId }, () =>
    saveAnswer(attemptId, student.id, questionId, selectedOptionLabel, markForReview, seq)
  );
}

/** INSTANT answer mode only — the server decides; the client never holds the key beforehand. */
export async function revealAnswerAction(
  attemptId: string,
  questionId: string,
  selectedOptionLabel: string,
  seq?: number
): Promise<EngineResult<{ selectedOptionLabel: string | null; correctLabel: string; isCorrect: boolean }>> {
  const student = await requireStudentOrLogin();
  return runEngineOp("reveal", { attemptId, questionId }, () =>
    revealAnswer(attemptId, student.id, questionId, selectedOptionLabel, seq)
  );
}

export async function submitAttemptAction(attemptId: string) {
  const student = await requireStudentOrLogin();
  const t0 = Date.now();
  try {
    await submitAttempt(attemptId, student.id);
  } catch (error) {
    logEngine({ op: "submit", attemptId, code: "INTERNAL", ms: Date.now() - t0 });
    throw error;
  }
  const ms = Date.now() - t0;
  if (ms > SLOW_OP_MS) logEngine({ op: "submit", attemptId, code: "SLOW", ms });
  redirect(`/student/attempt/${attemptId}/result`);
}

export async function toggleSaveQuestionAction(questionId: string) {
  const student = await requireStudentOrLogin();
  await toggleSavedQuestion(student.id, questionId);
}

export async function reportAttemptQuestionAction(
  attemptId: string,
  questionId: string,
  reportType: ReportType,
  message: string
) {
  const student = await requireStudentOrLogin();
  await reportQuestion(student.id, questionId, reportType, message || undefined, attemptId);
}
