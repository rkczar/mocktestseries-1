import { notFound, redirect } from "next/navigation";
import { AttemptStatus, TestType } from "@prisma/client";
import Link from "next/link";
import { Clock, Lock } from "lucide-react";
import { describeAttemptContent, getAttemptReviewAccess, paywallHref } from "@/lib/payments/access";
import { Button } from "@/components/ui/button";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getOwnedAttempt, getSavedQuestionIdSet } from "@/lib/student-data";
import { prisma } from "@/lib/prisma";
import { isMockResultReleased, mockResultReleaseInstant } from "@/lib/mock-test-schedule";
import { formatIst } from "@/lib/ist-time";
import { getWhatsAppShareConfig, buildQuestionShareText } from "@/lib/whatsapp-share-config";
import { BackButton } from "@/components/student/back-button";
import type { QuestionSnapshot } from "@/lib/test-attempt";
import { explanationView, matchView, richQuestionView } from "@/lib/rich-content";
import { snapshotQuestionType, snapshotShareFields } from "@/lib/question-types";
import { Card, CardContent } from "@/components/ui/card";
import { AccessibilityControls } from "@/components/student/accessibility-controls";
import { StudentShell } from "@/components/student/shell";
import { AttemptReview, type ReviewQuestionView } from "./attempt-review";
import { toggleSaveQuestionAction, reportAttemptQuestionAction } from "../actions";

export const metadata = { title: "Review Answers — Mock Test Series.in" };

export default async function AttemptReviewPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudentOrLogin();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status !== AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}`);

  // Premium gate (server-side, every load): the review needs current access to
  // this test — the attempt record alone never unlocks it, so a Premium paper
  // taken during a trial locks again when the trial ends. Score, result and
  // history stay available; nothing below (answer key, explanations) is sent.
  const reviewAccess = await getAttemptReviewAccess(student.id, attempt);
  if (!reviewAccess.allowed) {
    const canBuy = !reviewAccess.purchasesPaused && reviewAccess.status !== "NOT_AVAILABLE";
    return (
      <StudentShell student={student}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
          <div className="flex items-center justify-between gap-2">
            <BackButton href={`/student/attempt/${attemptId}/result`} label="Back to Result" />
          </div>
          <Card data-testid="review-locked">
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <Lock className="h-8 w-8 text-[var(--color-primary)]" aria-hidden />
              <p className="text-base font-semibold text-[var(--color-foreground)]">Answer review needs Premium access</p>
              <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">
                {reviewAccess.status === "EXPIRED"
                  ? "Your access to this test has expired. Your score and result summary are still available. Renew to review each question with its answer and explanation."
                  : "Your score and result summary are still available. Upgrade to Premium to review each question with its answer and explanation."}
              </p>
              {canBuy ? (
                <Button asChild>
                  <Link href={paywallHref({ ...reviewAccess, trialUnused: false }, describeAttemptContent(attempt))}>Get Complete Access</Link>
                </Button>
              ) : (
                <p className="text-xs text-[var(--color-muted-foreground)]">Purchases are not available right now. Please check back soon.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </StudentShell>
    );
  }

  // Live Test: the answer key (correct option, per-option explanation) stays
  // hidden until the admin explicitly publishes results — a submission must
  // never itself expose it (Step 5.8).
  const heldMockResult = attempt.testType === TestType.FULL_MOCK && attempt.mockTest && !isMockResultReleased(attempt.mockTest);
  if (heldMockResult || (attempt.testType === TestType.LIVE_TEST && attempt.liveTest?.status !== "RESULT_PUBLISHED")) {
    const releaseAt = heldMockResult && attempt.mockTest ? mockResultReleaseInstant(attempt.mockTest) : null;
    return (
      <StudentShell student={student}>
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
          <div className="flex items-center justify-between gap-2">
            <BackButton href={`/student/attempt/${attemptId}/result`} label="Back to Result" />
            <AccessibilityControls className="max-md:hidden" />
          </div>
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
              <Clock className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
              <p className="text-sm font-medium text-[var(--color-foreground)]">Answer review isn&apos;t available yet</p>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                {releaseAt
                  ? `The answer key is released on ${formatIst(releaseAt)}.`
                  : "The answer key is released once results are published for everyone."}
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
    // Snapshot v2 only (v1/PLAIN add no keys). The answer key is already
    // released on this page (held results returned above), and so is the explanation.
    const rich = richQuestionView(snapshot);
    const explanation = explanationView(snapshot);
    // Snapshot v3 (NEET Phase 4) only — SINGLE_CORRECT rows get no new keys.
    const type = snapshotQuestionType(snapshot);
    const match = type === "MATCH_THE_FOLLOWING" ? matchView(snapshot) : null;
    return {
      attemptId,
      attemptQuestionId: tq.id,
      questionId: tq.questionId,
      snapshot,
      selected: tq.answer?.selectedOptionLabel ?? null,
      isCorrect: tq.answer?.isCorrect ?? null,
      saved: savedIds.has(tq.questionId),
      shareText: whatsappConfig.enabled
        ? buildQuestionShareText({
            template: whatsappConfig.template,
            examName: attempt.exam.name,
            subjectName: subjectByQuestionId.get(tq.questionId) ?? "",
            // Student-facing fields only — never snapshot.correctLabel.
            question: {
              text: snapshot.text,
              imageUrl: snapshot.imageUrl,
              options: snapshot.options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
              ...snapshotShareFields(snapshot),
            },
          })
        : null,
      saveAction: toggleSaveQuestionAction.bind(null, tq.questionId),
      reportAction: reportAttemptQuestionAction.bind(null, attemptId, tq.questionId),
      ...(rich ? { rich } : {}),
      ...(explanation ? { explanation } : {}),
      ...(type === "MULTIPLE_CORRECT" ? { selectedLabels: tq.answer?.selectedLabels ?? [] } : {}),
      ...(match ? { match } : {}),
    };
  });

  return (
    <StudentShell student={student}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between gap-2">
          <BackButton href={`/student/attempt/${attemptId}/result`} label="Back to Result" />
          <AccessibilityControls className="max-md:hidden" />
        </div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Review Answers</h1>

        <AttemptReview questions={questions} />
      </div>
    </StudentShell>
  );
}
