import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExamForm } from "./exam-form";
import { ActiveToggle } from "./active-toggle";
import { EditExamDialog } from "./edit-exam-dialog";
import { DeleteExamDialog } from "./delete-exam-dialog";
import { resolveDefaultExam } from "@/lib/default-enrollment";

export async function AllExamsPanel() {
  const [exams, defaultExam] = await Promise.all([
    prisma.exam.findMany({ orderBy: [{ order: "asc" }, { createdAt: "desc" }] }),
    resolveDefaultExam(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>New Exam</CardTitle>
        </CardHeader>
        <CardContent>
          <ExamForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Exams</CardTitle>
          <CardDescription>{exams.length} exam{exams.length === 1 ? "" : "s"}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {exams.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No exams yet. Create one above.
            </p>
          ) : (
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Code</th>
                  <th className="py-2 pr-4">Year</th>
                  <th className="py-2 pr-4">Papers / Series</th>
                  <th className="py-2 pr-4">Public Page</th>
                  <th className="py-2 pr-4">Active</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {exams.map((exam) => (
                  <tr key={exam.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{exam.name}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="primary">{exam.code}</Badge>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{exam.year ?? "—"}</td>
                    <td className="py-2.5 pr-4">
                      <Link
                        href={`/admin/exams?tab=pyp&examId=${exam.id}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        PYPs
                      </Link>
                      {" · "}
                      <Link
                        href={`/admin/exams?tab=test-series&examId=${exam.id}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        Test Series
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4">
                      {exam.publicPageEnabled && exam.publicSlug ? (
                        <Link href={`/exams/${exam.publicSlug}`} target="_blank" className="text-[var(--color-primary)] hover:underline">
                          <Badge variant="success">Live</Badge>
                        </Link>
                      ) : (
                        <Badge variant="neutral">Off</Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <ActiveToggle examId={exam.id} isActive={exam.isActive} />
                    </td>
                    <td className="py-2.5 pr-4">
                      <div className="flex items-center justify-end gap-1">
                        <EditExamDialog exam={{ ...exam, isDefaultEnrollment: exam.id === defaultExam?.id }} />
                        <DeleteExamDialog examId={exam.id} examName={exam.name} />
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
