import Link from "next/link";
import {
  GraduationCap,
  ClipboardList,
  ListChecks,
  History as HistoryIcon,
  ArrowRight,
  BookOpen,
  Radio,
  Flame,
  CheckCircle2,
  ListTodo,
  Trophy,
  CalendarClock,
  AlertTriangle,
  BarChart3,
} from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getDashboardMetrics } from "@/lib/student-data";
import { attemptTitle } from "@/lib/attempt-title";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Dashboard — Mock Test Series.in" };

const QUICK_LINKS = [
  { label: "My Exams", href: "/student/exams", icon: GraduationCap, description: "Browse exams, subjects and papers" },
  { label: "Subject Test", href: "/student/subject-test", icon: BookOpen, description: "Practice by subject" },
  { label: "Test Series", href: "/student/test-series", icon: ClipboardList, description: "Published mock tests" },
  { label: "Live Tests", href: "/student/live-tests", icon: Radio, description: "Scheduled tests, taken together" },
  { label: "Custom Module", href: "/student/custom-module", icon: ListChecks, description: "Focused practice sets" },
  { label: "Analytics", href: "/student/analytics", icon: BarChart3, description: "Your performance breakdown" },
  { label: "History", href: "/student/history", icon: HistoryIcon, description: "Your past attempts" },
];

export default async function StudentDashboardPage() {
  const student = await requireStudent();
  const metrics = await getDashboardMetrics(student.id);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Welcome back, {student.name?.split(" ")[0] ?? "Student"}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {metrics.testsCompleted > 0
            ? `${metrics.testsCompleted} test${metrics.testsCompleted === 1 ? "" : "s"} completed so far.`
            : "Start your first test to see your progress here."}
        </p>
      </div>

      {metrics.inProgress ? (
        <Card className="border-[var(--color-primary)]/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Continue: {attemptTitle(metrics.inProgress)}</p>
              <p className="text-sm text-[var(--color-muted-foreground)]">{metrics.inProgress.exam.name}</p>
            </div>
            <Button asChild>
              <Link href={`/student/attempt/${metrics.inProgress.id}/run`}>
                Continue <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricTile icon={<CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" aria-hidden />} label="MCQs Solved Today" value={metrics.mcqSolvedToday} />
        <MetricTile icon={<ListTodo className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />} label="Questions Attempted" value={metrics.questionsAttempted} />
        <MetricTile icon={<Trophy className="h-5 w-5 text-[var(--color-accent)]" aria-hidden />} label="Tests Completed" value={metrics.testsCompleted} />
        <MetricTile icon={<Flame className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />} label="Study Streak" value={`${metrics.studyStreak}d`} />
        <MetricTile
          icon={<BarChart3 className="h-5 w-5 text-[var(--color-info)]" aria-hidden />}
          label="Average Score"
          value={metrics.averageScore !== null ? metrics.averageScore.toFixed(1) : "—"}
        />
        <MetricTile
          icon={<CalendarClock className="h-5 w-5 text-[var(--color-muted-foreground)]" aria-hidden />}
          label={metrics.upcomingExam ? metrics.upcomingExam.name : "Upcoming Exam"}
          value={metrics.upcomingExam ? `${metrics.upcomingExam.daysLeft}d left` : "—"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {QUICK_LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            <Card className="h-full transition-shadow hover:shadow-md">
              <CardContent className="flex flex-col gap-2 pt-5">
                <link.icon className="h-6 w-6 text-[var(--color-primary)]" aria-hidden />
                <p className="font-medium text-[var(--color-foreground)]">{link.label}</p>
                <p className="text-sm text-[var(--color-muted-foreground)]">{link.description}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent Test</CardTitle>
          </CardHeader>
          <CardContent>
            {metrics.recentTest ? (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--color-foreground)]">{metrics.recentTest.title}</p>
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    {metrics.recentTest.score?.toFixed(1) ?? "—"} / {metrics.recentTest.maxScore}
                  </p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/student/attempt/${metrics.recentTest.id}/result`}>View</Link>
                </Button>
              </div>
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">No completed tests yet.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-[var(--color-warning)]" aria-hidden /> Weak Topics
            </CardTitle>
            <CardDescription>Where you&apos;ve gotten the most questions wrong recently</CardDescription>
          </CardHeader>
          <CardContent>
            {metrics.weakTopics.length === 0 ? (
              <p className="text-sm text-[var(--color-muted-foreground)]">Not enough data yet — keep practicing.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {metrics.weakTopics.map((t) => (
                  <div key={t.topicId} className="flex items-center justify-between text-sm">
                    <span className="text-[var(--color-foreground)]">{t.name}</span>
                    <span className="text-[var(--color-muted-foreground)]">{t.incorrectCount} wrong</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-1 py-4 text-center">
        {icon}
        <p className="text-lg font-semibold text-[var(--color-foreground)]">{value}</p>
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
      </CardContent>
    </Card>
  );
}
