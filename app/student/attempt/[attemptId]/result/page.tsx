import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AttemptStatus, TestType } from "@prisma/client";
import { CheckCircle2, Clock, MinusCircle, Trophy, XCircle } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getOwnedAttempt } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { prisma } from "@/lib/prisma";
import { getMockTestLeaderboard } from "@/lib/leaderboard";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { WhatsAppShareButton } from "@/components/student/whatsapp-share-button";
import { AccessibilityControls } from "@/components/student/accessibility-controls";
import { StudentShell } from "@/components/student/shell";
import { SubjectPerformance } from "./subject-performance";
import { Leaderboard } from "./leaderboard";
import { PrintPracticeKit } from "./print-practice-kit";

export const metadata = { title: "Test Result — Mock Test Series.in" };

export default async function AttemptResultPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudent();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status !== AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}`);

  const title = attemptTitle(attempt);
  const reviewLocked = attempt.testType === TestType.LIVE_TEST && attempt.liveTest?.status !== "RESULT_PUBLISHED";

  const percentage = attempt.maxScore ? Math.max(0, Math.round(((attempt.score ?? 0) / attempt.maxScore) * 100)) : 0;
  const minutesTaken = attempt.timeTakenSeconds ? Math.round(attempt.timeTakenSeconds / 60) : 0;

  // Subject-wise breakdown, Topic Insights, Leaderboard, and Print Practice
  // Kit only make sense for full Mock Test attempts (Subject/Grand/Live/PYQ/
  // Custom Module attempts skip this section entirely).
  const isMockTest = attempt.testType === TestType.FULL_MOCK && attempt.mockTestId;

  let performance: ReturnType<typeof buildPerformanceBreakdown> = { subjects: [], strongTopics: [], needsImprovementTopics: [] };
  let leaderboard: Awaited<ReturnType<typeof getMockTestLeaderboard>> | null = null;
  let paperResourceId: string | null = null;
  let omrResourceId: string | null = null;

  if (isMockTest && attempt.mockTestId) {
    const questionIds = attempt.questions.map((q) => q.questionId);
    const [questions, board, paperResource, omrResource] = await Promise.all([
      prisma.question.findMany({
        where: { id: { in: questionIds } },
        select: { id: true, subject: { select: { name: true } }, topic: { select: { name: true } } },
      }),
      getMockTestLeaderboard(attempt.mockTestId, student.id),
      prisma.testResource.findFirst({
        where: { type: "PAPER_PDF", isActive: true, mockTestId: attempt.mockTestId },
        select: { id: true },
      }),
      resolveOmrResource(attempt.mockTestId, attempt.examId),
    ]);
    performance = buildPerformanceBreakdown(attempt.questions, questions);
    leaderboard = board;
    paperResourceId = paperResource?.id ?? null;
    omrResourceId = omrResource;
  }

  return (
    <StudentShell student={student}>
      <div className="mx-auto flex w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10 sm:px-6">
        <AccessibilityControls className="justify-end" />
        <div className="text-center">
          <Trophy className="mx-auto h-10 w-10 text-[var(--color-accent)]" aria-hidden />
          <h1 className="mt-2 text-2xl font-semibold text-[var(--color-foreground)]">{title}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">Test submitted successfully</p>
        </div>

        <Card>
          <CardContent className="flex flex-col items-center gap-1 py-8">
            <p className="text-5xl font-bold text-[var(--color-foreground)]">{(attempt.score ?? 0).toFixed(2)}</p>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              out of {attempt.maxScore} ({percentage}%)
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={<CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" aria-hidden />}
            label="Correct"
            value={attempt.correctCount ?? 0}
          />
          <StatTile
            icon={<XCircle className="h-5 w-5 text-[var(--color-error)]" aria-hidden />}
            label="Incorrect"
            value={attempt.incorrectCount ?? 0}
          />
          <StatTile
            icon={<MinusCircle className="h-5 w-5 text-[var(--color-muted-foreground)]" aria-hidden />}
            label="Unanswered"
            value={attempt.unansweredCount ?? 0}
          />
          <StatTile
            icon={<Clock className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />}
            label="Time Taken"
            value={`${minutesTaken} min`}
          />
        </div>

        {reviewLocked ? (
          <p className="text-center text-xs text-[var(--color-muted-foreground)]">
            Answer review will be available once results are published for this Live Test.
          </p>
        ) : null}

        {isMockTest ? <SubjectPerformance performance={performance} /> : null}

        {isMockTest && leaderboard ? (
          <Leaderboard data={leaderboard} isLeaderboardAttempt={attempt.isLeaderboardAttempt} />
        ) : null}

        {isMockTest && (paperResourceId || omrResourceId) ? (
          <PrintPracticeKit paperResourceId={paperResourceId} omrResourceId={omrResourceId} />
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild variant="outline" className="flex-1">
            <Link href="/student/dashboard">Back to Dashboard</Link>
          </Button>
          <Button asChild className="flex-1" disabled={reviewLocked}>
            <Link href={`/student/attempt/${attemptId}/review`} aria-disabled={reviewLocked}>
              Review Answers
            </Link>
          </Button>
        </div>

        <WhatsAppShareButton
          text={`I scored ${(attempt.score ?? 0).toFixed(2)}/${attempt.maxScore} (${percentage}%) on "${title}" — Mock Test Series.in`}
        />
      </div>
    </StudentShell>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-1 py-4">
        {icon}
        <p className="text-lg font-semibold text-[var(--color-foreground)]">{value}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
      </CardContent>
    </Card>
  );
}

type AttemptQuestionRow = {
  questionId: string;
  answer: { isCorrect: boolean | null; selectedOptionLabel: string | null } | null;
};

type QuestionMeta = {
  id: string;
  subject: { name: string } | null;
  topic: { name: string } | null;
};

export interface SubjectRow {
  subjectName: string;
  questions: number;
  attempted: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  marks: number;
  maxMarks: number;
  accuracy: number;
}

export interface TopicRow {
  topicName: string;
  accuracy: number;
  attempted: number;
}

/**
 * Groups by the LIVE Question -> Subject/Topic relation (taxonomy labels
 * only) but scores strictly from the frozen per-attempt Answer.isCorrect —
 * never from the live Question's current correct answer. Taxonomy
 * (subject/topic assignment) is not part of what TestAttemptQuestion.
 * questionSnapshot freezes, and re-categorizing a submitted paper if an
 * admin later fixes a question's subject/topic is the desired behavior;
 * re-scoring it against a live, possibly-edited correct answer would not be
 * — that's exactly what the frozen snapshot prevents.
 */
function buildPerformanceBreakdown(questions: AttemptQuestionRow[], meta: QuestionMeta[]) {
  const metaById = new Map(meta.map((m) => [m.id, m]));

  const bySubject = new Map<string, SubjectRow>();
  const byTopic = new Map<string, { correct: number; attempted: number }>();

  for (const q of questions) {
    const m = metaById.get(q.questionId);
    const subjectName = m?.subject?.name ?? "Uncategorized";
    const attempted = q.answer?.selectedOptionLabel != null;
    const correct = q.answer?.isCorrect === true;
    const incorrect = q.answer?.isCorrect === false;

    if (!bySubject.has(subjectName)) {
      bySubject.set(subjectName, {
        subjectName,
        questions: 0,
        attempted: 0,
        correct: 0,
        incorrect: 0,
        unanswered: 0,
        marks: 0,
        maxMarks: 0,
        accuracy: 0,
      });
    }
    const row = bySubject.get(subjectName)!;
    row.questions += 1;
    row.maxMarks += 1;
    if (attempted) row.attempted += 1;
    else row.unanswered += 1;
    if (correct) {
      row.correct += 1;
      row.marks += 1;
    } else if (incorrect) {
      row.incorrect += 1;
    }

    if (m?.topic?.name) {
      const topicName = m.topic.name;
      if (!byTopic.has(topicName)) byTopic.set(topicName, { correct: 0, attempted: 0 });
      const t = byTopic.get(topicName)!;
      if (attempted) t.attempted += 1;
      if (correct) t.correct += 1;
    }
  }

  const subjects = Array.from(bySubject.values()).map((row) => ({
    ...row,
    accuracy: row.attempted > 0 ? row.correct / row.attempted : 0,
  }));

  const topics: TopicRow[] = Array.from(byTopic.entries())
    .filter(([, t]) => t.attempted > 0)
    .map(([topicName, t]) => ({ topicName, accuracy: t.correct / t.attempted, attempted: t.attempted }));

  const strongTopics = topics.filter((t) => t.accuracy >= 0.7).sort((a, b) => b.accuracy - a.accuracy).slice(0, 5);
  const needsImprovementTopics = topics.filter((t) => t.accuracy < 0.5).sort((a, b) => a.accuracy - b.accuracy).slice(0, 5);

  return { subjects, strongTopics, needsImprovementTopics };
}

/** Resolution order for "which OMR applies here": mockTest -> exam -> global. */
async function resolveOmrResource(mockTestId: string, examId: string): Promise<string | null> {
  const byMockTest = await prisma.testResource.findFirst({
    where: { type: "OMR_TEMPLATE", isActive: true, mockTestId },
    select: { id: true },
  });
  if (byMockTest) return byMockTest.id;

  const byExam = await prisma.testResource.findFirst({
    where: { type: "OMR_TEMPLATE", isActive: true, examId, mockTestId: null },
    select: { id: true },
  });
  if (byExam) return byExam.id;

  const global = await prisma.testResource.findFirst({
    where: { type: "OMR_TEMPLATE", isActive: true, examId: null, testSeriesId: null, mockTestId: null },
    select: { id: true },
  });
  return global?.id ?? null;
}
