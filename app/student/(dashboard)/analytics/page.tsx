import Link from "next/link";
import { cookies } from "next/headers";
import { requireStudentOrLogin } from "@/lib/student-session";
import { getEnrolledExams, getStudentAnalytics } from "@/lib/student-data";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { getOverallLeaderboard, getStudentRankedTests, OVERALL_MIN_RANKED_TESTS } from "@/lib/leaderboard";
import { OverallLeaderboardCard, RankedTestHistory, RankingSummary } from "@/components/student/ranking-progress";
import { cn } from "@/lib/utils";
import { BackButton } from "@/components/student/back-button";
import { StudentAnalyticsSections } from "@/components/student/analytics-sections";

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

      <StudentAnalyticsSections analytics={analytics} />
    </div>
  );
}

