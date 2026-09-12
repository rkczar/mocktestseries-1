import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SubjectForm } from "./subject-form";
import { SubjectDeleteButton } from "./subject-delete-button";

export const metadata = { title: "Subjects — Mock Test Series.in Admin" };

export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;
  const [exams, subjects] = await Promise.all([
    prisma.exam.findMany({ orderBy: { name: "asc" } }),
    prisma.subject.findMany({
      where: { examId: examId || undefined },
      orderBy: [{ examId: "asc" }, { order: "asc" }, { name: "asc" }],
      include: { exam: true, _count: { select: { topics: true, questions: true } } },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Subjects</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Subjects belong to an Exam and are the top level of the question categorization used by the Question Bank,
          Custom Module rule-based selection, and Exam detail pages.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add Subject</CardTitle>
        </CardHeader>
        <CardContent>
          <SubjectForm exams={exams} defaultExamId={examId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Subjects</CardTitle>
          <CardDescription>
            {subjects.length} subject{subjects.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {subjects.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No subjects yet.</p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Topics</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {subjects.map((s) => (
                  <tr key={s.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{s.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{s.exam.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{s._count.topics}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{s._count.questions}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <SubjectDeleteButton subjectId={s.id} />
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
