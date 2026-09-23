import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MockTestForm } from "./mock-test-form";
import { MockTestStatusSelect } from "./status-select";

export const metadata = { title: "Mock Tests — Mock Test Series.in Admin" };

export default async function MockTestsPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; testSeriesId?: string }>;
}) {
  const { examId, testSeriesId } = await searchParams;
  const [exams, testSeries, mockTests] = await Promise.all([
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.testSeries.findMany({ select: { id: true, name: true, examId: true } }),
    prisma.mockTest.findMany({
      orderBy: { createdAt: "desc" },
      include: { exam: true, _count: { select: { questions: true, testAttempts: true } } },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Mock Tests</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Powers Student → Test Series. Add questions and publish from a mock test&apos;s detail page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Mock Test</CardTitle>
        </CardHeader>
        <CardContent>
          {exams.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Create an exam first (Admin → Exams).</p>
          ) : (
            <MockTestForm exams={exams} testSeries={testSeries} defaultExamId={examId} defaultTestSeriesId={testSeriesId} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Mock Tests</CardTitle>
          <CardDescription>{mockTests.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {mockTests.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No mock tests yet.</p>
          ) : (
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4">Attempts</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {mockTests.map((mt) => (
                  <tr key={mt.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{mt.title}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{mt.exam.name}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={mt._count.questions > 0 ? "success" : "warning"}>{mt._count.questions}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{mt._count.testAttempts}</td>
                    <td className="py-2.5 pr-4">
                      <MockTestStatusSelect mockTestId={mt.id} status={mt.status} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/tests/mock/${mt.id}`} className="text-[var(--color-primary)] hover:underline">
                        Manage Questions
                      </Link>
                    </td>
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
