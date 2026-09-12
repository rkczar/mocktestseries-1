import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ExamForm } from "./exam-form";
import { ActiveToggle } from "./active-toggle";

export const metadata = { title: "Manage Exams — Mock Test Series.in Admin" };

export default async function ExamsPage() {
  const exams = await prisma.exam.findMany({ orderBy: [{ order: "asc" }, { createdAt: "desc" }] });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Manage Exams</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Full exam configuration (subjects, syllabus, negative marking, instructions) arrives in a later
          phase. This minimal version powers the Homepage&apos;s Featured Exam / Upcoming Exams selectors.
        </p>
      </div>

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
                  <th className="py-2 pr-4">Active</th>
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
                        href={`/admin/exams/previous-year-papers?examId=${exam.id}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        PYPs
                      </Link>
                      {" · "}
                      <Link
                        href={`/admin/exams/test-series?examId=${exam.id}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        Test Series
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4">
                      <ActiveToggle examId={exam.id} isActive={exam.isActive} />
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
