import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CalendarClock, Clock, ListChecks, Lock } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getMockTestDetailForStudent } from "@/lib/student-data";
import { AVAILABILITY_LABELS, isMockResultReleased } from "@/lib/mock-test-schedule";
import { loadAccessContext, evaluateContentAccess, paywallHref } from "@/lib/payments/access";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BackButton } from "@/components/student/back-button";
import { StartMockForm } from "./start-mock-form";

export const metadata = { title: "Mock Test — Mock Test Series.in" };

const COVERAGE_LABELS = { FULL_SYLLABUS: "Full Syllabus", PARTIAL_SYLLABUS: "Partial Syllabus", SUBJECT_WISE: "Subject-wise" } as const;

/**
 * Mock Test Details / Instructions — the step between a Mock Test card and
 * the attempt. No TestAttempt exists until the student presses Start here,
 * so the timer never runs while they read. Availability, entitlement and the
 * attempt policy are shown for guidance only; startMockTestAttempt enforces
 * all of them again when Start is pressed.
 */
export default async function MockTestDetailsPage({ params }: { params: Promise<{ mockTestId: string }> }) {
  const { mockTestId } = await params;
  const student = await requireStudent();
  const detail = await getMockTestDetailForStudent(student.id, mockTestId);
  if (!detail) notFound();

  const { mockTest, availability, inProgressAttempt, latestSubmittedAttempt } = detail;
  const access = evaluateContentAccess(await loadAccessContext(student.id), {
    kind: "MOCK_TEST",
    id: mockTest.id,
    examId: mockTest.examId,
    testSeriesId: mockTest.testSeriesId,
    accessType: mockTest.accessType,
  });
  const instructions = mockTest.instructions ?? mockTest.testSeries?.instructions ?? mockTest.exam.instructions ?? null;
  const open = availability === "AVAILABLE" || availability === "LIVE_NOW";
  const retakeBlocked = mockTest.attemptPolicy === "SINGLE_ATTEMPT" && latestSubmittedAttempt !== null;
  const questionCount = mockTest._count.questions;

  let action: React.ReactNode;
  if (inProgressAttempt && access.allowed) {
    action = <StartMockForm mockTestId={mockTest.id} label="Resume Test" />;
  } else if (!access.allowed) {
    const canBuy = access.status !== "NOT_AVAILABLE" && !access.purchasesPaused;
    action = canBuy ? (
      <Button asChild size="lg" className="w-full">
        <Link href={paywallHref(access)}>
          <Lock className="h-4 w-4" aria-hidden /> {access.status === "EXPIRED" ? "Renew Access" : "Unlock this Test"}
        </Link>
      </Button>
    ) : (
      <Button size="lg" disabled className="w-full">
        <Lock className="h-4 w-4" aria-hidden /> Not available
      </Button>
    );
  } else if (availability === "UPCOMING") {
    action = (
      <Button size="lg" disabled className="w-full">
        <Lock className="h-4 w-4" aria-hidden /> Opens {mockTest.availableFrom ? formatIst(mockTest.availableFrom) : "soon"}
      </Button>
    );
  } else if (availability === "CLOSED") {
    action = (
      <Button size="lg" disabled className="w-full">
        Window closed — new attempts are no longer accepted
      </Button>
    );
  } else if (retakeBlocked) {
    action = (
      <Button size="lg" disabled className="w-full">
        Already attempted — retakes are not allowed
      </Button>
    );
  } else if (questionCount === 0) {
    action = (
      <Button size="lg" disabled className="w-full">
        No questions published yet
      </Button>
    );
  } else {
    action = <StartMockForm mockTestId={mockTest.id} label={latestSubmittedAttempt ? "Practice Again" : "Start Test"} />;
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <BackButton href="/student/test-series" />
      <div>
        {mockTest.testSeries ? (
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">{mockTest.testSeries.name}</p>
        ) : null}
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{mockTest.title}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {mockTest.exam.name} · {COVERAGE_LABELS[mockTest.coverageType]}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          <Badge variant={availability === "LIVE_NOW" ? "warning" : availability === "AVAILABLE" ? "success" : availability === "UPCOMING" ? "info" : "neutral"}>
            {availability === "AVAILABLE" ? "Available Now" : AVAILABILITY_LABELS[availability]}
          </Badge>
          {!access.allowed ? (
            <Badge variant="warning">
              <Lock className="h-3 w-3" aria-hidden /> {access.status === "EXPIRED" ? "Access expired" : "Premium"}
            </Badge>
          ) : null}
          {inProgressAttempt ? <Badge variant="warning">In progress</Badge> : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Test Overview</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <ListChecks className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Questions</p>
              <p className="font-semibold text-[var(--color-foreground)]">{questionCount}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <Clock className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Duration</p>
              <p className="font-semibold text-[var(--color-foreground)]">{mockTest.durationMinutes} min</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Negative Marking</p>
              <p className="font-semibold text-[var(--color-foreground)]">
                {mockTest.negativeMarking > 0 ? `-${mockTest.negativeMarking} per wrong` : "None"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {mockTest.availableFrom || mockTest.availableUntil ? (
        <Card>
          <CardContent className="flex flex-col gap-1 pt-5 text-sm text-[var(--color-muted-foreground)]">
            {mockTest.availableFrom ? (
              <p className="flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4" aria-hidden /> {mockTest.availableUntil ? "Opens" : "Released"}: {formatIst(mockTest.availableFrom)}
              </p>
            ) : null}
            {mockTest.availableUntil ? (
              <p className="flex items-center gap-1.5">
                <CalendarClock className="h-4 w-4" aria-hidden /> {availability === "CLOSED" ? "Closed" : "Closes"}: {formatIst(mockTest.availableUntil)}
              </p>
            ) : null}
            {mockTest.availableUntil && open ? (
              <p>Your attempt ends when the window closes, even if your full duration hasn&apos;t elapsed.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

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
            <li>The timer starts when you press Start Test and cannot be paused.</li>
            <li>The test auto-submits when time runs out.</li>
            <li>You can navigate between questions and change answers until you submit.</li>
            {mockTest.negativeMarking > 0 ? <li>Each wrong answer deducts {mockTest.negativeMarking} mark(s).</li> : null}
            {mockTest.attemptPolicy === "SINGLE_ATTEMPT" ? <li>Only one attempt is allowed for this test.</li> : null}
          </ul>
        </CardContent>
      </Card>

      {action}

      {latestSubmittedAttempt ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/student/attempt/${latestSubmittedAttempt.id}/result`}>
              {isMockResultReleased(mockTest) ? "View Last Result" : "Result (pending release)"}
            </Link>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
