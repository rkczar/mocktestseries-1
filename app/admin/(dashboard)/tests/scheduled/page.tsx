import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatIst } from "@/lib/ist-time";
import {
  AVAILABILITY_MODE_LABELS,
  RESULT_RELEASE_LABELS,
  deriveAvailabilityMode,
  deriveMockTestAvailability,
  mockResultReleaseInstant,
} from "@/lib/mock-test-schedule";
import { COVERAGE_LABELS } from "@/components/admin/mock-test-table";
import { ScheduleTable } from "./schedule-table";
import { ScheduleImportWorkspace } from "./schedule-import-workspace";

export const metadata = { title: "Scheduled Tests — Mock Test Series.in Admin" };

type Bucket = "UPCOMING" | "LIVE_NOW" | "RELEASED" | "CLOSED";
const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: "UPCOMING", label: "Upcoming", hint: "Published, release/start time not reached — locked for students." },
  { key: "LIVE_NOW", label: "Live Now", hint: "Inside a Fixed Window right now." },
  { key: "RELEASED", label: "Released", hint: "Scheduled release has passed — available with no end." },
  { key: "CLOSED", label: "Closed", hint: "Fixed Window ended — no new attempts." },
];

/**
 * Scheduled Tests is a management VIEW of Mock Tests, not another test
 * entity: every Mock Test that has a release time or a fixed window,
 * bucketed by state derived from server time. Editing happens in the one
 * Mock Test editor; bulk scheduling per Test Series stays below.
 */
