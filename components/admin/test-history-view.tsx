import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StudentTestHistory } from "@/components/admin/student-test-history";

/**
 * Admin → Students → Test History (every attempt, newest 200, exam filter).
 * Shared with the Teacher Portal, which passes `scopeExamIds`: the exam list
 * and the attempts are limited to those exams and an outside `examId` is ignored.
 */
export async function TestHistoryView({ examId, basePath, studentHref, scopeExamIds }: { examId?: string; basePath: string; studentHref: (studentDbId: string) => string; scopeExamIds?: string[] }) {
  const allowed = (id: string) => !scopeExamIds || scopeExamIds.includes(id);
  const examIds = examId && allowed(examId) ? [examId] : scopeExamIds;
  const [exams, attempts] = await Promise.all([
    prisma.exam.findMany({ where: scopeExamIds ? { id: { in: scopeExamIds } } : {}, orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.testAttempt.findMany({
      where: examIds ? { examId: { in: examIds } } : {},
      orderBy: { startedAt: "desc" },
      take: 200,
      include: {
        student: { select: { id: true, name: true, studentId: true } },
        exam: { select: { name: true } },
        mockTest: { select: { title: true } },
        customModule: { select: { title: true } },
        previousYearPaper: { select: { title: true } },
        grandTest: { select: { title: true } },
        liveTest: { select: { title: true } },
      },
    }),
  ]);
  return (
    <>
      <Card>
        <CardContent className="pt-5">
          <form className="flex flex-wrap gap-3" action={basePath}>
            <select name="examId" defaultValue={examId && allowed(examId) ? examId : ""} aria-label="Exam" className="h-9 rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm">
              <option value="">{scopeExamIds ? "All my exams" : "All exams"}</option>
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
          <StudentTestHistory attempts={attempts} studentHref={studentHref} />
        </CardContent>
      </Card>
    </>
  );
}
