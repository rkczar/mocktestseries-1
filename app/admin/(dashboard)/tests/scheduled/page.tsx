import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { ScheduleTable } from "./schedule-table";
import { ScheduleImportWorkspace } from "./schedule-import-workspace";

export const metadata = { title: "Schedule Manager — Mock Test Series.in Admin" };

export default async function ScheduledTestsPage({
  searchParams,
}: {
  searchParams: Promise<{ testSeriesId?: string }>;
}) {
  const { testSeriesId } = await searchParams;

  const testSeriesList = await prisma.testSeries.findMany({
    include: { exam: true },
    orderBy: { createdAt: "desc" },
  });

  const selectedSeries = testSeriesId ? testSeriesList.find((s) => s.id === testSeriesId) : testSeriesList[0];

  const mockTests = selectedSeries
    ? await prisma.mockTest.findMany({
        where: { testSeriesId: selectedSeries.id },
        orderBy: { order: "asc" },
        select: { id: true, title: true, order: true, status: true, availableFrom: true, durationMinutes: true },
      })
    : [];

  const rows = mockTests.map((mt) => ({
    ...mt,
    availability: deriveMockTestAvailability(mt),
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Schedule Manager</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Set when each Mock Test in a Test Series unlocks for students. Once available, a test stays available
          indefinitely — there is no closing time.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Test Series</CardTitle>
          <CardDescription>Select a series to manage its schedule.</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>

      {selectedSeries ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Schedule Table — {selectedSeries.name}</CardTitle>
              <CardDescription>{rows.length} tests</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <ScheduleTable rows={rows} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Bulk Schedule Upload</CardTitle>
              <CardDescription>
                Upload a CSV/XLSX to set schedules for many tests at once, or create new tests by Test Number.
                Nothing is written until you review the preview and confirm.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ScheduleImportWorkspace testSeriesId={selectedSeries.id} examId={selectedSeries.examId} />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
