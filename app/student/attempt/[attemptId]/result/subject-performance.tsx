import { BarChart3, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { SubjectRow, TopicRow } from "./page";

export function SubjectPerformance({
  performance,
}: {
  performance: { subjects: SubjectRow[]; strongTopics: TopicRow[]; needsImprovementTopics: TopicRow[] };
}) {
  if (performance.subjects.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" aria-hidden /> Subject-wise Performance
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                <th className="py-2 pr-3">Subject</th>
                <th className="py-2 pr-3">Attempted</th>
                <th className="py-2 pr-3">Correct</th>
                <th className="py-2 pr-3">Incorrect</th>
                <th className="py-2 pr-3">Marks</th>
                <th className="py-2 pr-3">Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {performance.subjects.map((row) => (
                <tr key={row.subjectName} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="py-2 pr-3 font-medium text-[var(--color-foreground)]">{row.subjectName}</td>
                  <td className="py-2 pr-3 text-[var(--color-muted-foreground)]">
                    {row.attempted}/{row.questions}
                  </td>
                  <td className="py-2 pr-3 text-[var(--color-success)]">{row.correct}</td>
                  <td className="py-2 pr-3 text-[var(--color-error)]">{row.incorrect}</td>
                  <td className="py-2 pr-3 text-[var(--color-muted-foreground)]">
                    {row.marks}/{row.maxMarks}
                  </td>
                  <td className="py-2 pr-3 text-[var(--color-muted-foreground)]">{Math.round(row.accuracy * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {performance.strongTopics.length > 0 || performance.needsImprovementTopics.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TopicList
              icon={<TrendingUp className="h-3.5 w-3.5 text-[var(--color-success)]" aria-hidden />}
              title="Strong Topics"
              topics={performance.strongTopics}
            />
            <TopicList
              icon={<TrendingDown className="h-3.5 w-3.5 text-[var(--color-warning)]" aria-hidden />}
              title="Needs Improvement"
              topics={performance.needsImprovementTopics}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TopicList({ icon, title, topics }: { icon: React.ReactNode; title: string; topics: TopicRow[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-foreground)]">
        {icon} {title}
      </p>
      {topics.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">Not enough data yet.</p>
      ) : (
        topics.map((t) => (
          <div key={t.topicName} className="flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
            <span>{t.topicName}</span>
            <span>{Math.round(t.accuracy * 100)}%</span>
          </div>
        ))
      )}
    </div>
  );
}
