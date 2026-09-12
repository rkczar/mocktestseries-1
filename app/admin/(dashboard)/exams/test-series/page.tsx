import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SeriesForm } from "./series-form";
import { SeriesToggle } from "./series-toggle";

export const metadata = { title: "Test Series — Mock Test Series.in Admin" };

export default async function TestSeriesPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;
  const [exams, seriesList] = await Promise.all([
    prisma.exam.findMany({ orderBy: { name: "asc" } }),
    prisma.testSeries.findMany({ include: { exam: true }, orderBy: { createdAt: "desc" } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Test Series</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Powers the Homepage&apos;s Test Series section and Mock Test promotion. The full Test Builder/engine
          arrives in a later phase.
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
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Tests</th>
                  <th className="py-2 pr-4">Active</th>
                </tr>
              </thead>
              <tbody>
                {seriesList.map((series) => (
                  <tr key={series.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{series.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{series.exam.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{series.testCount}</td>
                    <td className="py-2.5 pr-4"><SeriesToggle id={series.id} isActive={series.isActive} /></td>
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