export default async function ScheduledTestsPage({ searchParams }: { searchParams: Promise<{ testSeriesId?: string }> }) {
  const { testSeriesId } = await searchParams;
  const [canManage, scheduled, testSeriesList] = await Promise.all([
    hasPermission(PERMISSIONS.TEST_SERIES_MANAGE),
    prisma.mockTest.findMany({
      where: { OR: [{ availableFrom: { not: null } }, { availableUntil: { not: null } }] },
      orderBy: [{ availableFrom: "asc" }, { order: "asc" }],
      select: {
        id: true,
        order: true,
        title: true,
        status: true,
        accessType: true,
        availableFrom: true,
        availableUntil: true,
        resultReleaseMode: true,
        resultReleaseAt: true,
        targetQuestionCount: true,
        exam: { select: { name: true } },
        testSeries: { select: { id: true, name: true } },
        _count: { select: { questions: true } },
      },
    }),
    prisma.testSeries.findMany({ include: { exam: true }, orderBy: { createdAt: "desc" } }),
  ]);

  const now = new Date();
  const bucketOf = (m: (typeof scheduled)[number]): Bucket => {
    const s = deriveMockTestAvailability(m, now);
    return s === "AVAILABLE" ? "RELEASED" : s;
  };
  const published = scheduled.filter((m) => m.status === "PUBLISHED");
  const drafts = scheduled.filter((m) => m.status !== "PUBLISHED");

  const selectedSeries = testSeriesId ? testSeriesList.find((s) => s.id === testSeriesId) : testSeriesList[0];
  const seriesTests = selectedSeries
    ? await prisma.mockTest.findMany({
        where: { testSeriesId: selectedSeries.id },
        orderBy: { order: "asc" },
        select: {
          id: true,
          title: true,
          order: true,
          status: true,
          availableFrom: true,
          availableUntil: true,
          durationMinutes: true,
          accessType: true,
          coverageType: true,
          _count: { select: { questions: true } },
        },
      })
    : [];
  const seriesRows = seriesTests.map(({ _count, coverageType, ...mt }) => ({
    ...mt,
    availability: deriveMockTestAvailability(mt, now),
    questionCount: _count.questions,
    coverageLabel: COVERAGE_LABELS[coverageType],
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Scheduled Tests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Mock Tests with a Scheduled Release or a Fixed Window, by live state (server time, IST). Change a test&apos;s schedule in its editor
          (Step 4).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {BUCKETS.map((b) => (
          <a key={b.key} href={`#bucket-${b.key}`} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-center hover:border-[var(--color-primary)]">
            <p className="text-xl font-semibold text-[var(--color-foreground)]">{published.filter((m) => bucketOf(m) === b.key).length}</p>
            <p className="text-[11px] text-[var(--color-muted-foreground)]">{b.label}</p>
          </a>
        ))}
        <a href="#bucket-DRAFT" className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-center hover:border-[var(--color-primary)]">
          <p className="text-xl font-semibold text-[var(--color-foreground)]">{drafts.length}</p>
          <p className="text-[11px] text-[var(--color-muted-foreground)]">Scheduled but not published</p>
        </a>
      </div>

      {[...BUCKETS, { key: "DRAFT" as const, label: "Scheduled but not published", hint: "Draft/Archived — invisible to students whatever the schedule." }].map(
        (b) => {
          const rows = b.key === "DRAFT" ? drafts : published.filter((m) => bucketOf(m) === b.key);
          return (
            <Card key={b.key} id={`bucket-${b.key}`} className="scroll-mt-20">
              <CardHeader>
                <CardTitle>
                  {b.label} ({rows.length})
                </CardTitle>
                <CardDescription>{b.hint}</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                {rows.length === 0 ? (
                  <p className="py-2 text-sm text-[var(--color-muted-foreground)]">None.</p>
                ) : (
                  <table className="w-full min-w-[1080px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                        <th className="py-2 pr-3">Mock Test</th>
                        <th className="py-2 pr-3">Test Series</th>
                        <th className="py-2 pr-3">Exam</th>
                        <th className="py-2 pr-3">Questions</th>
                        <th className="py-2 pr-3">Availability Mode</th>
                        <th className="py-2 pr-3">Release / Start</th>
                        <th className="py-2 pr-3">End</th>
                        <th className="py-2 pr-3">Result Release</th>
                        <th className="py-2 pr-3">Access</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 pr-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((m) => {
                        const release = mockResultReleaseInstant(m);
                        return (
                          <tr key={m.id} className="border-b border-[var(--color-border)] align-top last:border-0">
                            <td className="py-2.5 pr-3 font-medium text-[var(--color-foreground)]">
                              <span className="text-xs text-[var(--color-muted-foreground)]">#{m.order} </span>
                              {m.title}
                            </td>
                            <td className="py-2.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{m.testSeries?.name ?? "Standalone"}</td>
                            <td className="py-2.5 pr-3 text-xs text-[var(--color-muted-foreground)]">{m.exam.name}</td>
                            <td className="py-2.5 pr-3">
                              {m._count.questions === 0 ? (
                                <Badge variant="warning">Needs Questions</Badge>
                              ) : (
                                <Badge variant="success">
                                  {m._count.questions}
                                  {m.targetQuestionCount !== null ? ` / ${m.targetQuestionCount}` : ""}
                                </Badge>
                              )}
                            </td>
                            <td className="py-2.5 pr-3 text-xs">{AVAILABILITY_MODE_LABELS[deriveAvailabilityMode(m)]}</td>
                            <td className="py-2.5 pr-3 text-xs">{m.availableFrom ? formatIst(m.availableFrom) : "—"}</td>
                            <td className="py-2.5 pr-3 text-xs">{m.availableUntil ? formatIst(m.availableUntil) : "—"}</td>
                            <td className="py-2.5 pr-3 text-xs">
                              {RESULT_RELEASE_LABELS[m.resultReleaseMode]}
                              {release ? <span className="block text-[var(--color-muted-foreground)]">{formatIst(release)}</span> : null}
                            </td>
                            <td className="py-2.5 pr-3">
                              <Badge variant={m.accessType === "FREE" ? "primary" : "neutral"}>{m.accessType}</Badge>
                            </td>
                            <td className="py-2.5 pr-3">
                              <Badge variant={m.status === "PUBLISHED" ? "success" : "warning"}>{m.status}</Badge>
                            </td>
                            <td className="py-2.5 pr-3 text-xs">
                              <Link href={`/admin/tests/mock/${m.id}#schedule`} className="text-[var(--color-primary)] hover:underline">
                                Edit
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          );
        }
      )}

      <Card>
        <CardHeader>
          <CardTitle>Schedule a whole Test Series</CardTitle>
          <CardDescription>Quick release-date editing per series, plus CSV/XLSX bulk scheduling. Nothing is written until you confirm the preview.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {testSeriesList.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No test series yet.{" "}
              <Link href="/admin/exams/test-series" className="text-[var(--color-primary)] hover:underline">
                Create one first
              </Link>
              .
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {testSeriesList.map((series) => (
                <Link
                  key={series.id}
                  href={`/admin/tests/scheduled?testSeriesId=${series.id}`}
                  className={`rounded-[var(--radius-button)] border px-3 py-1.5 text-sm ${
                    selectedSeries?.id === series.id
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                      : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  }`}
                >
                  {series.name} · {series.exam.name}
                </Link>
              ))}
            </div>
          )}
          {selectedSeries ? (
            <>
              <div className="overflow-x-auto">
                <ScheduleTable rows={seriesRows} readOnly={!canManage} />
              </div>
              {canManage ? <ScheduleImportWorkspace testSeriesId={selectedSeries.id} examId={selectedSeries.examId} /> : null}
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
