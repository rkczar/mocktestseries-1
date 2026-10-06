import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CalendarClock, Clock, ListChecks, Lock } from "lucide-react";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getMockTestDetailForStudent } from "@/lib/student-data";
import { AVAILABILITY_LABELS, isMockResultReleased, mockResultReleaseInstant } from "@/lib/mock-test-schedule";
import { countMockTestEnrollments, isEnrolledInMockTest } from "@/lib/live-cbt";
import { effectiveEnrollmentCloseAt } from "@/lib/live-cbt-core";
import { LiveCbtPanel } from "./live-cbt-panel";
import { serverNow } from "@/lib/attempt-timing";
import { loadAccessContext, evaluateContentAccess, type AccessProductRef } from "@/lib/payments/access";
import { computeProductPrice } from "@/lib/payments/pricing";
import { formatInr } from "@/lib/payments/money";
import { prisma } from "@/lib/prisma";
import { isCheckoutGatewayReady } from "@/lib/payments/student-access";
import { formatIst } from "@/lib/ist-time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BackButton } from "@/components/student/back-button";
import { StartMockForm } from "./start-mock-form";
import { PreTestSetup } from "@/components/student/pre-test-setup";
import { studentConfigAllowed } from "@/lib/test-attempt";
import { AttemptSourceType } from "@prisma/client";
import { accessLockLabel } from "@/lib/payments/access-labels";

export const metadata = { title: "Mock Test — Mock Test Series.in" };

const COVERAGE_LABELS = { FULL_SYLLABUS: "Full Syllabus", PARTIAL_SYLLABUS: "Partial Syllabus", SUBJECT_WISE: "Subject Mock" } as const;

/**
 * Every product that can unlock this mock, priced from its Product row right
 * now (this mock alone first, then Complete Series / Exam Access).
 */
async function purchaseOptions(refs: AccessProductRef[], renew: boolean) {
  if (refs.length === 0) return [];
  const rows = await prisma.product.findMany({ where: { id: { in: refs.map((r) => r.id) } } });
  const rank = { MOCK_TEST: 0, TEST_SERIES: 1, EXAM_ACCESS: 2 } as Record<string, number>;
  return rows
    .map((p) => {
      const what = p.productType === "MOCK_TEST" ? "this Mock" : p.productType === "TEST_SERIES" ? "Complete Series" : p.productType === "EXAM_ACCESS" ? "Full Exam Access" : p.name;
      const label = renew ? `Renew ${what}` : p.productType === "MOCK_TEST" ? "Buy this Mock" : `Unlock ${what}`;
      return { id: p.id, code: p.code, name: p.name, label, individual: p.productType === "MOCK_TEST", pricePaise: computeProductPrice(p).pricePaise, rank: rank[p.productType] ?? 3 };
    })
    .sort((a, b) => a.rank - b.rank);
}

/**
 * Mock Test Details / Instructions — the step between a Mock Test card and
 * the attempt. No TestAttempt exists until the student presses Start here,
 * so the timer never runs while they read. Availability, entitlement and the
 * attempt policy are shown for guidance only; startMockTestAttempt enforces
 * all of them again when Start is pressed.
 */
