import Link from "next/link";
import { GraduationCap, ClipboardList, ListChecks, History as HistoryIcon, ArrowRight, BookOpen } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { prisma } from "@/lib/prisma";
import { AttemptStatus } from "@prisma/client";
import { attemptTitle } from "@/lib/attempt-title";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Dashboard — Mock Test Series.in" };

const QUICK_LINKS = [
  { label: "My Exams", href: "/student/exams", icon: GraduationCap, description: "Browse exams, subjects and papers" },
  { label: "Subject Test", href: "/student/subject-test", icon: BookOpen, description: "Practice by subject" },
  { label: "Test Series", href: "/student/test-series", icon: ClipboardList, description: "Published mock tests" },
  { label: "Custom Module", href: "/student/custom-module", icon: ListChecks, description: "Focused practice sets" },
  { label: "History", href: "/student/history", icon: HistoryIcon, description: "Your past attempts" },
];

export default async function StudentDashboardPage() {
  const student = await requireStudent();

  const [inProgress, submittedCount, avgScoreAgg] = await Promise.all([
    prisma.testAttempt.findFirst({
      where: { studentId: student.id, status: AttemptStatus.IN_PROGRESS },
      orderBy: { startedAt: "desc" },
      include: { exam: true, mockTest: true, customModule: true, previousYearPaper: true, subject: true },
    }),
    prisma.testAttempt.count({ where: { studentId: student.id, status: AttemptStatus.SUBMITTED } }),
    prisma.testAttempt.aggregate({
      where: { studentId: student.id, status: AttemptStatus.SUBMITTED },
      _avg: { score: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Welcome back, {student.name?.split(" ")[0] ?? "Student"}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {submittedCount > 0
            ? `${submittedCount} test${submittedCount === 1 ? "" : "s"} completed so far.`
            : "Start your first test to see your progress here."}
        </p>
      </div>

      {inProgress ? (
        <Card className="border-[var(--color-primary)]/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
            <div>
              <p className="text-sm font-medium text-[var(--color-foreground)]">
                Continue: {attemptTitle(inProgress as NonNullable<typeof inProgress>)}
              </p>
              <p className="text-sm text-[var(--color-muted-foreground)]">{inProgress.exam.name}</p>
            </div>
            <Button asChild>
              <Link href={`/student/attempt/${inProgress.id}/run`}>
                Continue <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
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

      <Card>
        <CardHeader>
          <CardTitle>Your Progress</CardTitle>
          <CardDescription>Based on completed attempts</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Tests Completed</p>
            <p className="text-2xl font-semibold text-[var(--color-foreground)]">{submittedCount}</p>
          </div>
          <div>
            <p className="text-xs uppercase text-[var(--color-muted-foreground)]">Average Score</p>
            <p className="text-2xl font-semibold text-[var(--color-foreground)]">
              {avgScoreAgg._avg.score !== null ? avgScoreAgg._avg.score.toFixed(1) : "—"}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
