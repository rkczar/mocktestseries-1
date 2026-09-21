import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSavedQuestionsAdminOverview } from "@/lib/admin-saved-questions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SavedQuestionsFilters } from "./filters";

export const metadata = { title: "Saved Questions — Mock Test Series.in Admin" };

export default async function AdminSavedQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; subjectId?: string; search?: string }>;
}) {
  const { examId, subjectId, search } = await searchParams;

  const [exams, subjects, overview] = await Promise.all([
    prisma.exam.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    examId ? prisma.subject.findMany({ where: { examId }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : Promise.resolve([]),
    getSavedQuestionsAdminOverview({ examId, subjectId, search }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Saved Questions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Read-only visibility into questions students have bookmarked — using the existing SavedQuestion data, never a
          separate copy of it. Admin cannot modify a student&apos;s personal saved state from here.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Total Saves" value={overview.totalSaves} />
        <StatTile label="Distinct Questions" value={overview.distinctQuestions} />
        <StatTile label="Distinct Students" value={overview.distinctStudents} />
      </div>

      <SavedQuestionsFilters exams={exams} subjects={subjects} examId={examId} subjectId={subjectId} search={search} />

      <Card>
        <CardHeader>
          <CardTitle>Most Saved</CardTitle>
          <CardDescription>{overview.rows.length} shown, ranked by save count</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {overview.rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">No saved questions match this filter.</p>
          ) : (
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Subject</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Save Count</th>
                  <th className="py-2 pr-4">Last Saved</th>
                </tr>
              </thead>
              <tbody>
                {overview.rows.map((r) => (
                  <tr key={r.questionId} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="max-w-xs py-2.5 pr-4">
                      <Link href={`/admin/questions/add?id=${r.questionId}`} className="text-[var(--color-primary)] hover:underline">
                        {r.code}
                      </Link>
                      <p className="text-xs text-[var(--color-muted-foreground)]">{r.text.slice(0, 70)}</p>
                    </td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{r.examName}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{r.subjectName}</td>
                    <td className="py-2.5 pr-4">
                      <Badge variant={r.status === "PUBLISHED" ? "success" : r.status === "DRAFT" ? "warning" : "neutral"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-foreground)]">{r.saveCount}</td>
                    <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{r.lastSavedAt.toLocaleString()}</td>
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

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-1 py-4 text-center">
        <p className="text-lg font-semibold text-[var(--color-foreground)]">{value}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
      </CardContent>
    </Card>
  );
}
