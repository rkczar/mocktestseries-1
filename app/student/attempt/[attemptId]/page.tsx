import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AttemptStatus } from "@prisma/client";
import { ClipboardList, Clock, ListChecks, AlertTriangle } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getOwnedAttempt } from "@/lib/student-data";
import { attemptTitle, attemptInstructions } from "@/lib/attempt-title";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Test Instructions — Mock Test Series.in" };

type OwnedAttempt = NonNullable<Awaited<ReturnType<typeof getOwnedAttempt>>>;

export default async function AttemptInstructionsPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await params;
  const student = await requireStudent();
  const attempt = await getOwnedAttempt(attemptId, student.id);
  if (!attempt) notFound();
  if (attempt.status === AttemptStatus.SUBMITTED) redirect(`/student/attempt/${attemptId}/result`);

  const title = attemptTitle(attempt as OwnedAttempt);
  const instructions = attemptInstructions(attempt as OwnedAttempt);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10 sm:px-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">{title}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{attempt.exam.name}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4" aria-hidden /> Test Overview
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <Clock className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Duration</p>
              <p className="font-semibold text-[var(--color-foreground)]">{attempt.durationMinutes} min</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <ListChecks className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Questions</p>
              <p className="font-semibold text-[var(--color-foreground)]">{attempt.totalQuestions}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Negative Marking</p>
              <p className="font-semibold text-[var(--color-foreground)]">
                {attempt.negativeMarking > 0 ? `-${attempt.negativeMarking} per wrong` : "None"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {instructions ? (
        <Card>
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-[var(--color-muted-foreground)]">{instructions}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5 text-sm text-[var(--color-muted-foreground)]">
          <ul className="list-disc space-y-1 pl-5">
            <li>The timer starts as soon as you click Start Test and cannot be paused.</li>
            <li>The test auto-submits when time runs out.</li>
            <li>You can navigate between questions and change answers until you submit.</li>
            {attempt.negativeMarking > 0 ? <li>Each wrong answer deducts {attempt.negativeMarking} mark(s).</li> : null}
          </ul>
        </CardContent>
      </Card>

      <Button asChild size="lg" className="w-full">
        <Link href={`/student/attempt/${attemptId}/run`}>Start Test</Link>
      </Button>
    </div>
  );
}
