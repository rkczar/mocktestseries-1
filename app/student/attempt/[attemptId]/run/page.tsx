import { notFound, redirect } from "next/navigation";
import { AttemptStatus, AnswerStatus } from "@prisma/client";
import { requireStudent } from "@/lib/student-session";
import { getContentAccess, describeAttemptContent } from "@/lib/payments/access";
import { AccessLocked } from "@/components/student/access-locked";
import { getOwnedAttempt, getSavedQuestionIdSet } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { remainingSecondsFor, toServerTimedAttempt, type QuestionSnapshot } from "@/lib/test-attempt";
import { TestPlayer } from "./test-player";

export const metadata = { title: "Test in Progress — Mock Test Series.in" };

export default async function AttemptRunPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudent();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status === AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}/result`);

  // Entitlement re-check on every load: no paid question payload is ever
  // rendered for a student who doesn't currently hold access.
  const access = await getContentAccess(student.id, describeAttemptContent(attempt));
  if (!access.allowed) return <AccessLocked access={access} />;

  const remainingSeconds = remainingSecondsFor(toServerTimedAttempt(attempt));
  const savedIds = await getSavedQuestionIdSet(
    student.id,
    attempt.questions.map((tq) => tq.questionId)
  );

  const questions = attempt.questions.map((tq) => {
    const snapshot = tq.questionSnapshot as unknown as QuestionSnapshot;
    return {
      questionId: tq.questionId,
      text: snapshot.text,
      imageUrl: snapshot.imageUrl,
      difficulty: snapshot.difficulty,
      options: snapshot.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
      selectedOptionLabel: tq.answer?.selectedOptionLabel ?? null,
      markForReview:
        tq.answer?.status === AnswerStatus.MARKED_FOR_REVIEW || tq.answer?.status === AnswerStatus.ANSWERED_AND_MARKED,
      saved: savedIds.has(tq.questionId),
    };
  });

  const title = attemptTitle(attempt);

  return (
    <TestPlayer attemptId={attempt.id} title={title} initialRemainingSeconds={remainingSeconds} questions={questions} />
  );
}
