import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatIst } from "@/lib/ist-time";
import { AVAILABILITY_LABELS, deriveMockTestAvailability, isMockResultReleased, mockResultReleaseInstant } from "@/lib/mock-test-schedule";
import { getLiveCbtMonitor, type LiveCandidateStatus } from "@/lib/live-cbt";

export const metadata = { title: "Live CBT Monitor — Mock Test Series.in Admin" };
export const dynamic = "force-dynamic";

const STATUS: Record<LiveCandidateStatus, { label: string; variant: "neutral" | "primary" | "success" | "error" | "warning" | "info" }> = {
  NOT_STARTED: { label: "Not started", variant: "neutral" },
  ABSENT: { label: "Absent", variant: "error" },
  IN_PROGRESS: { label: "In progress", variant: "warning" },
  SUBMITTED: { label: "Submitted", variant: "success" },
  AUTO_SUBMITTED: { label: "Auto-submitted (time up)", variant: "success" },
  FINALIZED_AFTER_WINDOW: { label: "Auto-submitted (browser closed)", variant: "info" },
};

const time = (d: Date | null) => (d ? formatIst(d).replace(/^\d{2} \w{3} \d{4}, /, "") : "—");

/**
 * Admin → Tests → Mock Test → Live CBT Monitor (read-only). Who enrolled,
 * who is writing now, who submitted (by themselves, at time-up, or finalized
 * by the window-end sweep after closing the browser), who was absent, and —
 * once the result is released — scores and ranks. Reload the page to refresh.
 * Changes nothing.
 */
export default async function LiveCbtMonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mockTest = await prisma.mockTest.findUnique({
    where: { id },
    select: { id: true, title: true, status: true, availableFrom: true, availableUntil: true, resultReleaseMode: true, resultReleaseAt: true, durationMinutes: true, exam: { select: { name: true } } },
  });
  if (!mockTest) notFound();
  const now = new Date();
  const { summary, rows: monitorRows } = await getLiveCbtMonitor(id, now);
  const state = deriveMockTestAvailability(mockTest, now);
  const releaseAt = mockResultReleaseInstant(mockTest);
  const released = isMockResultReleased(mockTest, now);
  // Scores and ranks follow the test's result release, here too: until then the
  // table shows status only, ordered by status and name (a rank order would leak them).
  const rows = released ? monitorRows : [...monitorRows].sort((x, y) => x.status.localeCompare(y.status) || x.name.localeCompare(y.name));
  const held = "Held";

  const tiles: [string, number, string][] = [
    ["Enrolled", summary.enrolled, "Students holding an enrollment"],
    ["Started", summary.started, "Opened the test inside the window"],
    ["In progress", summary.inProgress, "Writing the test right now"],
    [summary.absent > 0 || state === "CLOSED" ? "Absent" : "Not started", state === "CLOSED" ? summary.absent : summary.notStarted, state === "CLOSED" ? "Enrolled, never started" : "Enrolled, not started yet"],
    ["Submitted by student", summary.submittedByStudent, "Pressed Submit before time up"],
    ["Auto-submitted (time up)", summary.autoSubmitted, "The player submitted at the deadline"],
    ["Auto-submitted (browser closed)", summary.finalizedAfterWindow, "Finalized by the system after the window closed"],
    ["Completed", summary.completed, "All submitted live attempts"],
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-[var(--color-muted-foreground)]">
            <Link href={`/admin/tests/mock/${id}#live`} className="underline">← Back to the Mock Test</Link>
          </p>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Live CBT Monitor</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {mockTest.title} · {mockTest.exam.name} · {mockTest.durationMinutes} min
          </p>
          <p className="mt-1 text-sm text-[var(--color-foreground)]">
            Window: <strong>{mockTest.availableFrom ? formatIst(mockTest.availableFrom) : "—"}</strong> →{" "}
            <strong>{mockTest.availableUntil ? formatIst(mockTest.availableUntil) : "—"}</strong>{" "}
            <Badge variant={state === "LIVE_NOW" ? "warning" : state === "CLOSED" ? "neutral" : "info"}>{AVAILABILITY_LABELS[state]}</Badge>
          </p>
          <p className="text-sm text-[var(--color-foreground)]">
            Results: <strong>{released ? "Released to students" : `Held until ${releaseAt ? formatIst(releaseAt) : "—"}`}</strong>
            {released && summary.ranked > 0 ? ` · ${summary.ranked} ranked` : ""}
          </p>
        </div>
        <div className="text-right text-xs text-[var(--color-muted-foreground)]">
          <p>As of {time(now)}</p>
          <Link href={`/admin/tests/mock/${id}/live-monitor`} className="mt-1 inline-block rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)]">
            Refresh
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="live-monitor-summary">
        {tiles.map(([label, value, hint]) => (
          <Card key={label}>
            <CardContent className="pt-5">
              <p className="text-2xl font-semibold text-[var(--color-foreground)]">{value.toLocaleString("en-IN")}</p>
              <p className="text-sm font-medium text-[var(--color-foreground)]">{label}</p>
              <p className="text-xs text-[var(--color-muted-foreground)]">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {summary.startedWithoutEnrollment > 0 || summary.laterPracticeAttempts > 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {summary.startedWithoutEnrollment > 0 ? `${summary.startedWithoutEnrollment} started without an enrollment (enrollment was off for them). ` : ""}
          {summary.laterPracticeAttempts > 0 ? `${summary.laterPracticeAttempts} later attempt(s) started after the window — not shown as the live attempt.` : ""}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Candidates</CardTitle>
          <CardDescription>
            Each student&apos;s live attempt (the first one started inside the window). Score and rank appear here when the result is released
            to students; ranks follow the leaderboard rules.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No enrolled students or attempts yet.</p>
          ) : (
            <table className="w-full min-w-[980px] text-left text-sm" data-testid="live-monitor-table">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-3">Rank</th>
                  <th className="py-2 pr-3">Student</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Enrolled</th>
                  <th className="py-2 pr-3">Started</th>
                  <th className="py-2 pr-3">Submitted</th>
                  <th className="py-2 pr-3">Score</th>
                  <th className="py-2 pr-3">Correct / Wrong / Unanswered</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.studentDbId} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2 pr-3 font-medium">{released ? (r.rank ?? "—") : r.attemptId ? held : "—"}</td>
                    <td className="py-2 pr-3">
                      <Link href={`/admin/students/${r.studentDbId}`} className="font-medium text-[var(--color-foreground)] underline-offset-2 hover:underline">
                        {r.name}
                      </Link>
                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        {r.studentCode}
                        {r.contact ? ` · ${r.contact}` : ""}
                      </p>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={STATUS[r.status].variant}>{STATUS[r.status].label}</Badge>
                      {r.laterAttempts > 0 ? <p className="text-xs text-[var(--color-muted-foreground)]">+{r.laterAttempts} later practice</p> : null}
                    </td>
                    <td className="py-2 pr-3 text-xs">{r.enrolledAt ? time(r.enrolledAt) : "Not enrolled"}</td>
                    <td className="py-2 pr-3 text-xs">{time(r.startedAt)}</td>
                    <td className="py-2 pr-3 text-xs">{time(r.submittedAt)}</td>
                    <td className="py-2 pr-3">{!released && r.attemptId ? held : r.score !== null ? `${r.score} / ${r.maxScore ?? "—"}` : "—"}</td>
                    <td className="py-2 pr-3 text-xs">{!released && r.attemptId ? held : r.correct !== null ? `${r.correct} / ${r.incorrect} / ${r.unanswered}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
