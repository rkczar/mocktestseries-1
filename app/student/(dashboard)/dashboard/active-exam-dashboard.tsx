"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  GraduationCap,
  ClipboardList,
  ListChecks,
  History as HistoryIcon,
  ArrowRight,
  BookOpen,
  Flame,
  CheckCircle2,
  ListTodo,
  Trophy,
  CalendarClock,
  AlertTriangle,
  BarChart3,
  Bookmark,
  FileDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { formatIst } from "@/lib/ist-time";
import { getActiveExamDashboardDataAction } from "./actions";
import { TestOnTheGo } from "./test-on-the-go";
import type { DashboardMetricsView } from "./metrics-view";
import type { DashboardPaperView } from "./pyq-view";
import { PreviousYearPapers } from "./previous-year-papers";
import {
  studentDashboardBlock,
  type StudentDashboardBlockId,
  type StudentDashboardGroup,
  type StudentDashboardLayout,
} from "@/lib/student-dashboard-blocks";
import { omrDownloadHref } from "@/components/omr/omr-practice-card";

// Practice & Tests — every test/practice entry point, one card per action.
// Mock Tests covers the schedule too (it lives on the Test Series page).
const PRACTICE_LINKS = {
  mockTests: { label: "Mock Tests", href: "/student/test-series", icon: ClipboardList, description: "Test series & schedule" },
  subjectTest: { label: "Subject Test", href: "/student/subject-test", icon: BookOpen, description: "Practice by subject" },
  customModule: { label: "Custom Module", href: "/student/custom-module", icon: ListChecks, description: "Build your own practice set" },
};

// Overview links — where the numbers in Performance Summary come from.
const OVERVIEW_LINKS = [
  { label: "Analytics", href: "/student/analytics", icon: BarChart3, description: "Your performance breakdown" },
  { label: "History", href: "/student/history", icon: HistoryIcon, description: "Your past attempts" },
  { label: "My Exams", href: "/student/exams", icon: GraduationCap, description: "Browse exams, subjects and papers" },
];

interface NextTestCard {
  mockTestId: string;
  title: string;
  examName: string;
  availability: "UPCOMING" | "AVAILABLE" | "LIVE_NOW" | "CLOSED";
  availableFrom: string | null; // ISO
  availableUntil: string | null; // ISO — Fixed Window end
}

