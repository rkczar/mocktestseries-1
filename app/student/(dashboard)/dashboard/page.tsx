import { cookies } from "next/headers";
import { requireStudentOrLogin } from "@/lib/student-session";
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
import { AccessPanel } from "@/components/student/access-panel";
import { getStudentExamAccessSummaries } from "@/lib/payments/student-access";
import { ActiveExamDashboard } from "./active-exam-dashboard";
import { DashboardAnnouncements } from "./dashboard-announcements";
import { toDashboardMetricsView, toOverallRankView } from "./metrics-view";
import { getOverallStanding, OVERALL_MIN_RANKED_TESTS } from "@/lib/leaderboard";
import { getDashboardPaperViews, type DashboardPaperView } from "./pyq-view";
import { findPracticeOmrSheet } from "@/lib/omr-sheet";
import { ensureDefaultExamEnrollment } from "@/lib/default-enrollment";
import { InstallAppBanner } from "@/components/pwa/install-app";
import { FloatingWhatsAppSupport } from "@/components/support/floating-whatsapp-support";
import { getStudentDashboardLayout } from "@/lib/student-dashboard-layout";
import { getStudentReviewState } from "@/lib/student-review";
import { StudentReviewCard } from "./review-card";
import { getDashboardReviewsSafe } from "@/lib/reviews";
import { ReviewsSection } from "@/components/homepage/reviews-section";
import { getDashboardLiveCbtPromotion } from "@/lib/live-cbt";
import { getSiteUrl } from "@/lib/site-url";

export const metadata = { title: "Dashboard — Mock Test Series.in" };

export default async function StudentDashboardPage() {
  const student = await requireStudentOrLogin();
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

  const siteUrl = await getSiteUrl();
  const [[rawExamMetrics, subjects, nextTest, papers, overall], omrSheet, layout, accessSummaries, reviewState, publicReviews, liveCbt] = await Promise.all([
    activeExamId
      ? Promise.all([
          getExamScopedDashboardMetrics(student.id, activeExamId),
          getExamSubjectsOverview(activeExamId),
          getNextScheduledTestForStudent(student.id, activeExamId),
          getDashboardPaperViews(student.id, activeExamId),
          // Overall Rank card; never let it break the dashboard.
          getOverallStanding(activeExamId, student.id).catch(() => null),
        ])
      : Promise.all([null, [], getNextScheduledTestForStudent(student.id), [] as DashboardPaperView[], null]),
    findPracticeOmrSheet(activeExamId),
    getStudentDashboardLayout(),
    getStudentExamAccessSummaries(student.id, enrolledExams),
    // Never let the optional review block break the dashboard.
    getStudentReviewState(student.id).catch(() => null),
    // Same cached query as the homepage section; never throws, null hides the block.
    getDashboardReviewsSafe(),
    // Live CBT card (admin-promoted); never let it break the dashboard.
    getDashboardLiveCbtPromotion(student.id, activeExamId, siteUrl).catch(() => null),
  ]);
  // Server-rendered per exam; the client picks the active exam's card, so an
  // exam switch never shows another exam's access state.
  const accessPanels = Object.fromEntries(accessSummaries.map((s) => [s.exam.id, <AccessPanel key={s.exam.id} summary={s} />]));
  const coveredProductIds = accessSummaries.flatMap((s) => (s.state === "ACTIVE" ? (s.entitlement?.productIds ?? []) : []));
  const initialMetrics = {
    ...toDashboardMetricsView(rawExamMetrics ?? globalMetrics),
    overallRank: rawExamMetrics && overall ? toOverallRankView({ id: rawExamMetrics.examId, name: rawExamMetrics.examName }, overall, OVERALL_MIN_RANKED_TESTS) : null,
  };
  const nextTestCard = nextTest
    ? {
        mockTestId: nextTest.mockTest.id,
        title: nextTest.mockTest.title,
        examName: nextTest.mockTest.exam.name,
        availability: nextTest.availability,
        availableFrom: nextTest.mockTest.availableFrom ? nextTest.mockTest.availableFrom.toISOString() : null,
        availableUntil: nextTest.mockTest.availableUntil ? nextTest.mockTest.availableUntil.toISOString() : null,
        enrollmentEnabled: nextTest.mockTest.enrollmentEnabled,
        enrolled: nextTest.enrolled,
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
        <InstallAppBanner className="mt-3" />
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
        liveCbt={liveCbt}
        serverNow={Date.now()}
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
        accessPanels={accessPanels}
        footer={<SubscriptionStatusCard studentId={student.id} excludeProductIds={coveredProductIds} />}
        reviewCard={reviewState ? <StudentReviewCard state={reviewState} /> : null}
        reviewsSection={
          publicReviews ? <ReviewsSection settings={publicReviews.settings} reviews={publicReviews.reviews} variant="dashboard" /> : null
        }
      />
      <FloatingWhatsAppSupport surface="dashboard" />
    </div>
  );
}
