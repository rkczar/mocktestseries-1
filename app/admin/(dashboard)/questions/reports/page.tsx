import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ReportStatusSelect } from "./report-status-select";
import { ReportStatusFilter } from "./status-filter";

export const metadata = { title: "Question Reports — Mock Test Series.in Admin" };

export default async function QuestionReportsPage({ searchParams }: { searchParams?: Promise<{ status?: string }> }) {
  const params = (await searchParams) ?? {};
  const filterStatus = params.status === "OPEN" || params.status === "REVIEWED" || params.status === "RESOLVED" ? params.status : undefined;

  const [counts, reports] = await Promise.all([
    prisma.reportedQuestion.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.reportedQuestion.findMany({
      where: { status: filterStatus },
      orderBy: { createdAt: "desc" },
      include: { question: true, student: true },
      take: 200,
    }),
  ]);
  const countByStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const totalCount = counts.reduce((sum, c) => sum + c._count._all, 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Question Reports</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Issues flagged by students from the test-taking screen (&quot;Report Question&quot;).
        </p>
      </div>

      <ReportStatusFilter countByStatus={countByStatus} totalCount={totalCount} />

      <Card>
        <CardHeader>
          <CardTitle>Reports</CardTitle>
          <CardDescription>{reports.length} shown</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {reports.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No reports yet.</p>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Reported By</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Message</th>
                  <th className="py-2 pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="max-w-xs py-2.5 pr-4">
                      <Link href={`/admin/questions/add?id=${r.questionId}`} className="text-[var(--color-primary)] hover:underline">
                        {r.question.code}
                      </Link>
                      <p className="text-xs text-[var(--color-muted-foreground)]">{r.question.text.slice(0, 70)}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                      {r.student.name}
                      <br />
                      <span className="text-xs">{r.student.studentId}</span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge variant="warning">{r.reportType.replace(/_/g, " ")}</Badge>
                    </td>
                    <td className="max-w-xs py-2.5 pr-4 text-[var(--color-muted-foreground)]">{r.message || "—"}</td>
                    <td className="py-2.5 pr-4">
                      <ReportStatusSelect reportId={r.id} status={r.status} />
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
