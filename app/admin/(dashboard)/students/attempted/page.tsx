import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Attempted Questions — Mock Test Series.in Admin" };

export default async function AttemptedQuestionsPage() {
  const grouped = await prisma.answer.groupBy({
    by: ["questionId"],
    where: { status: { in: ["ANSWERED", "ANSWERED_AND_MARKED"] } },
    _count: { _all: true },
  });

  const top = grouped.sort((a, b) => b._count._all - a._count._all).slice(0, 50);
  const questions = await prisma.question.findMany({
    where: { id: { in: top.map((t) => t.questionId) } },
    include: { exam: true, subject: true },
  });
  const questionById = new Map(questions.map((q) => [q.id, q]));

  const correctCounts = await prisma.answer.groupBy({
    by: ["questionId"],
    where: { questionId: { in: top.map((t) => t.questionId) }, isCorrect: true },
    _count: { _all: true },
  });
  const correctByQuestion = new Map(correctCounts.map((c) => [c.questionId, c._count._all]));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Attempted Questions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Most-attempted questions across all students, computed from real answer data.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top Questions by Attempt Count</CardTitle>
          <CardDescription>{top.length} shown</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {top.length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
              No answers recorded yet.
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Question</th>
                  <th className="py-2 pr-4">Exam / Subject</th>
                  <th className="py-2 pr-4">Attempts</th>
                  <th className="py-2 pr-4">Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {top.map((t) => {
                  const q = questionById.get(t.questionId);
                  if (!q) return null;
                  const correct = correctByQuestion.get(t.questionId) ?? 0;
                  const accuracy = Math.round((correct / t._count._all) * 100);
                  return (
                    <tr key={t.questionId} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="max-w-sm py-2.5 pr-4 text-[var(--color-foreground)]">
                        {q.text.slice(0, 90)}
                        <span className="ml-2 font-mono text-xs text-[var(--color-muted-foreground)]">{q.code}</span>
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">
                        {q.exam.name} · {q.subject.name}
                      </td>
                      <td className="py-2.5 pr-4">{t._count._all}</td>
                      <td className="py-2.5 pr-4">
                        <Badge variant={accuracy >= 60 ? "success" : accuracy >= 35 ? "warning" : "error"}>{accuracy}%</Badge>
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
