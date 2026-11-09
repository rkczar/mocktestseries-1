import { CheckCircle2, XCircle, MinusCircle, Target } from "lucide-react";
import type { getStudentAnalytics } from "@/lib/student-data";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

/**
 * The student Analytics sections (accuracy tiles, exam / subject performance,
 * weak topics, score over time). Shared by the student Analytics page and the
 * Teacher Portal student detail, which passes exam-scoped analytics.
 */
export function StudentAnalyticsSections({ analytics }: { analytics: Awaited<ReturnType<typeof getStudentAnalytics>> }) {
  return (
    <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile icon={<CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" aria-hidden />} label="Correct" value={analytics.correct} />
          <StatTile icon={<XCircle className="h-5 w-5 text-[var(--color-error)]" aria-hidden />} label="Incorrect" value={analytics.incorrect} />
          <StatTile icon={<MinusCircle className="h-5 w-5 text-[var(--color-muted-foreground)]" aria-hidden />} label="Unattempted" value={analytics.unattempted} />
          <StatTile
            icon={<Target className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />}
            label="Accuracy"
            value={analytics.accuracy !== null ? `${analytics.accuracy.toFixed(1)}%` : "—"}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Exam Performance</CardTitle>
            <CardDescription>Average score by exam, submitted attempts only</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.examPerformance.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No submitted attempts yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--color-border)]">
                {analytics.examPerformance.map((e) => (
                  <div key={e.examId} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="text-[var(--color-foreground)]">{e.name}</span>
                    <span className="text-[var(--color-muted-foreground)]">
                      {e.averageScore !== null ? e.averageScore.toFixed(1) : "—"} avg · {e.attempts} attempt{e.attempts === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Subject Performance</CardTitle>
            <CardDescription>Subject Test attempts only</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.subjectPerformance.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No subject test attempts yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--color-border)]">
                {analytics.subjectPerformance.map((s) => (
                  <div key={s.subjectId} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="text-[var(--color-foreground)]">{s.name}</span>
                    <span className="text-[var(--color-muted-foreground)]">
                      {s.averageScore !== null ? s.averageScore.toFixed(1) : "—"} avg · {s.attempts} attempt{s.attempts === 1 ? "" : "s"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Weak Topics</CardTitle>
            <CardDescription>Most incorrect answers, most recent 500</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.weakTopics.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">Not enough data yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--color-border)]">
                {analytics.weakTopics.map((t) => (
                  <div key={t.topicId} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="text-[var(--color-foreground)]">{t.name}</span>
                    <span className="text-[var(--color-muted-foreground)]">{t.incorrectCount} wrong</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Test History</CardTitle>
            <CardDescription>Score over time, oldest to newest</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.performanceOverTime.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No submitted tests yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--color-border)]">
                {analytics.performanceOverTime.map((a, i) => (
                  <div key={i} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-[var(--color-muted-foreground)]">{a.date?.toLocaleDateString() ?? "—"}</span>
                    <span className="text-[var(--color-foreground)]">
                      {a.score?.toFixed(1) ?? "—"} / {a.maxScore} {a.percentage !== null ? `(${a.percentage}%)` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
    </>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-1 py-4">
        {icon}
        <p className="text-lg font-semibold text-[var(--color-foreground)]">{value}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
      </CardContent>
    </Card>
  );
}
