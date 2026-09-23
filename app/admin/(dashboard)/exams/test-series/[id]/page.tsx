import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TestResourceManager } from "@/components/admin/test-resource-manager";
import { deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { formatIst } from "@/lib/ist-time";
import { SeriesStatusSelect } from "../series-status-select";

export const metadata = { title: "Test Series — Mock Test Series.in Admin" };

export default async function TestSeriesDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const series = await prisma.testSeries.findUnique({
    where: { id },
    include: {
      exam: true,
      mockTests: {
        orderBy: { order: "asc" },
        include: { _count: { select: { questions: true, testAttempts: true } } },
      },
      resources: { where: { type: "OMR_TEMPLATE" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!series) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{series.name}</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {series.exam.name} · {series.mockTests.length} tests
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SeriesStatusSelect id={series.id} status={series.status} />
          <Link
            href={`/admin/tests/scheduled?testSeriesId=${series.id}`}
            className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-foreground)] hover:bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)]"
          >
            Schedule
          </Link>
          <Link
            href={`/admin/tests/mock?examId=${series.examId}&testSeriesId=${series.id}`}
            className="rounded-[var(--radius-button)] border border-[var(--color-primary)] bg-[var(--color-primary)]/10 px-3 py-1.5 text-sm text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20"
          >
            Create Mock Test
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Mock Tests</CardTitle>
          <CardDescription>Ordered by Test Number. Manage questions, schedule, and resources from each test.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {series.mockTests.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No tests yet — create one above or import a schedule from the Schedule Manager.
            </p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">No.</th>
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Available From</th>
                  <th className="py-2 pr-4">Attempt Policy</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {series.mockTests.map((mt) => (
                  <tr key={mt.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{mt.order}</td>
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{mt.title}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={mt._count.questions > 0 ? "success" : "warning"}>{mt._count.questions}</Badge>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={deriveMockTestAvailability(mt) === "AVAILABLE" ? "success" : "info"}>
                        {mt.status === "PUBLISHED" ? deriveMockTestAvailability(mt) : mt.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {mt.availableFrom ? formatIst(mt.availableFrom) : "Immediate"}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {mt.attemptPolicy === "SINGLE_ATTEMPT" ? "Single Attempt" : "Multiple Practice"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/tests/mock/${mt.id}`} className="text-[var(--color-primary)] hover:underline">
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OMR Templates</CardTitle>
          <CardDescription>
            Assigned to this series — shown on every test in it and the Student Dashboard. Leave a template unscoped
            (upload from a series-less context) to make it available sitewide instead.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TestResourceManager resources={series.resources} allowedTypes={["OMR_TEMPLATE"]} scope={{ testSeriesId: series.id }} />
        </CardContent>
      </Card>
    </div>
  );
}
