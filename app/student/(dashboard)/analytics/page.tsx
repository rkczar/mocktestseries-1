import Link from "next/link";
import { cookies } from "next/headers";
import { CheckCircle2, XCircle, MinusCircle, Target } from "lucide-react";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getEnrolledExams, getStudentAnalytics } from "@/lib/student-data";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { getOverallLeaderboard, getStudentRankedTests, OVERALL_MIN_RANKED_TESTS } from "@/lib/leaderboard";
import { OverallLeaderboardCard, RankedTestHistory, RankingSummary } from "@/components/student/ranking-progress";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { BackButton } from "@/components/student/back-button";

export const metadata = { title: "Analytics — Mock Test Series.in" };

export default async function StudentAnalyticsPage({ searchParams }: { searchParams: Promise<{ exam?: string; overallPage?: string }> }) {
  const { exam: examParam, overallPage } = await searchParams;
  const student = await requireStudentOrLogin();
  const [analytics, enrolledExams, cookieStore] = await Promise.all([getStudentAnalytics(student.id), getEnrolledExams(student.id), cookies()]);

  // Ranking & Progress is scoped to one enrolled exam: ?exam= (dashboard card /
  // exam chips), else the Active Exam cookie, else the first enrollment. Any
  // other id is ignored, never trusted.
  const cookieExam = cookieStore.get(ACTIVE_EXAM_COOKIE)?.value;
  const rankingExam =
    enrolledExams.find((e) => e.id === examParam) ?? enrolledExams.find((e) => e.id === cookieExam) ?? enrolledExams[0] ?? null;
  const page = Number.parseInt(overallPage ?? "1", 10);
  const [overall, rankedTests] = rankingExam
    ? await Promise.all([
        getOverallLeaderboard(rankingExam.id, student.id, { page: Number.isFinite(page) ? page : 1 }),
        getStudentRankedTests(rankingExam.id, student.id),
      ])
    : [null, []];

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Analytics</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Your performance across every test you&apos;ve taken.</p>
      </div>

      {rankingExam && overall ? (
        <section id="ranking" aria-labelledby="ranking-heading" className="flex scroll-mt-20 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="ranking-heading" className="text-lg font-semibold text-[var(--color-foreground)]">
                Ranking &amp; Progress
              </h2>
              <p className="text-sm text-[var(--color-muted-foreground)]">{rankingExam.name}</p>
            </div>
            {enrolledExams.length > 1 ? (
              <nav className="flex flex-wrap gap-2" aria-label="Exam">
                {enrolledExams.map((e) => (
                  <Link
                    key={e.id}
                    href={`/student/analytics?exam=${e.id}#ranking`}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-medium",
                      e.id === rankingExam.id
                        ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                        : "border-[var(--color-border)] text-[var(--color-muted-foreground)]"
                    )}
                  >
                    {e.name}
                  </Link>
                ))}
              </nav>
            ) : null}
          </div>
          <RankingSummary overall={overall} history={rankedTests} required={OVERALL_MIN_RANKED_TESTS} />
          <RankedTestHistory rows={rankedTests} />
          {overall.countedTests > 0 ? (
            <OverallLeaderboardCard
              board={overall}
              examName={rankingExam.name}
              pageHref={(p) => `/student/analytics?exam=${rankingExam.id}&overallPage=${p}#overall-leaderboard`}
            />
          ) : null}
        </section>
      ) : null}

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
    </div>
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
