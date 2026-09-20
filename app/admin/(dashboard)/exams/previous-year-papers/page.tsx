import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ExamFilterSelect } from "@/components/admin/exam-filter-select";
import { PaperForm } from "./paper-form";
import { PaperToggle } from "./paper-toggle";
import { PaperEditDialog } from "./paper-edit-dialog";
import { PaperDeleteDialog } from "./paper-delete-dialog";

export const metadata = { title: "Previous Year Papers — Mock Test Series.in Admin" };

export default async function PreviousYearPapersPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId: requestedExamId } = await searchParams;
  const exams = await prisma.exam.findMany({ orderBy: { name: "asc" } });

  // Exam-wise by default (Section 14): an explicit examId wins, "" means the
  // admin chose "All Exams", no param at all defaults to the first Exam.
  const showAll = requestedExamId === "";
  const examId = requestedExamId !== undefined ? requestedExamId : (exams[0]?.id ?? "");

  const papers = await prisma.previousYearPaper.findMany({
    where: showAll ? {} : { examId: examId || undefined },
    include: { exam: true, _count: { select: { questions: true } } },
    orderBy: [{ examId: "asc" }, { year: "desc" }, { order: "asc" }],
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Previous Year Papers</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Powers the Homepage&apos;s Previous Year Papers promotion and links directly to Question Bank questions.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Exam</CardTitle>
          <CardDescription>Papers are managed one Exam at a time. Choose &quot;All Exams&quot; only for an overview.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label>Select Exam</Label>
            <ExamFilterSelect options={exams} paramName="examId" value={examId} allowAll allLabel="All Exams (overview)" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Add Paper</CardTitle></CardHeader>
        <CardContent>
          <PaperForm exams={exams} defaultExamId={examId || undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{showAll ? "All Papers" : `${exams.find((e) => e.id === examId)?.name ?? "Exam"}'s Papers`}</CardTitle>
          <CardDescription>{papers.length} paper{papers.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {papers.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No papers yet.</p>
          ) : (
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Year</th>
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Questions</th>
                  <th className="py-2 pr-4">Active</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => (
                  <tr key={paper.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">
                      <Link href={`/admin/exams/previous-year-papers/${paper.id}`} className="text-[var(--color-primary)] hover:underline">
                        {paper.title}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{paper.exam.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{paper.year}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{paper.paperCode ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{paper._count.questions}</td>
                    <td className="py-2.5 pr-4"><PaperToggle paperId={paper.id} isActive={paper.isActive} /></td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <PaperEditDialog id={paper.id} title={paper.title} year={paper.year} paperCode={paper.paperCode} order={paper.order} />
                        <PaperDeleteDialog paperId={paper.id} paperTitle={paper.title} />
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
