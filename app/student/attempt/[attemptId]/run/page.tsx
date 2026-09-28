import { notFound, redirect } from "next/navigation";
import { AttemptStatus, AttemptAnswerMode, AttemptDurationMode } from "@prisma/client";
import { requireStudent } from "@/lib/student-session";
import { getContentAccess, describeAttemptContent } from "@/lib/payments/access";
import { AccessLocked } from "@/components/student/access-locked";
import { AttemptResetNotice } from "@/components/student/attempt-reset-notice";
import { getOwnedAttempt, getSavedQuestionIdSet } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { remainingSecondsFor, toServerTimedAttempt } from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { claimAttemptLease } from "@/lib/attempt-device-lease";
import { TestOpenElsewhere } from "@/components/student/test-open-elsewhere";
import { TestPlayer } from "./test-player";

export const metadata = { title: "Test in Progress — Mock Test Series.in" };

export default async function AttemptRunPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudent();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status === AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}/result`);
  if (attempt.status === AttemptStatus.ABANDONED) return <AttemptResetNotice isPyq={Boolean(attempt.previousYearPaperId)} />;

  // Entitlement re-check on every load: no paid question payload is ever
  // rendered for a student who doesn't currently hold access.
  const access = await getContentAccess(student.id, describeAttemptContent(attempt));
  if (!access.allowed) return <AccessLocked access={access} />;

  // One Active Test Device: claim the attempt for this device before any
  // question is rendered. Another device holding it keeps it.
  const lease = await claimAttemptLease(attempt.id, student.id, student.deviceId);
  if (!lease.ok) return <TestOpenElsewhere attemptId={attempt.id} />;

  // null = UNLIMITED practice: no countdown, no time-based auto-submit.
  const remainingSeconds =
    attempt.durationMode === AttemptDurationMode.UNLIMITED ? null : remainingSecondsFor(toServerTimedAttempt(attempt));
  const instantMode = attempt.answerMode === AttemptAnswerMode.INSTANT;
  const savedIds = await getSavedQuestionIdSet(
    student.id,
    attempt.questions.map((tq) => tq.questionId)
  );

  const questions = toPlayerQuestions(attempt.questions, { instantMode, savedIds });

  const title = attemptTitle(attempt);

  return (
    <TestPlayer
      attemptId={attempt.id}
      title={title}
      initialRemainingSeconds={remainingSeconds}
      instantMode={instantMode}
      questions={questions}
    />
  );
}
