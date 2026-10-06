import { notFound, redirect } from "next/navigation";
import { AttemptStatus, AttemptAnswerMode, AttemptDurationMode } from "@prisma/client";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getContentAccess, describeAttemptContent } from "@/lib/payments/access";
import { AccessLocked } from "@/components/student/access-locked";
import { AttemptResetNotice } from "@/components/student/attempt-reset-notice";
import { getOwnedAttempt, getSavedQuestionIdSet } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { remainingSecondsFor, toServerTimedAttempt } from "@/lib/test-attempt";
import { toPlayerQuestions } from "@/lib/test-player-data";
import { snapshotShareFields } from "@/lib/question-types";
import { claimAttemptLease } from "@/lib/attempt-device-lease";
import { TestOpenElsewhere } from "@/components/student/test-open-elsewhere";
import { prisma } from "@/lib/prisma";
import { getWhatsAppShareConfig, buildQuestionShareText } from "@/lib/whatsapp-share-config";
import { TestPlayer, type PlayerQuestion } from "./test-player";

export const metadata = { title: "Test in Progress — Mock Test Series.in" };

export default async function AttemptRunPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudentOrLogin();
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

  let questions: PlayerQuestion[] = toPlayerQuestions(attempt.questions, { instantMode, savedIds });

  // "Show answer after each question": the same admin WhatsApp share text the
  // Review page builds (question + options only, never the correct answer),
  // offered by the player once a question has been checked.
  if (instantMode) {
    const whatsapp = await getWhatsAppShareConfig();
    if (whatsapp.enabled) {
      const subjects = await prisma.question.findMany({
        where: { id: { in: questions.map((q) => q.questionId) } },
        select: { id: true, subject: { select: { name: true } } },
      });
      const subjectById = new Map(subjects.map((row) => [row.id, row.subject.name]));
      const snapshotById = new Map(attempt.questions.map((tq) => [tq.questionId, tq.questionSnapshot as { v?: unknown; questionType?: unknown; matchSpec?: unknown }]));
      questions = questions.map((q) => ({
        ...q,
        shareText: q.malformed
          ? null
          : buildQuestionShareText({
              template: whatsapp.template,
              examName: attempt.exam.name,
              subjectName: subjectById.get(q.questionId) ?? "",
              question: { text: q.text, imageUrl: q.imageUrl, options: q.options, ...snapshotShareFields(snapshotById.get(q.questionId)) },
            }),
      }));
    }
  }

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
