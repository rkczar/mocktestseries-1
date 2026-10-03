import { redirect } from "next/navigation";
import { AlertTriangle, ClipboardList, Clock, ListChecks } from "lucide-react";
import { requireStudentOrLogin } from "@/lib/student-session";
import { startOrExplain } from "@/lib/payments/paywall";
import { previewFormalTestStart, startPreviousYearPaperAttempt } from "@/lib/test-attempt";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AccessibilityControls } from "@/components/student/accessibility-controls";
import { BackButton } from "@/components/student/back-button";
import { PreTestSetup } from "@/components/student/pre-test-setup";

export const metadata = { title: "Start Test — Mock Test Series.in" };

/**
 * The single start/resume destination for Mock Tests and Previous Year
 * Papers: every public SEO page (/exams/[slug]/...) links its "Attempt Paper"
 * / "Take Mock Test" CTA here, and the in-app Start buttons redirect here,
 * instead of duplicating the authenticated start flow. Because this route
 * lives under /student, the proxy already gates it — an anonymous visitor is
 * bounced to /login?callbackUrl=/student/attempt/resume?paper=<id>, and
 * app/login/actions.ts#safeCallback only honors callbackUrl values that start
 * with "/student", so this never becomes an open redirect.
 *
 * Nothing is written on this GET. previewFormalTestStart runs the start's own
 * gates (entitlement → resume → availability/policy → Platform Controls):
 *  - a running attempt is resumed as-is (no setup: its configuration is frozen);
 *  - a new Mock Test goes to its details page, which hosts the Pre-Test Setup
 *    next to the overview, instructions and purchase options;
 *  - a new Previous Year Paper shows the Pre-Test Setup here;
 *  - a formal test that allows no choices starts exactly as before.
 * Refusals (payment, pause, unavailable) use the same startOrExplain paths.
 */
export default async function ResumeAttemptPage({
  searchParams,
}: {
  searchParams: Promise<{ paper?: string; mockTest?: string }>;
}) {
  const { paper, mockTest } = await searchParams;
  const student = await requireStudentOrLogin();
  const context = { route: "/student/attempt/resume", studentId: student.id };

  if (mockTest) {
    const preview = await startOrExplain(() => previewFormalTestStart(student.id, { kind: "MOCK_TEST", id: mockTest }), {
      ...context,
      contentId: mockTest,
    });
    if (preview.resume) {
      redirect(preview.resume.entryMode === "OFFLINE_OMR_ENTRY" ? `/student/attempt/${preview.resume.id}/omr-entry` : `/student/attempt/${preview.resume.id}`);
    }
    redirect(`/student/test-series/${encodeURIComponent(mockTest)}`);
  }

  if (!paper) redirect("/student/dashboard");

  const preview = await startOrExplain(() => previewFormalTestStart(student.id, { kind: "PREVIOUS_YEAR_PAPER", id: paper }), {
    ...context,
    contentId: paper,
  });
  if (preview.resume) redirect(`/student/attempt/${preview.resume.id}`);

  const { summary } = preview;
  if (!summary.configurable) {
    const attempt = await startOrExplain(() => startPreviousYearPaperAttempt(student.id, paper), { ...context, contentId: paper });
    redirect(`/student/attempt/${attempt.id}`);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-6 px-4 py-10 sm:px-6">
      <div className="flex items-center justify-between gap-2">
        <BackButton href="/student/dashboard" />
        <AccessibilityControls />
      </div>
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-[var(--color-foreground)]">{summary.title}</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{summary.examName}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4" aria-hidden /> Test Overview
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <ListChecks className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Questions</p>
              <p className="font-semibold text-[var(--color-foreground)]">{summary.questionCount}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <Clock className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Standard time</p>
              <p className="font-semibold text-[var(--color-foreground)]">{summary.standardMinutes} min</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
            <AlertTriangle className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />
            <div>
              <p className="text-xs text-[var(--color-muted-foreground)]">Negative Marking</p>
              <p className="font-semibold text-[var(--color-foreground)]">
                {summary.negativeMarking > 0 ? `-${summary.negativeMarking} per wrong` : "None"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {summary.instructions ? (
        <Card>
          <CardHeader>
            <CardTitle>Instructions</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-wrap text-sm text-[var(--color-muted-foreground)]">{summary.instructions}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5 text-sm text-[var(--color-muted-foreground)]">
          <ul className="list-disc space-y-1 pl-5">
            <li>The timer starts when you press Start Test and cannot be paused. The test auto-submits when time runs out.</li>
            <li>You can move between questions and change answers until you submit, except answers you have checked.</li>
            {summary.negativeMarking > 0 ? <li>Each wrong answer deducts {summary.negativeMarking} mark(s).</li> : null}
          </ul>
        </CardContent>
      </Card>

      <PreTestSetup kind={summary.kind} testId={summary.id} questionCount={summary.questionCount} standardMinutes={summary.standardMinutes} />
    </div>
  );
}
