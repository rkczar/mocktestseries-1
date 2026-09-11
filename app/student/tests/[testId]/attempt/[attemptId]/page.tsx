import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { TestPlayer } from "@/components/student/TestPlayer";
import { requireStudent } from "@/lib/auth/requireStudent";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Test in progress" };

export default async function TestAttemptPage({
  params,
}: {
  params: Promise<{ testId: string; attemptId: string }>;
}) {
  const { testId, attemptId } = await params;
  const { student } = await requireStudent(`/student/tests/${testId}/attempt/${attemptId}`);

  const attempt = await prisma.testAttempt.findUnique({
    where: { id: attemptId },
    include: {
      test: {
        include: {
          questions: {
            where: { status: "PUBLISHED" },
            orderBy: { order: "asc" },
            // correctAnswer, explanation and aiExplanation are deliberately excluded — this
            // payload reaches the browser while the attempt is still in progress.
            select: { id: true, stem: true, optionA: true, optionB: true, optionC: true, optionD: true },
          },
        },
      },
    },
  });

  if (!attempt || attempt.studentId !== student.id || attempt.testId !== testId) notFound();
  if (attempt.submittedAt) redirect(`/student/attempts/${attempt.id}`);

  return (
    <TestPlayer
      attemptId={attempt.id}
      testId={attempt.testId}
      title={attempt.test.title}
      durationMin={attempt.test.durationMin}
      startedAt={attempt.startedAt.toISOString()}
      questions={attempt.test.questions}
      initialAnswers={(attempt.answers as Record<string, string> | null) ?? {}}
    />
  );
}
