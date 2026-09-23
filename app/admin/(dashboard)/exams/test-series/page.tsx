import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { SeriesForm } from "./series-form";
import { SeriesToggle } from "./series-toggle";
import { SeriesStatusSelect } from "./series-status-select";

export const metadata = { title: "Test Series — Mock Test Series.in Admin" };

export default async function TestSeriesPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;
  const [exams, seriesList] = await Promise.all([
    prisma.exam.findMany({ orderBy: { name: "asc" } }),
    prisma.testSeries.findMany({
      include: {
        exam: true,
        mockTests: { select: { status: true, availableFrom: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Test Series Control Center</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Manage scheduled Test Series — their Mock Tests, release schedule, and resources. Open a series to manage
          its tests.
        </p>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          Pricing (FREE/PAID, MRP, sale, access duration) is set in one place:{" "}
          <Link href="/admin/payments?tab=products" className="text-[var(--color-primary)] hover:underline">
            Payments → Products &amp; Pricing
          </Link>
          .
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Add Test Series</CardTitle></CardHeader>
        <CardContent>
          <SeriesForm exams={exams} defaultExamId={examId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Test Series</CardTitle>
          <CardDescription>{seriesList.length} series</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {seriesList.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No test series yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Published / Available / Upcoming</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Active</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {seriesList.map((series) => {
                  const published = series.mockTests.filter((t) => t.status === "PUBLISHED").length;
                  const available = series.mockTests.filter(
                    (t) => t.status === "PUBLISHED" && deriveMockTestAvailability(t) === "AVAILABLE"
                  ).length;
                  const upcoming = published - available;
                  return (
                    <tr key={series.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">
                        <Link href={`/admin/exams/test-series/${series.id}`} className="hover:underline">
                          {series.name}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{series.exam.name}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                        {published} / {available} / {upcoming}
                      </td>
                      <td className="py-2.5 pr-4">
                        <SeriesStatusSelect id={series.id} status={series.status} />
                      </td>
                      <td className="py-2.5 pr-4"><SeriesToggle id={series.id} isActive={series.isActive} /></td>
                      <td className="py-2.5 pr-4">
                        <Link href={`/admin/exams/test-series/${series.id}`} className="text-[var(--color-primary)] hover:underline">
                          Manage
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
    </div>
  );
}
