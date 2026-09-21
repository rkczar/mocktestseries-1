import Link from "next/link";
import { cookies } from "next/headers";
import { Megaphone } from "lucide-react";
import { requireStudent } from "@/lib/student-session";
import { getDashboardMetrics, getEnrolledExams, getExamScopedDashboardMetrics, getExamSubjectsOverview } from "@/lib/student-data";
import { getVisibleAnnouncementsForStudent } from "@/lib/notifications";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ActiveExamDashboard } from "./active-exam-dashboard";
import { toDashboardMetricsView } from "./metrics-view";

export const metadata = { title: "Dashboard — Mock Test Series.in" };

export default async function StudentDashboardPage() {
  const student = await requireStudent();
  const cookieStore = await cookies();
  const requestedExamId = cookieStore.get(ACTIVE_EXAM_COOKIE)?.value;

  const [globalMetrics, dashboardAnnouncements, enrolledExams] = await Promise.all([
    getDashboardMetrics(student.id),
    getVisibleAnnouncementsForStudent(student.id, { dashboardOnly: true, limit: 5 }),
    getEnrolledExams(student.id),
  ]);

  // If only one Exam is enrolled it's auto-selected; if multiple, the cookie
  // (last switch, if it's still one of this student's enrollments) wins;
  // otherwise the first enrolled exam is a safe default (Section 1).
  const activeExamId =
    requestedExamId && enrolledExams.some((e) => e.id === requestedExamId) ? requestedExamId : (enrolledExams[0]?.id ?? null);

  const [rawExamMetrics, subjects] = activeExamId
    ? await Promise.all([getExamScopedDashboardMetrics(student.id, activeExamId), getExamSubjectsOverview(activeExamId)])
    : [null, []];

  const initialMetrics = toDashboardMetricsView(rawExamMetrics ?? globalMetrics);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Welcome back, {student.name?.split(" ")[0] ?? "Student"}</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {globalMetrics.testsCompleted > 0
            ? `${globalMetrics.testsCompleted} test${globalMetrics.testsCompleted === 1 ? "" : "s"} completed so far.`
            : "Start your first test to see your progress here."}
        </p>
      </div>

      {dashboardAnnouncements.length > 0 ? (
        <div className="flex flex-col gap-3">
          {dashboardAnnouncements.map((a) => (
            <Card key={a.id} className={a.priority === "IMPORTANT" ? "border-[var(--color-warning)]/50" : undefined}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
                <div className="flex items-start gap-3">
                  <Megaphone className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-[var(--color-foreground)]">{a.title}</p>
                      {a.priority === "IMPORTANT" ? <Badge variant="warning">Important</Badge> : null}
                    </div>
                    <p className="text-sm text-[var(--color-muted-foreground)]">{a.message}</p>
                  </div>
                </div>
                {a.ctaRoute && a.ctaLabel ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={a.ctaRoute}>{a.ctaLabel}</Link>
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <ActiveExamDashboard
        enrolledExams={enrolledExams.map((e) => ({ id: e.id, name: e.name }))}
        initialActiveExamId={activeExamId}
        initialMetrics={initialMetrics}
        initialSubjects={subjects}
        studyStreak={globalMetrics.studyStreak}
      />
    </div>
  );
}
