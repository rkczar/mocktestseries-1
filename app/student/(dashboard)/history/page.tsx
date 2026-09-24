import { AttemptSourceType } from "@prisma/client";
import Link from "next/link";
import { History as HistoryIcon } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getStudentAttemptHistory } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { isMockResultReleased } from "@/lib/mock-test-schedule";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/student/back-button";
import { cn } from "@/lib/utils";

export const metadata = { title: "History — Mock Test Series.in" };

const SOURCE_LABEL: Record<string, string> = {
  MOCK_TEST: "Mock Test",
  PREVIOUS_YEAR_PAPER: "Previous Year Paper",
  CUSTOM_MODULE: "Custom Module",
  SUBJECT_TEST: "Subject Test",
};

const TYPE_FILTERS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Mock Tests", value: "MOCK_TEST" },
  { label: "Subject Tests", value: "SUBJECT_TEST" },
  { label: "Previous Year Papers", value: "PREVIOUS_YEAR_PAPER" },
  { label: "Custom Modules", value: "CUSTOM_MODULE" },
];

export default async function StudentHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  const student = await requireStudent();
  const sourceType = TYPE_FILTERS.some((f) => f.value === type) ? (type as AttemptSourceType) : undefined;
  const attempts = await getStudentAttemptHistory(student.id, { sourceType });

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">History</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Every test you have started or completed.</p>
      </div>

      <nav className="flex flex-wrap gap-2" aria-label="Filter by type">
        {TYPE_FILTERS.map((f) => (
          <Link
            key={f.label}
            href={f.value ? `/student/history?type=${f.value}` : "/student/history"}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              (sourceType ?? "") === f.value
                ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface)]"
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>Attempts</CardTitle>
          <CardDescription>{attempts.length} total</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {attempts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <HistoryIcon className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
              <p className="text-sm text-[var(--color-muted-foreground)]">No test history yet.</p>
            </div>
          ) : (
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Test</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Exam</th>
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Score</th>
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => {
                  const name = attemptTitle(a);
                  const minutesTaken = a.timeTakenSeconds ? Math.round(a.timeTakenSeconds / 60) : null;
                  return (
                    <tr key={a.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2.5 pr-4 text-[var(--color-foreground)]">{name}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant="neutral">{SOURCE_LABEL[a.sourceType]}</Badge>
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.exam.name}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{a.startedAt.toLocaleDateString()}</td>
                      <td className="py-2.5 pr-4 text-[var(--color-foreground)]">
                        {a.status !== "SUBMITTED" ? "—" : a.mockTest && !isMockResultReleased(a.mockTest) ? "Result pending" : `${a.score?.toFixed(1)} / ${a.maxScore}`}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{minutesTaken ? `${minutesTaken} min` : "—"}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={a.status === "IN_PROGRESS" ? "warning" : a.status === "SUBMITTED" ? "success" : "neutral"}>
                          {a.status === "IN_PROGRESS" ? "In Progress" : a.status === "SUBMITTED" ? "Completed" : "Abandoned"}
                        </Badge>
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex justify-end gap-2">
                          {a.status === "IN_PROGRESS" ? (
                            <Button asChild size="sm">
                              <Link href={`/student/attempt/${a.id}/run`}>Continue</Link>
                            </Button>
                          ) : a.status === "SUBMITTED" ? (
                            <>
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/student/attempt/${a.id}/result`}>Result</Link>
                              </Button>
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/student/attempt/${a.id}/review`}>Review</Link>
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
