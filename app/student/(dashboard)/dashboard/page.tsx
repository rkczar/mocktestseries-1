import { cookies } from "next/headers";
import { requireStudent } from "@/lib/student-session";
import {
  getDashboardMetrics,
  getEnrolledExams,
  getExamScopedDashboardMetrics,
  getExamSubjectsOverview,
  getNextScheduledTestForStudent,
} from "@/lib/student-data";
import { getVisibleAnnouncementsForStudent } from "@/lib/notifications";
import { ACTIVE_EXAM_COOKIE } from "@/lib/active-exam";
import { SubscriptionStatusCard } from "@/components/student/subscription-status-card";
import { ActiveExamDashboard } from "./active-exam-dashboard";
import { DashboardAnnouncements } from "./dashboard-announcements";
import { toDashboardMetricsView } from "./metrics-view";
import { getDashboardPaperViews, type DashboardPaperView } from "./pyq-view";
import { findPracticeOmrSheet } from "@/lib/omr-sheet";
import { ensureDefaultExamEnrollment } from "@/lib/default-enrollment";
import { FloatingWhatsAppSupport } from "@/components/support/floating-whatsapp-support";
import { getStudentDashboardLayout } from "@/lib/student-dashboard-layout";

export const metadata = { title: "Dashboard — Mock Test Series.in" };

export default async function StudentDashboardPage() {
  const student = await requireStudent();
  const cookieStore = await cookies();
  const requestedExamId = cookieStore.get(ACTIVE_EXAM_COOKIE)?.value;

  const [globalMetrics, dashboardAnnouncements, initialEnrolledExams] = await Promise.all([
    getDashboardMetrics(student.id),
    getVisibleAnnouncementsForStudent(student.id, { dashboardOnly: true, limit: 5 }),
    getEnrolledExams(student.id),
  ]);

  // Safety net for default enrollment (sign-up paths enroll first): a student
  // with no ACTIVE-exam enrollment is enrolled into the default exam here,
  // idempotently. Already-enrolled students never reach this write. When no
  // default exam exists, the existing "Browse Exams" prompt is shown instead.
  let enrolledExams = initialEnrolledExams;
  if (!enrolledExams.some((e) => e.isActive)) {
    const outcome = await ensureDefaultExamEnrollment(student.id);
    if (outcome.status === "ENROLLED") enrolledExams = await getEnrolledExams(student.id);
  }

  // If only one Exam is enrolled it's auto-selected; if multiple, the cookie
  // (last switch, if it's still one of this student's enrollments) wins;
  // otherwise the first enrolled exam is a safe default (Section 1).
  const activeExamId =
    requestedExamId && enrolledExams.some((e) => e.id === requestedExamId) ? requestedExamId : (enrolledExams[0]?.id ?? null);

  const [[rawExamMetrics, subjects, nextTest, papers], omrSheet, layout] = await Promise.all([
    activeExamId
      ? Promise.all([
          getExamScopedDashboardMetrics(student.id, activeExamId),
          getExamSubjectsOverview(activeExamId),
          getNextScheduledTestForStudent(student.id, activeExamId),
          getDashboardPaperViews(student.id, activeExamId),
        ])
      : Promise.all([null, [], getNextScheduledTestForStudent(student.id), [] as DashboardPaperView[]]),
    findPracticeOmrSheet(activeExamId),
    getStudentDashboardLayout(),
  ]);
  const initialMetrics = toDashboardMetricsView(rawExamMetrics ?? globalMetrics);
  const nextTestCard = nextTest
    ? {
        mockTestId: nextTest.mockTest.id,
        title: nextTest.mockTest.title,
        examName: nextTest.mockTest.exam.name,
        availability: nextTest.availability,
        availableFrom: nextTest.mockTest.availableFrom ? nextTest.mockTest.availableFrom.toISOString() : null,
        availableUntil: nextTest.mockTest.availableUntil ? nextTest.mockTest.availableUntil.toISOString() : null,
      }
    : null;

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

      <ActiveExamDashboard
        enrolledExams={enrolledExams.map((e) => ({
          id: e.id,
          name: e.name,
          examDate: (e.examDate ?? e.upcomingDate)?.toISOString() ?? null,
        }))}
        initialActiveExamId={activeExamId}
        initialMetrics={initialMetrics}
        initialSubjects={subjects}
        studyStreak={globalMetrics.studyStreak}
        nextTest={nextTestCard}
        omrResourceId={omrSheet?.id ?? null}
        initialPapers={papers}
        layout={layout}
        announcements={
          <DashboardAnnouncements
            announcements={dashboardAnnouncements.map((a) => ({
              id: a.id,
              title: a.title,
              message: a.message,
              priority: a.priority,
              ctaLabel: a.ctaLabel,
              ctaRoute: a.ctaRoute,
            }))}
          />
        }
        footer={<SubscriptionStatusCard studentId={student.id} />}
      />
      <FloatingWhatsAppSupport surface="dashboard" />
    </div>
  );
}
