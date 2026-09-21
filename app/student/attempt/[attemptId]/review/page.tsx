import { notFound, redirect } from "next/navigation";
import { AttemptStatus, TestType } from "@prisma/client";
import { Clock } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getOwnedAttempt, getSavedQuestionIdSet } from "@/lib/student-data";
import { prisma } from "@/lib/prisma";
import { getWhatsAppShareConfig, renderWhatsAppShareText } from "@/lib/whatsapp-share-config";
import { BackButton } from "@/components/student/back-button";
import type { QuestionSnapshot } from "@/lib/test-attempt";
import { Card, CardContent } from "@/components/ui/card";
import { AccessibilityControls } from "@/components/student/accessibility-controls";
import { StudentShell } from "@/components/student/shell";
import { AttemptReview, type ReviewQuestionView } from "./attempt-review";
import { toggleSaveQuestionAction, reportAttemptQuestionAction } from "../actions";

export const metadata = { title: "Review Answers — Mock Test Series.in" };

const SITE_URL = process.env.NEXTAUTH_URL ?? "https://mocktestseries.in";

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
      <StudentShell student={student}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
          <div className="flex items-center justify-between gap-2">
            <BackButton href={`/student/attempt/${attemptId}/result`} label="Back to Result" />
            <AccessibilityControls />
          </div>
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
      </StudentShell>
    );
  }

  const questionIds = attempt.questions.map((tq) => tq.questionId);
  const whatsappConfig = await getWhatsAppShareConfig();

  const [savedIds, subjectByQuestionId] = await Promise.all([
    getSavedQuestionIdSet(student.id, questionIds),
    whatsappConfig.enabled
      ? prisma.question
          .findMany({ where: { id: { in: questionIds } }, select: { id: true, subject: { select: { name: true } } } })
          .then((rows) => new Map(rows.map((r) => [r.id, r.subject.name])))
      : Promise.resolve(new Map<string, string>()),
  ]);

  const questions: ReviewQuestionView[] = attempt.questions.map((tq) => {
    const snapshot = tq.questionSnapshot as unknown as QuestionSnapshot;
    return {
      attemptQuestionId: tq.id,
      questionId: tq.questionId,
      snapshot,
      selected: tq.answer?.selectedOptionLabel ?? null,
      isCorrect: tq.answer?.isCorrect ?? null,
      saved: savedIds.has(tq.questionId),
      shareText: whatsappConfig.enabled
        ? renderWhatsAppShareText(whatsappConfig.template, {
            exam: attempt.exam.name,
            subject: subjectByQuestionId.get(tq.questionId) ?? "",
            question: snapshot.text,
            website_url: SITE_URL,
          })
        : null,
      saveAction: toggleSaveQuestionAction.bind(null, tq.questionId),
      reportAction: reportAttemptQuestionAction.bind(null, attemptId, tq.questionId),
    };
  });

  return (
    <StudentShell student={student}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between gap-2">
          <BackButton href={`/student/attempt/${attemptId}/result`} label="Back to Result" />
          <AccessibilityControls />
        </div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Review Answers</h1>

        <AttemptReview questions={questions} />
      </div>
    </StudentShell>
  );
}
