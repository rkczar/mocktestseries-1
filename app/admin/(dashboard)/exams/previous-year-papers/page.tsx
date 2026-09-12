import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PaperForm } from "./paper-form";
import { PaperToggle } from "./paper-toggle";

export const metadata = { title: "Previous Year Papers — Mock Test Series.in Admin" };

export default async function PreviousYearPapersPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string }>;
}) {
  const { examId } = await searchParams;
  const [exams, papers] = await Promise.all([
    prisma.exam.findMany({ orderBy: { name: "asc" } }),
    prisma.previousYearPaper.findMany({
      include: { exam: true },
      orderBy: [{ year: "desc" }],
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Previous Year Papers</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Powers the Homepage&apos;s Previous Year Papers promotion. Full paper-to-question linkage arrives with the
          Question Bank in a later phase.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Add Paper</CardTitle></CardHeader>
        <CardContent>
          <PaperForm exams={exams} defaultExamId={examId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Papers</CardTitle>
          <CardDescription>{papers.length} paper{papers.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {papers.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No papers yet.</p>
          ) : (
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Title</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Year</th>
                  <th className="py-2 pr-4">Active</th>
                </tr>
              </thead>
              <tbody>
                {papers.map((paper) => (
                  <tr key={paper.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{paper.title}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{paper.exam.name}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{paper.year}</td>
                    <td className="py-2.5 pr-4"><PaperToggle paperId={paper.id} isActive={paper.isActive} /></td>
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
