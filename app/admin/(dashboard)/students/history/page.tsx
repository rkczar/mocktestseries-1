import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Test History — Mock Test Series.in Admin" };

const SOURCE_LABEL = {
  MOCK_TEST: "Mock Test",
  PREVIOUS_YEAR_PAPER: "Previous Year Paper",
  CUSTOM_MODULE: "Custom Module",
  SUBJECT_TEST: "Subject Test",
  GRAND_TEST: "Grand Test",
  LIVE_TEST: "Live Test",
} as const;

export default async function StudentsHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;

  const [exams, attempts] = await Promise.all([
    prisma.exam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.testAttempt.findMany({
      where: { examId: examId || undefined },
      orderBy: { startedAt: "desc" },
      take: 200,
      include: { student: true, exam: true, mockTest: true, customModule: true, previousYearPaper: true, grandTest: true, liveTest: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Test History</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Every attempt across every student.</p>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form className="flex flex-wrap gap-3">
            <select name="examId" defaultValue={examId ?? ""} className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm">
              <option value="">All exams</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <button type="submit" className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 text-sm">
              Filter
            </button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attempts</CardTitle>
          <CardDescription>{attempts.length} shown (max 200)</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {attempts.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No attempts yet.</p>
          ) : (
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Student</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Score</th>
                  <th className="py-2 pr-4">Date</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4">
                      <Link href={`/admin/students/${a.studentId}`} className="text-[var(--color-primary)] hover:underline">
                        {a.student.name}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="neutral">{SOURCE_LABEL[a.sourceType]}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                      {a.mockTest?.title ?? a.customModule?.title ?? a.previousYearPaper?.title ?? a.grandTest?.title ?? a.liveTest?.title ?? "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.exam.name}</td>
                    <td className="py-2.5 pr-4">{a.score !== null ? `${a.score} / ${a.maxScore}` : "In progress"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.startedAt.toLocaleDateString()}</td>
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
