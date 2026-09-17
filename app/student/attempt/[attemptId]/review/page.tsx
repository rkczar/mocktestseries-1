import { notFound, redirect } from "next/navigation";
import { AttemptStatus, TestType } from "@prisma/client";
import { Clock } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getOwnedAttempt, getSavedQuestionIdSet } from "@/lib/student-data";
import { BackButton } from "@/components/student/back-button";
import { SaveQuestionButton } from "@/components/student/save-question-button";
import { ReportQuestionDialog } from "@/components/student/report-question-dialog";
import type { QuestionSnapshot } from "@/lib/test-attempt";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { ExplanationPanel } from "./explanation-panel";
import { toggleSaveQuestionAction, reportAttemptQuestionAction } from "../actions";

export const metadata = { title: "Review Answers — Mock Test Series.in" };

export default async function AttemptReviewPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudent();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status !== AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}`);

  // Live Test: the answer key (correct option, per-option explanation) stays
  // hidden until the admin explicitly publishes results — a submission must
  // never itself expose it (Step 5.8).
  if (attempt.testType === TestType.LIVE_TEST && attempt.liveTest?.status !== "RESULT_PUBLISHED") {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        <BackButton href={`/student/attempt/${attemptId}/result`} label="Back to Result" />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Clock className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
            <p className="text-sm font-medium text-[var(--color-foreground)]">Answer review isn&apos;t available yet</p>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              This is a Live Test — the answer key is released once results are published for everyone.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const savedIds = await getSavedQuestionIdSet(
    student.id,
    attempt.questions.map((tq) => tq.questionId)
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <BackButton href={`/student/attempt/${attemptId}/result`} label="Back to Result" />
      <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Review Answers</h1>

      <div className="flex flex-col gap-4">
        {attempt.questions.map((tq, i) => {
          const snapshot = tq.questionSnapshot as unknown as QuestionSnapshot;
          const selected = tq.answer?.selectedOptionLabel ?? null;
          const isCorrect = tq.answer?.isCorrect ?? null;

          return (
            <div key={tq.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] p-5">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium text-[var(--color-muted-foreground)]">Question {i + 1}</span>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-xs font-medium",
                    isCorrect === true && "bg-[var(--color-success)]/15 text-[var(--color-success)]",
                    isCorrect === false && "bg-[var(--color-error)]/15 text-[var(--color-error)]",
                    isCorrect === null && "bg-[var(--color-border)] text-[var(--color-muted-foreground)]"
                  )}
                >
                  {isCorrect === true ? "Correct" : isCorrect === false ? "Incorrect" : "Not Answered"}
                </span>
              </div>

              <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--color-foreground)]">{snapshot.text}</p>
              {snapshot.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={snapshot.imageUrl}
                  alt=""
                  className="mt-3 max-h-72 rounded-[var(--radius-card)] border border-[var(--color-border)] object-contain"
                />
              ) : null}

              <div className="mt-4 flex flex-col gap-2">
                {snapshot.options.map((opt) => {
                  const isSelected = selected === opt.label;
                  const isAnswer = opt.label === snapshot.correctLabel;
                  return (
                    <div
                      key={opt.label}
                      className={cn(
                        "rounded-[var(--radius-card)] border p-3 text-sm",
                        isAnswer
                          ? "border-[var(--color-success)] bg-[var(--color-success)]/10"
                          : isSelected
                            ? "border-[var(--color-error)] bg-[var(--color-error)]/10"
                            : "border-[var(--color-border)]"
                      )}
                    >
                      <span className="font-semibold">{opt.label}.</span> {opt.text}
                      {isAnswer ? <span className="ml-2 text-xs font-medium text-[var(--color-success)]">Correct answer</span> : null}
                      {isSelected && !isAnswer ? (
                        <span className="ml-2 text-xs font-medium text-[var(--color-error)]">Your answer</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex gap-2">
                <SaveQuestionButton
                  initialSaved={savedIds.has(tq.questionId)}
                  onToggle={toggleSaveQuestionAction.bind(null, tq.questionId)}
                />
                <ReportQuestionDialog onSubmit={reportAttemptQuestionAction.bind(null, attemptId, tq.questionId)} />
              </div>

              <ExplanationPanel questionId={tq.questionId} snapshot={snapshot} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
