import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getTeacher } from "@/lib/teacher/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { teacherMobileStatus } from "@/lib/teacher/auth";
import { MobileVerify } from "./mobile-verify";
import { getTeacherExamPages } from "@/lib/teacher/exam-pages";

const weekAgo = () => new Date(Date.now() - 7 * 86400_000);

export default async function TeacherDashboard() {
  // Signed out: the layout shows the Teacher Login instead of this page.
  const scope = await getTeacher();
  if (!scope) return null;
  const [exams, drafts, open, decided, mobile] = await Promise.all([
    prisma.exam.findMany({
      where: { id: { in: scope.examIds } },
      orderBy: { order: "asc" },
      select: { id: true, name: true, _count: { select: { questions: true, mockTests: true } } },
    }),
    prisma.question.count({ where: { examId: { in: scope.examIds }, status: "DRAFT" } }),
    prisma.teacherContentRequest.count({ where: { teacherId: scope.teacherId, status: "OPEN" } }),
    prisma.teacherContentRequest.count({ where: { teacherId: scope.teacherId, status: { in: ["APPROVED", "REJECTED"] }, decidedAt: { gte: weekAgo() } } }),
    teacherMobileStatus(scope.teacherId),
  ]);
  // Exams come from the teacher's live assignments only (scope.examIds); a revoked exam disappears here.
  const examPages = await Promise.all(exams.map(async (exam) => ({ exam, links: await getTeacherExamPages(exam.id) })));
  return (
    <>
      <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Welcome, {scope.name}</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card><CardContent className="py-4"><p className="text-sm text-[var(--color-muted-foreground)]">Draft questions</p><p className="text-2xl font-semibold">{drafts}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-sm text-[var(--color-muted-foreground)]">My requests waiting</p><p className="text-2xl font-semibold">{open}</p></CardContent></Card>
        <Card><CardContent className="py-4"><p className="text-sm text-[var(--color-muted-foreground)]">Decided in the last 7 days</p><p className="text-2xl font-semibold">{decided}</p></CardContent></Card>
      </div>
      {mobile.masked && !mobile.verified ? (
        <Card>
          <CardHeader><CardTitle>Login with OTP</CardTitle></CardHeader>
          <CardContent><MobileVerify masked={mobile.masked} /></CardContent>
        </Card>
      ) : null}
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
      <Card>
        <CardHeader><CardTitle>Access Your Exam Pages</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-4">
          {examPages.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Pages of your assigned exams appear here.</p>
          ) : (
            examPages.map(({ exam, links }) => (
              <div key={exam.id} className="flex flex-col gap-2">
                <p className="text-sm font-medium">{exam.name}</p>
                <ul className="grid grid-cols-1 gap-1.5 text-sm sm:grid-cols-2">
                  {links.map((l) => (
                    <li key={l.label} className="flex items-center justify-between gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-1.5">
                      {l.href ? (
                        <a className="underline" href={l.href} target="_blank" rel="noopener noreferrer">{l.label}</a>
                      ) : (
                        <span className="text-[var(--color-muted-foreground)]">{l.label}</span>
                      )}
                      <span className="text-xs text-[var(--color-muted-foreground)]">{l.status === "LIVE" ? "Live" : l.status === "OFF" ? "Off" : "Not published"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
          <p className="text-xs text-[var(--color-muted-foreground)]">Links only. Pages are published by the Master Admin.</p>
        </CardContent>
      </Card>
      <p className="text-xs text-[var(--color-muted-foreground)]">
        New questions are saved as Draft. Publishing, changes to published questions, restoring and permanent deletion are approved by the Master Admin.
      </p>
    </>
  );
}
