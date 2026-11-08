import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireTeacherPage } from "@/lib/teacher/page";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const weekAgo = () => new Date(Date.now() - 7 * 86400_000);

export default async function TeacherDashboard() {
  const scope = await requireTeacherPage();
  const [exams, drafts, open, decided] = await Promise.all([
    prisma.exam.findMany({
      where: { id: { in: scope.examIds } },
      orderBy: { order: "asc" },
      select: { id: true, name: true, _count: { select: { questions: true, mockTests: true } } },
    }),
    prisma.question.count({ where: { examId: { in: scope.examIds }, status: "DRAFT" } }),
    prisma.teacherContentRequest.count({ where: { teacherId: scope.teacherId, status: "OPEN" } }),
    prisma.teacherContentRequest.count({ where: { teacherId: scope.teacherId, status: { in: ["APPROVED", "REJECTED"] }, decidedAt: { gte: weekAgo() } } }),
  ]);
  return (
    <>
      <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Welcome, {scope.name}</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card><CardContent className="py-4"><p className="text-sm text-[var(--color-muted-foreground)]">Draft questions</p><p className="text-2xl font-semibold">{drafts}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-sm text-[var(--color-muted-foreground)]">My requests waiting</p><p className="text-2xl font-semibold">{open}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-sm text-[var(--color-muted-foreground)]">Decided in the last 7 days</p><p className="text-2xl font-semibold">{decided}</p></CardContent></Card>
      </div>
      <Card>
        <CardHeader><CardTitle>My exams</CardTitle></CardHeader>
        <CardContent>
          {exams.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No exam is assigned to you yet. Ask the Master Admin to assign one.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {exams.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2 last:border-0">
                  <span className="font-medium">{e.name}</span>
                  <span className="flex gap-3">
                    <Link className="underline" href={`/teacher/questions?exam=${e.id}`}>{e._count.questions} questions</Link>
                    <Link className="underline" href={`/teacher/tests?exam=${e.id}`}>{e._count.mockTests} mock tests</Link>
                    <Link className="underline" href={`/teacher/questions/new?exam=${e.id}`}>Add question</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        New questions are saved as Draft. Publishing, changes to published questions, restoring and permanent deletion are approved by the Master Admin.
      </p>
    </>
  );
}
