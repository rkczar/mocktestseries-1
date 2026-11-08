import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireTeacherPage } from "@/lib/teacher/page";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Mock Tests — Teacher Portal" };

export default async function TeacherTests({ searchParams }: { searchParams: Promise<{ exam?: string }> }) {
  const scope = await requireTeacherPage();
  const { exam } = await searchParams;
  const examIds = exam && scope.examIds.includes(exam) ? [exam] : scope.examIds;
  const tests = await prisma.mockTest.findMany({
    where: { examId: { in: examIds }, status: { not: "ARCHIVED" } },
    orderBy: [{ examId: "asc" }, { order: "asc" }, { createdAt: "desc" }],
    take: 300,
    select: { id: true, title: true, status: true, enrollmentEnabled: true, exam: { select: { name: true } }, _count: { select: { questions: true } } },
  });
  return (
    <>
      <h1 className="text-xl font-semibold">Mock Tests</h1>
      <p className="text-sm text-[var(--color-muted-foreground)]">
        You can unpublish a question from a Mock Test straight away (students starting the test afterwards won&rsquo;t get it). For a Live CBT, ask the Master Admin with an unpublish request.
      </p>
      <Card>
        <CardContent className="overflow-x-auto py-3">
          {tests.length === 0 ? <p className="text-sm text-[var(--color-muted-foreground)]">No mock tests in your exams.</p> : (
            <table className="w-full text-sm">
              <thead className="text-left text-[var(--color-muted-foreground)]"><tr><th className="py-2 pr-3">Test</th><th className="pr-3">Exam</th><th className="pr-3">Questions</th><th>Status</th></tr></thead>
              <tbody>
                {tests.map((t) => (
                  <tr key={t.id} className="border-t border-[var(--color-border)]">
                    <td className="py-2 pr-3"><Link className="underline" href={`/teacher/tests/${t.id}`}>{t.title}</Link> {t.enrollmentEnabled ? <Badge>Live CBT</Badge> : null}</td>
                    <td className="pr-3">{t.exam.name}</td>
                    <td className="pr-3">{t._count.questions}</td>
                    <td><Badge variant={t.status === "PUBLISHED" ? "success" : "neutral"}>{t.status.toLowerCase()}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
