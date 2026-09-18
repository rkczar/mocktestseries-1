import { getPlatformAnalytics } from "@/lib/admin-analytics";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const metadata = { title: "Analytics — Mock Test Series.in Admin" };

function formatPercent(value: number | null): string {
  return value !== null ? `${value.toFixed(1)}%` : "—";
}

function DailyTrend({ title, description, series }: { title: string; description: string; series: { date: string; count: number }[] }) {
  const max = Math.max(1, ...series.map((s) => s.count));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {series.every((s) => s.count === 0) ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No activity in this window yet.</p>
        ) : (
          <div className="flex h-32 items-end gap-1.5">
            {series.map((s) => (
              <div key={s.date} className="group relative flex flex-1 flex-col items-center justify-end gap-1">
                <span className="pointer-events-none absolute -top-6 rounded-[var(--radius-badge)] bg-[var(--color-foreground)] px-1.5 py-0.5 text-[10px] text-[var(--color-background)] opacity-0 transition-opacity group-hover:opacity-100">
                  {s.count}
                </span>
                <div
                  className="w-full min-h-[2px] rounded-t-sm bg-[var(--color-primary)]"
                  style={{ height: `${(s.count / max) * 100}%` }}
                />
                <span className="text-[9px] text-[var(--color-muted-foreground)]">
                  {new Date(s.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PerformanceTable({
  title,
  description,
  rows,
  emptyLabel,
}: {
  title: string;
  description: string;
  rows: { key: string; name: string; attempts: number; averageScore: number | null }[];
  emptyLabel: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">{emptyLabel}</p>
        ) : (
          <div className="flex flex-col divide-y divide-[var(--color-border)]">
            {rows.map((r) => (
              <div key={r.key} className="flex items-center justify-between py-2.5 text-sm">
                <span className="text-[var(--color-foreground)]">{r.name}</span>
                <span className="text-[var(--color-muted-foreground)]">
                  {r.averageScore !== null ? r.averageScore.toFixed(1) : "—"} avg · {r.attempts} attempt{r.attempts === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default async function AnalyticsPage() {
  const a = await getPlatformAnalytics();

  const funnelSteps = [
    { label: "Registered", value: a.funnel.registered },
    { label: "Enrolled in an exam", value: a.funnel.enrolled },
    { label: "Attempted a test", value: a.funnel.attempted },
    { label: "Submitted a test", value: a.funnel.submitted },
  ];
  const funnelMax = Math.max(1, funnelSteps[0].value);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Analytics</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Platform-wide engagement and performance trends — signups, test activity, and how students are doing by
          exam, subject, and difficulty.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total Students" value={a.totalStudents} />
        <StatCard label="Active Students (7d)" value={a.activeStudents7d} />
        <StatCard label="New Students (30d)" value={a.newStudents30d} />
        <StatCard label="Total Attempts" value={a.totalAttempts} />
        <StatCard label="Submitted Attempts" value={a.submittedAttempts} />
        <StatCard label="In-Progress Attempts" value={a.inProgressAttempts} />
        <StatCard label="Overall Accuracy" value={formatPercent(a.overallAccuracy)} />
        <StatCard label="Average Score" value={formatPercent(a.averageScorePercent)} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DailyTrend title="New Signups" description="Last 14 days, by registration date (IST)" series={a.signupsByDay} />
        <DailyTrend title="Test Attempts" description="Last 14 days, submitted attempts by submission date (IST)" series={a.attemptsByDay} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Engagement Funnel</CardTitle>
          <CardDescription>Every registered student, narrowed down to who actually submits a test</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {funnelSteps.map((step) => (
              <div key={step.label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-[var(--color-foreground)]">{step.label}</span>
                  <span className="text-[var(--color-muted-foreground)]">
                    {step.value.toLocaleString("en-IN")}
                    {funnelSteps[0].value > 0 ? ` (${((step.value / funnelSteps[0].value) * 100).toFixed(1)}%)` : ""}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-primary)]"
                    style={{ width: `${(step.value / funnelMax) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <PerformanceTable
          title="Exam Performance"
          description="Top exams by submitted attempts"
          emptyLabel="No submitted attempts yet."
          rows={a.examPerformance.map((e) => ({ key: e.examId, name: e.name, attempts: e.attempts, averageScore: e.averageScore ?? null }))}
        />
        <PerformanceTable
          title="Subject Performance"
          description="Top subjects by submitted subject-test attempts"
          emptyLabel="No subject test attempts yet."
          rows={a.subjectPerformance.map((s) => ({ key: s.subjectId, name: s.name, attempts: s.attempts, averageScore: s.averageScore ?? null }))}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accuracy by Difficulty</CardTitle>
          <CardDescription>Across every answered question, platform-wide</CardDescription>
        </CardHeader>
        <CardContent>
          {a.difficultyStats.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">Not enough data yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--color-border)]">
              {a.difficultyStats.map((d) => (
                <div key={d.difficulty} className="flex items-center justify-between py-2.5 text-sm">
                  <span className="text-[var(--color-foreground)]">{d.difficulty.charAt(0) + d.difficulty.slice(1).toLowerCase()}</span>
                  <span className="text-[var(--color-muted-foreground)]">
                    {formatPercent(d.accuracy)} accuracy · {d.total.toLocaleString("en-IN")} answered
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