/** Display-only countdown — startMockTestAttempt's server-side check is the real gate regardless of what this shows. */
function Countdown({ target }: { target: Date }) {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const diffMs = target.getTime() - Date.now();
      if (diffMs <= 0) {
        setLabel(null);
        return;
      }
      const totalMinutes = Math.floor(diffMs / 60000);
      const days = Math.floor(totalMinutes / (60 * 24));
      const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
      const minutes = totalMinutes % 60;
      setLabel(days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`);
    };
    tick();
    const interval = setInterval(tick, 30_000);
    return () => clearInterval(interval);
  }, [target]);

  if (!label) return null;
  return <p className="text-xs text-[var(--color-muted-foreground)]">Starts in: {label}</p>;
}

interface ExamOption {
  id: string;
  name: string;
  examDate: string | null; // ISO — Exam.examDate (or upcomingDate), shown only when set
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
  nextTest: initialNextTest,
  omrResourceId = null,
  initialPapers,
  layout,
  announcements = null,
  footer = null,
}: {
  enrolledExams: ExamOption[];
  initialActiveExamId: string | null;
  initialMetrics: DashboardMetricsView;
  initialSubjects: SubjectOverview[];
  studyStreak: number;
  nextTest: NextTestCard | null;
  omrResourceId?: string | null;
  initialPapers: DashboardPaperView[];
  /** Admin-managed block order/visibility (lib/student-dashboard-layout.ts). */
  layout: StudentDashboardLayout;
  /** Server-rendered announcements — rendered first, directly under Welcome Back. */
  announcements?: React.ReactNode;
  /** Lower-priority server-rendered content (subscription status), rendered last. */
  footer?: React.ReactNode;
}) {
  const [activeExamId, setActiveExamId] = useState(initialActiveExamId);
  const [metrics, setMetrics] = useState(initialMetrics);
  const [subjects, setSubjects] = useState(initialSubjects);
  const [nextTest, setNextTest] = useState(initialNextTest);
  const [papers, setPapers] = useState(initialPapers);
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
        setNextTest(data.nextTest);
        setPapers(data.papers);
      } catch (error) {
        setSwitchError(error instanceof Error ? error.message : "Could not switch exams.");
      }
    });
  };

  const examDate = activeExam?.examDate ? new Date(activeExam.examDate) : null;

  // Every registered block (lib/student-dashboard-blocks.ts). null = nothing
  // to show for this student right now; the block is then skipped cleanly.
  const blocks: Record<StudentDashboardBlockId, React.ReactNode> = {
    "performance-summary": (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricTile icon={<CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" aria-hidden />} label="MCQs Solved Today" value={metrics.mcqSolvedToday} />
        <MetricTile icon={<ListTodo className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />} label="Questions Attempted" value={metrics.questionsAttempted} />
        <MetricTile icon={<Trophy className="h-5 w-5 text-[var(--color-accent)]" aria-hidden />} label="Tests Completed" value={metrics.testsCompleted} />
        <MetricTile icon={<Flame className="h-5 w-5 text-[var(--color-warning)]" aria-hidden />} label="Study Streak (All Exams)" value={`${studyStreak}d`} />
        <MetricTile
          icon={<BarChart3 className="h-5 w-5 text-[var(--color-info)]" aria-hidden />}
          label="Average Score"
          value={metrics.averageScore !== null ? metrics.averageScore.toFixed(1) : "—"}
        />
      </div>
    ),
    "analytics-progress": (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {OVERVIEW_LINKS.map((link) => (
          <QuickLinkCard key={link.label} {...link} />
        ))}
        <QuickLinkCard
          label="Saved Questions"
          href="/student/saved"
          icon={Bookmark}
          description={`${metrics.savedQuestionsCount} ${activeExamId ? `saved in ${activeExam?.name ?? "this exam"}` : "saved · All Exams"}`}
        />
      </div>
    ),
    "test-schedule": nextTest ? (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
              <CalendarClock className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden />
              Test Schedule · Next Test
            </p>
            <p className="text-sm font-medium text-[var(--color-foreground)]">{nextTest.title}</p>
            <p className="text-xs text-[var(--color-muted-foreground)]">{nextTest.examName}</p>
            {nextTest.availability === "LIVE_NOW" ? (
              <Badge variant="warning" className="mt-1 w-fit">
                Live Now{nextTest.availableUntil ? ` · Ends ${formatIst(new Date(nextTest.availableUntil))}` : ""}
              </Badge>
            ) : nextTest.availability === "AVAILABLE" ? (
              <Badge variant="success" className="mt-1 w-fit">
                Available Now
              </Badge>
            ) : nextTest.availableFrom ? (
              <>
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{formatIst(new Date(nextTest.availableFrom))}</p>
                <Countdown target={new Date(nextTest.availableFrom)} />
              </>
            ) : null}
          </div>
          <Button asChild variant={nextTest.availability !== "UPCOMING" ? "primary" : "outline"}>
            <Link href={nextTest.availability !== "UPCOMING" ? `/student/test-series/${nextTest.mockTestId}` : "/student/test-series"}>
              {nextTest.availability !== "UPCOMING" ? "Start Test" : "View Full Schedule"}
            </Link>
          </Button>
        </CardContent>
      </Card>
    ) : null,
    "mock-tests": <QuickLinkCard {...PRACTICE_LINKS.mockTests} />,
    "subject-test": <QuickLinkCard {...PRACTICE_LINKS.subjectTest} />,
    "custom-module": <QuickLinkCard {...PRACTICE_LINKS.customModule} />,
    // Direct download of the canonical branded OMR sheet — no intermediate page.
    "practice-omr": omrResourceId ? (
      <a href={omrDownloadHref(omrResourceId)} download>
        <QuickLinkCardBody label="Practice OMR Sheet" icon={FileDown} description="Download the printable OMR sheet" />
      </a>
    ) : null,
    "test-on-the-go": activeExamId && subjects.length > 0 ? <TestOnTheGo examId={activeExamId} subjects={subjects} /> : null,
    subjects:
      activeExamId && subjects.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-[var(--color-muted-foreground)]">Subjects in {activeExam?.name ?? "Active Exam"}</h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
      ) : null,
    "previous-year-papers":
      activeExamId && papers.length > 0 ? <PreviousYearPapers papers={papers} examId={activeExamId} examName={activeExam?.name ?? "Active Exam"} /> : null,
    "continue-attempt": metrics.inProgress ? (
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
    ) : null,
    "recent-activity": (
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
    ),
    "weak-topics": (
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
    ),
    "subscription-status": footer,
  };

  const sectionHeading: Partial<Record<StudentDashboardGroup, { id: string; title: React.ReactNode }>> = {
    overview: {
      id: "performance-summary",
      title: (
        <>
          Performance Summary{activeExam ? <span className="font-normal text-[var(--color-muted-foreground)]"> · {activeExam.name}</span> : null}
        </>
      ),
    },
    practice: { id: "practice-tests", title: "Practice & Tests" },
    // Previous Year Papers carries its own heading; account needs none.
    recent: { id: "recent-activity", title: "Recent Activity" },
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Announcements — directly under Welcome Back (page.tsx) */}
      {announcements}

      {/* 2. Your Active Exam — canonical DB exam name */}
      {enrolledExams.length > 0 ? (
        <Card className="border-[var(--color-primary)]/40">
          <CardContent className="flex flex-col gap-4 pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">Your Active Exam</p>
                <p className="text-lg font-semibold text-[var(--color-foreground)]">{activeExam?.name ?? "Select an exam"}</p>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {[
                    examDate ? `Exam date: ${formatIst(examDate).split(",")[0]}` : null,
                    subjects.length > 0 ? `${subjects.length} subject${subjects.length === 1 ? "" : "s"}` : null,
                    subjects.length > 0 ? `${subjects.reduce((n, s) => n + s.questionCount, 0)} practice questions` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {metrics.upcomingExam?.daysLeft != null ? (
                <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2 text-center">
                  <p className="text-lg font-semibold text-[var(--color-foreground)]">{metrics.upcomingExam.daysLeft}d</p>
                  <p className="text-[11px] text-[var(--color-muted-foreground)]">to exam</p>
                </div>
              ) : null}
            </div>
            {enrolledExams.length > 1 ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-[var(--color-muted-foreground)]">Switch exam</p>
                <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
                  {enrolledExams.map((exam) => (
                    <button
                      key={exam.id}
                      type="button"
                      onClick={() => handleSwitch(exam.id)}
                      disabled={isPending}
                      aria-pressed={exam.id === activeExamId}
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
              </div>
            ) : null}
            {switchError ? <p className="text-xs text-[var(--color-error)]">{switchError}</p> : null}
          </CardContent>
        </Card>
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

      {/* Registered blocks in the Admin → Website → Student Dashboard order. */}
      {renderDashboardSections(layout, blocks, sectionHeading)}
    </div>
  );
}

/**
 * Renders the visible, non-empty blocks in layout order. Consecutive blocks of
 * one group share a section heading; consecutive `card` blocks share a grid.
 */
function renderDashboardSections(
  layout: StudentDashboardLayout,
  blocks: Record<StudentDashboardBlockId, React.ReactNode>,
  headings: Partial<Record<StudentDashboardGroup, { id: string; title: React.ReactNode }>>
) {
  type Run = { group: StudentDashboardGroup; items: { id: StudentDashboardBlockId; cards: StudentDashboardBlockId[] }[] };
  const runs: Run[] = [];
  for (const entry of layout) {
    if (!entry.visible || blocks[entry.id] == null) continue;
    const meta = studentDashboardBlock(entry.id);
    let run = runs[runs.length - 1];
    if (!run || run.group !== meta.group) runs.push((run = { group: meta.group, items: [] }));
    const last = run.items[run.items.length - 1];
    if (meta.card && last && last.cards.length > 0) last.cards.push(entry.id);
    else run.items.push({ id: entry.id, cards: meta.card ? [entry.id] : [] });
  }

  const usedIds = new Set<string>();
  return runs.map((run, i) => {
    const heading = headings[run.group];
    const headingId = heading ? (usedIds.has(heading.id) ? `${heading.id}-${i}` : heading.id) : undefined;
    if (headingId) usedIds.add(headingId);
    const content = run.items.map((item) =>
      item.cards.length > 0 ? (
        <div key={item.id} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {item.cards.map((id) => (
            <Fragment key={id}>{blocks[id]}</Fragment>
          ))}
        </div>
      ) : (
        <Fragment key={item.id}>{blocks[item.id]}</Fragment>
      )
    );
    return heading ? (
      <section key={`${run.group}-${i}`} aria-labelledby={headingId} data-dashboard-group={run.group} className="flex flex-col gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-[var(--color-foreground)]">
          {heading.title}
        </h2>
        {content}
      </section>
    ) : (
      <div key={`${run.group}-${i}`} data-dashboard-group={run.group} className="flex flex-col gap-3">
        {content}
      </div>
    );
  });
}

type QuickLink = { label: string; href: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>; description: string };

function QuickLinkCard({ href, ...body }: QuickLink) {
  return (
    <Link href={href}>
      <QuickLinkCardBody {...body} />
    </Link>
  );
}

function QuickLinkCardBody({ label, icon: Icon, description }: Omit<QuickLink, "href">) {
  return (
    <Card className="h-full transition-shadow hover:shadow-md">
      <CardContent className="flex flex-col gap-2 pt-5">
        <Icon className="h-6 w-6 text-[var(--color-primary)]" aria-hidden />
        <p className="font-medium text-[var(--color-foreground)]">{label}</p>
        <p className="text-sm text-[var(--color-muted-foreground)]">{description}</p>
      </CardContent>
    </Card>
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
