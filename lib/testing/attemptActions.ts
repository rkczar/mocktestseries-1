"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { requireStudentSession, UnauthorizedError } from "@/lib/auth/requireStudent";
import { prisma } from "@/lib/db";
import { scoreAttempt } from "@/lib/testing/scoring";

const answersSchema = z.record(z.string(), z.enum(["A", "B", "C", "D"]));

async function loadOwnedAttempt(attemptId: string, studentId: string) {
  const attempt = await prisma.testAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.studentId !== studentId) throw new Error("Attempt not found.");
  return attempt;
}

async function loadOwnedOpenAttempt(attemptId: string, studentId: string) {
  const attempt = await loadOwnedAttempt(attemptId, studentId);
  if (attempt.submittedAt) throw new Error("This attempt has already been submitted.");
  return attempt;
}

export type SaveProgressResult = { ok: true } | { ok: false; error: string };

export async function saveProgressAction(
  attemptId: string,
  answers: Record<string, string>,
): Promise<SaveProgressResult> {
  try {
    const { student } = await requireStudentSession();
    const parsed = answersSchema.safeParse(answers);
    if (!parsed.success) return { ok: false, error: "Invalid answers." };

    await loadOwnedOpenAttempt(attemptId, student.id);
    await prisma.testAttempt.update({
      where: { id: attemptId },
      data: { answers: parsed.data },
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof UnauthorizedError) return { ok: false, error: "Session expired." };
    return { ok: false, error: error instanceof Error ? error.message : "Could not save." };
  }
}

export async function submitAttemptAction(
  attemptId: string,
  answers: Record<string, string>,
): Promise<void> {
  const { student } = await requireStudentSession();
  const attempt = await loadOwnedAttempt(attemptId, student.id);

  // A retried/duplicate call (double-click, timer auto-submit racing a manual submit) lands on
  // an already-submitted attempt — that's not an error, the student's result already exists.
  if (attempt.submittedAt) redirect(`/student/attempts/${attemptId}`);

  const parsed = answersSchema.safeParse(answers);
  // On a malformed payload, fall back to whatever was last autosaved rather than wiping the
  // attempt's answers with an empty object — autosave already validated what's in the database.
  const safeAnswers = parsed.success
    ? parsed.data
    : ((attempt.answers as Record<string, string> | null) ?? {});

  const test = await prisma.test.findUniqueOrThrow({
    where: { id: attempt.testId },
    include: {
      questions: {
        where: { status: "PUBLISHED" },
        select: { id: true, marks: true, correctAnswer: true, subjectId: true, subject: { select: { name: true } } },
      },
    },
  });

  const timeTakenSec = Math.max(0, Math.round((Date.now() - attempt.startedAt.getTime()) / 1000));

  const { score, analytics } = scoreAttempt(
    test.questions.map((q) => ({
      id: q.id,
      marks: q.marks,
      correctAnswer: q.correctAnswer,
      subjectId: q.subjectId,
      subjectName: q.subject?.name ?? null,
    })),
    safeAnswers,
    test.negativeMark,
    timeTakenSec,
  );

  // Guarded by `submittedAt: null` rather than a plain update — if a concurrent request (a
  // second tab, a retried request racing the timer's auto-submit) submitted first, this simply
  // does nothing instead of overwriting their already-scored result.
  await prisma.testAttempt.updateMany({
    where: { id: attemptId, submittedAt: null },
    data: {
      answers: safeAnswers,
      submittedAt: new Date(),
      score,
      analytics: analytics as unknown as object,
    },
  });

  redirect(`/student/attempts/${attemptId}`);
}
