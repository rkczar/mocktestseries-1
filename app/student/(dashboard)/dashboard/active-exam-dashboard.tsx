"use client";

import { useState, useTransition } from "react";
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
  Bookmark,
  BookOpenCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { getActiveExamDashboardDataAction } from "./actions";
import { TestOnTheGo } from "./test-on-the-go";
import type { DashboardMetricsView } from "./metrics-view";

const QUICK_LINKS = [
  { label: "My Exams", href: "/student/exams", icon: GraduationCap, description: "Browse exams, subjects and papers" },
  { label: "Subject Test", href: "/student/subject-test", icon: BookOpen, description: "Practice by subject" },
  { label: "Test Series", href: "/student/test-series", icon: ClipboardList, description: "Published mock tests" },
  { label: "Live Tests", href: "/student/live-tests", icon: Radio, description: "Scheduled tests, taken together" },
  { label: "Custom Module", href: "/student/custom-module", icon: ListChecks, description: "Focused practice sets" },
  { label: "Analytics", href: "/student/analytics", icon: BarChart3, description: "Your performance breakdown" },
  { label: "History", href: "/student/history", icon: HistoryIcon, description: "Your past attempts" },
];

interface ExamOption {
  id: string;
  name: string;
}

interface SubjectOverview {
  id: string;
  name: string;
  questionCount: number;
}

/** Same client-set-cookie pattern as ThemeToggle/TextSizeControl — a plain top-level function, never a mutation inline in the component body. */
function persistActiveExamCookie(examId: string) {
  document.cookie = `${ACTIVE_EXAM_COOKIE}=${examId}; path=/; max-age=31536000; SameSite=Lax`;
}

export function ActiveExamDashboard({
  enrolledExams,
  initialActiveExamId,
  initialMetrics,
  initialSubjects,
  studyStreak,
}: {
  enrolledExams: ExamOption[];
  initialActiveExamId: string | null;
  initialMetrics: DashboardMetricsView;
  initialSubjects: SubjectOverview[];
  studyStreak: number;
}) {
  const [activeExamId, setActiveExamId] = useState(initialActiveExamId);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [subjects, setSubjects] = useState(initialSubjects);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const activeExam = enrolledExams.find((e) => e.id === activeExamId) ?? null;

  const handleSwitch = (examId: string) => {
    if (examId === activeExamId || isPending) return;
    setSwitchError(null);
    persistActiveExamCookie(examId);
    startTransition(async () => {
      try {
        const data = await getActiveExamDashboardDataAction(examId);
        setActiveExamId(examId);
        setMetrics(data.metrics);
        setSubjects(data.subjects);
      } catch (error) {
        setSwitchError(error instanceof Error ? error.message : "Could not switch exams.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {enrolledExams.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-[var(--color-foreground)]">Your Exams</p>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            {enrolledExams.map((exam) => (
              <button
                key={exam.id}
                type="button"
                onClick={() => handleSwitch(exam.id)}
                disabled={isPending}
                className={cn(
                  "shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  exam.id === activeExamId
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                )}
              >
                {exam.name}
              </button>
            ))}
          </div>
          {activeExam ? (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Active Exam: <span className="font-medium text-[var(--color-foreground)]">{activeExam.name}</span>
            </p>
          ) : null}
          {switchError ? <p className="text-xs text-[var(--color-error)]">{switchError}</p> : null}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
            <p className="text-sm text-[var(--color-muted-foreground)]">
              Enroll in an exam to personalize your dashboard with subjects, Test on the Go, and exam-scoped stats.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link href="/student/exams">Browse Exams</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {metrics.inProgress ? (
        <Card className="border-[var(--color-primary)]/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">Continue: {metrics.inProgress.title}</p>
              <p className="text-sm text-[var(--color-muted-foreground)]">{metrics.inProgress.examName}</p>
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
        <MetricTile icon={<Flame className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />} label="Study Streak (All Exams)" value={`${studyStreak}d`} />
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

      {activeExamId && subjects.length > 0 ? <TestOnTheGo examId={activeExamId} subjects={subjects} /> : null}

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

      {activeExamId && subjects.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-foreground)]">
            Subjects in {activeExam?.name ?? "Active Exam"}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {subjects.map((s) => (
              <Link key={s.id} href={`/student/subject-test/${activeExamId}?subjectId=${s.id}`}>
                <Card className="h-full transition-shadow hover:shadow-md">
                  <CardContent className="flex flex-col gap-1 pt-5">
                    <p className="font-medium text-[var(--color-foreground)]">{s.name}</p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">{s.questionCount} Questions</p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

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

      <Link href="/student/saved">
        <Card className="transition-shadow hover:shadow-md">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5">
            <div className="flex items-center gap-3">
              <Bookmark className="h-6 w-6 text-[var(--color-primary)]" aria-hidden />
              <div>
                <p className="font-medium text-[var(--color-foreground)]">Saved Questions</p>
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  {metrics.savedQuestionsCount} {activeExamId ? `saved in ${activeExam?.name ?? "this exam"}` : "saved · All Exams"}
                </p>
              </div>
            </div>
            <Button size="sm" variant="outline" tabIndex={-1} className="pointer-events-none">
              <BookOpenCheck className="h-4 w-4" aria-hidden /> View Saved
            </Button>
          </CardContent>
        </Card>
      </Link>
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
