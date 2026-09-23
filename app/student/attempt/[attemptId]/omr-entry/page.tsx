import { notFound, redirect } from "next/navigation";
import { AttemptStatus } from "@prisma/client";
import { requireStudent } from "@/lib/student-session";
import { getOwnedAttempt } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import type { QuestionSnapshot } from "@/lib/test-attempt";
import { OmrEntryForm } from "./omr-entry-form";

export const metadata = { title: "Enter OMR Answers — Mock Test Series.in" };

/**
 * Offline OMR Answer Entry (Phase 3): reachable only for attempts started
 * via startOfflineOmrEntryAttempt (entryMode OFFLINE_OMR_ENTRY). Shows only
 * option labels per question — never question text/images — since the
 * student already has the printed paper in front of them. Scoring goes
 * through the exact same saveAnswer/submitAttempt as the online test player.
 */
export default async function OmrEntryPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudent();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status === AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}/result`);
  if (attempt.entryMode !== "OFFLINE_OMR_ENTRY") redirect(`/student/attempt/${attemptId}/run`);

  const questions = attempt.questions.map((tq, index) => {
    const snapshot = tq.questionSnapshot as unknown as QuestionSnapshot;
    return {
      questionId: tq.questionId,
      questionNumber: index + 1,
      optionLabels: snapshot.options.map((o) => o.label),
      selectedOptionLabel: tq.answer?.selectedOptionLabel ?? null,
    };
  });

  const title = attemptTitle(attempt);

  return <OmrEntryForm attemptId={attempt.id} title={title} questions={questions} />;
}
