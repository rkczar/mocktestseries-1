import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AttemptStatus, TestType } from "@prisma/client";
import { CheckCircle2, Clock, MinusCircle, Trophy, XCircle } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getOwnedAttempt } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

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

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10 sm:px-6">
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
    </div>
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
