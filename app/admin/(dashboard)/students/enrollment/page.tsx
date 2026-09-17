import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const metadata = { title: "Enrollment — Mock Test Series.in Admin" };

export default async function EnrollmentPage() {
  const exams = await prisma.exam.findMany({
    orderBy: { order: "asc" },
    select: { id: true, name: true, isActive: true, _count: { select: { enrollments: true } } },
  });

  const recentEnrollments = await prisma.studentExamEnrollment.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { student: { select: { name: true, studentId: true } }, exam: { select: { name: true } } },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Enrollment</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Students who&apos;ve added an exam to &quot;My Exams&quot;. Access isn&apos;t gated on enrollment today —
          this is a focused-list/analytics dimension, extensible for paid-access gating later.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By Exam</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-4">Exam</th>
                <th className="py-2 pr-4">Enrolled Students</th>
              </tr>
            </thead>
            <tbody>
              {exams.map((e) => (
                <tr key={e.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{e.name}</td>
                  <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{e._count.enrollments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Enrollments</CardTitle>
          <CardDescription>{recentEnrollments.length} shown</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {recentEnrollments.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No enrollments yet.</p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Student</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Enrolled</th>
                </tr>
              </thead>
              <tbody>
                {recentEnrollments.map((en) => (
                  <tr key={en.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                      {en.student.name} <span className="text-xs text-[var(--color-muted-foreground)]">({en.student.studentId})</span>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{en.exam.name}</td>
                    <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">{en.createdAt.toLocaleDateString()}</td>
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