export default async function MockTestDetailsPage({ params }: { params: Promise<{ mockTestId: string }> }) {
  const { mockTestId } = await params;
  const student = await requireStudentOrLogin();
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

  // The same branch order as `action` below: the Pre-Test Setup is offered
  // only when nothing earlier (resume, paywall, window, retake, empty) wins.
  const showSetup =
    !inProgressAttempt &&
    access.allowed &&
    availability !== "UPCOMING" &&
    availability !== "CLOSED" &&
    !retakeBlocked &&
    questionCount > 0 &&
    studentConfigAllowed(AttemptSourceType.MOCK_TEST, mockTest);
  const testRules = (
    <>
      {mockTest.negativeMarking > 0 ? <li>Each wrong answer deducts {mockTest.negativeMarking} mark(s).</li> : null}
      {mockTest.attemptPolicy === "SINGLE_ATTEMPT" ? <li>Only one attempt is allowed for this test.</li> : null}
    </>
  );

  // Live CBT (enrollment-enabled mock): enrollment state + public count.
  const live = mockTest.enrollmentEnabled
    ? await Promise.all([
        isEnrolledInMockTest(student.id, mockTest.id),
        mockTest.showEnrolledCount ? countMockTestEnrollments(mockTest.id) : Promise.resolve(null),
      ])
    : null;
  const releaseInstant = mockResultReleaseInstant(mockTest);
  const enrollCloseAt = effectiveEnrollmentCloseAt(mockTest);

  let action: React.ReactNode;
  if (inProgressAttempt && access.allowed) {
    action = <StartMockForm mockTestId={mockTest.id} label="Resume Test" />;
  } else if (!access.allowed) {
    const canBuy = access.status !== "NOT_AVAILABLE" && !access.purchasesPaused && (await isCheckoutGatewayReady());
    const options = canBuy ? await purchaseOptions(access.products, access.status === "EXPIRED") : [];
    action = options.length ? (
      <div className="flex flex-col gap-2" data-testid="purchase-options">
        {options.map((o, i) => (
          <Button key={o.id} asChild size="lg" variant={i === 0 ? "primary" : "outline"} className="h-auto w-full whitespace-normal py-2">
            <Link href={`/student/checkout/${encodeURIComponent(o.code)}`} data-product-code={o.code}>
              <Lock className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                {o.label} — {formatInr(o.pricePaise)}
                {o.individual ? null : <span className="block text-xs font-normal opacity-80">{o.name}</span>}
              </span>
            </Link>
          </Button>
        ))}
        {options.length > 1 ? (
          <p className="text-center text-xs text-[var(--color-muted-foreground)]">Buy just this mock, or unlock every paid mock in the series.</p>
        ) : null}
      </div>
    ) : (
      <Button size="lg" disabled className="w-full">
        <Lock className="h-4 w-4" aria-hidden /> Not available
      </Button>
    );
  } else if (live) {
    action = (
      <LiveCbtPanel
        mockTestId={mockTest.id}
        serverNow={serverNow().getTime()}
        startsAt={mockTest.availableFrom?.getTime() ?? null}
        endsAt={mockTest.availableUntil?.getTime() ?? null}
        enrolled={live[0]}
        enrollmentOpensAt={mockTest.enrollmentOpensAt?.getTime() ?? null}
        enrollmentClosesAt={enrollCloseAt?.getTime() ?? null}
        submitted={latestSubmittedAttempt ? { attemptId: latestSubmittedAttempt.id, resultReleaseAt: releaseInstant?.getTime() ?? null } : null}
        labels={{
          startsAt: mockTest.availableFrom ? formatIst(mockTest.availableFrom) : null,
          endsAt: mockTest.availableUntil ? formatIst(mockTest.availableUntil) : null,
          opensAt: mockTest.enrollmentOpensAt ? formatIst(mockTest.enrollmentOpensAt) : null,
          resultReleaseAt: releaseInstant ? formatIst(releaseInstant) : null,
        }}
        canStart={questionCount > 0 && !retakeBlocked}
      />
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
  } else if (showSetup) {
    // Pre-Test Setup (answer review, then duration for Exam Mode) before the
    // attempt exists; the server re-runs every gate above when it is submitted.
    // Its notes follow the chosen mode, so the static timer rules below are
    // shown only for a mock without a setup.
    action = (
      <PreTestSetup
        kind="MOCK_TEST"
        testId={mockTest.id}
        questionCount={questionCount}
        standardMinutes={mockTest.durationMinutes}
        submitLabel={latestSubmittedAttempt ? "Practice Again" : "Start Test"}
        notes={testRules}
      />
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
              <Lock className="h-3 w-3" aria-hidden /> {accessLockLabel(access.status, { individual: access.products.some((p) => p.productType === "MOCK_TEST") })}
            </Badge>
          ) : null}
          {access.status === "ACTIVE_SUBSCRIPTION" && access.products.length ? (
            <Badge variant="success" data-testid="access-source">
              {access.products.some((p) => p.productType === "MOCK_TEST") ? "Purchased · Access active" : `Included in ${access.products[0].name}`}
            </Badge>
          ) : null}
          {inProgressAttempt ? <Badge variant="warning">In progress</Badge> : null}
          {live ? (
            <Badge variant="error" data-testid="live-cbt-badge">
              LIVE CBT
            </Badge>
          ) : null}
        </div>
      </div>

      {live ? (
        <Card data-testid="live-cbt-info">
          <CardContent className="grid grid-cols-2 gap-3 pt-5 text-sm sm:grid-cols-3">
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Starts</p>
              <p className="font-semibold text-[var(--color-foreground)]">{mockTest.availableFrom ? formatIst(mockTest.availableFrom) : "Open now"}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Ends</p>
              <p className="font-semibold text-[var(--color-foreground)]">{mockTest.availableUntil ? formatIst(mockTest.availableUntil) : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Duration</p>
              <p className="font-semibold text-[var(--color-foreground)]">{mockTest.durationMinutes} min</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Questions</p>
              <p className="font-semibold text-[var(--color-foreground)]">{questionCount}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Marks</p>
              <p className="font-semibold text-[var(--color-foreground)]">{questionCount}</p>
            </div>
            {live[1] !== null ? (
              <div>
                <p className="text-xs text-[var(--color-muted-foreground)]">Enrolled</p>
                <p className="font-semibold text-[var(--color-foreground)]" data-testid="enrolled-count">
                  {live[1].toLocaleString("en-IN")} student{live[1] === 1 ? "" : "s"} enrolled
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

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

      {showSetup ? null : (
        <Card>
          <CardContent className="pt-5 text-sm text-[var(--color-muted-foreground)]">
            <ul className="list-disc space-y-1 pl-5">
              <li>The timer starts when you press Start Test and cannot be paused.</li>
              <li>The test auto-submits when time runs out.</li>
              <li>You can navigate between questions and change answers until you submit.</li>
              {testRules}
            </ul>
          </CardContent>
        </Card>
      )}

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
