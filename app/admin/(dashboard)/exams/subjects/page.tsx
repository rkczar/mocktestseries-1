import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ExamFilterSelect } from "@/components/admin/exam-filter-select";
import { SubjectForm } from "./subject-form";
import { SubjectDeleteButton } from "./subject-delete-button";
import { SubjectEditDialog } from "./subject-edit-dialog";

export const metadata = { title: "Subjects — Mock Test Series.in Admin" };

export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId: requestedExamId } = await searchParams;
  const exams = await prisma.exam.findMany({ orderBy: { name: "asc" } });

  // Exam-wise by default (Section 10): an explicit examId wins, "" means the
  // admin chose "All Exams", and no param at all defaults to the first Exam
  // rather than silently mixing every Exam's Subjects together.
  const showAll = requestedExamId === "";
  const examId = requestedExamId !== undefined ? requestedExamId : (exams[0]?.id ?? "");

  const subjects = await prisma.subject.findMany({
    where: showAll ? {} : { examId: examId || undefined },
    orderBy: [{ examId: "asc" }, { order: "asc" }, { name: "asc" }],
    include: { exam: true, _count: { select: { topics: true, questions: true } } },
  });

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
          <CardTitle>Exam</CardTitle>
          <CardDescription>Subjects are managed one Exam at a time. Choose &quot;All Exams&quot; only for an overview.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label>Select Exam</Label>
            <ExamFilterSelect options={exams} paramName="examId" value={examId} allowAll allLabel="All Exams (overview)" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add Subject</CardTitle>
        </CardHeader>
        <CardContent>
          <SubjectForm exams={exams} defaultExamId={examId || undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{showAll ? "All Subjects" : `${exams.find((e) => e.id === examId)?.name ?? "Exam"}'s Subjects`}</CardTitle>
          <CardDescription>
            {subjects.length} subject{subjects.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {subjects.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No subjects yet.</p>
          ) : (
            <table className="w-full min-w-[620px] text-left text-sm">
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
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      <Link
                        href={`/admin/exams?tab=subjects&examId=${s.examId}&subjectId=${s.id}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        {s._count.topics} — View Topics
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{s._count.questions}</td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <SubjectEditDialog id={s.id} name={s.name} order={s.order} />
                        <SubjectDeleteButton subjectId={s.id} />
                      </div>
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
