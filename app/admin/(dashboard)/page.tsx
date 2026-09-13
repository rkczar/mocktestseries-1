import Link from "next/link";
import { ReportStatus, DeletionRequestStatus, QuestionStatus, MockTestStatus } from "@prisma/client";
import { Plus, FileWarning, UserX, FileClock } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const metadata = { title: "Dashboard — Mock Test Series.in Admin" };

const QUICK_ACTIONS = [
  { label: "Add student", href: "/admin/students" },
  { label: "Add teacher", href: "/admin/users/admins" },
  { label: "Create exam", href: "/admin/exams" },
  { label: "Add question", href: "/admin/questions/add" },
  { label: "Create mock test", href: "/admin/tests/mock" },
  { label: "Send announcement", href: "/admin/website/announcements" },
  { label: "View deletion requests", href: "/admin/students/deletion-requests" },
  { label: "Manage AI solutions", href: "/admin/ai/solution-manager" },
];

const ACTION_LABELS: Record<string, string> = {
  EXAM_CREATED: "created an exam",
  EXAM_ACTIVATED: "activated an exam",
  EXAM_DEACTIVATED: "deactivated an exam",
  HOMEPAGE_SECTION_TOGGLED: "toggled a homepage section",
  HOMEPAGE_SECTION_UPDATED: "updated a homepage section",
  HOMEPAGE_STATISTICS_REFRESHED: "refreshed homepage statistics",
  HOMEPAGE_PUBLISHED: "published the homepage",
  HOMEPAGE_VERSION_RESTORED: "restored a homepage version",
  HOMEPAGE_SEO_UPDATED: "updated homepage SEO",
  STUDENT_DELETION_APPROVED: "approved a student deletion request",
  STUDENT_DELETION_REJECTED: "rejected a student deletion request",
  ADMIN_USER_CREATED: "created an admin user",
  APPEARANCE_CHANGED: "changed the site appearance",
  AUTH_PROVIDER_GOOGLE_SAVED: "updated Google Sign-In configuration",
  AUTH_PROVIDER_MSG91_SAVED: "updated Phone OTP/SMS configuration",
  AUTH_PROVIDER_GOOGLE_TESTED: "tested the Google Sign-In connection",
  AUTH_PROVIDER_MSG91_TESTED: "tested the Phone OTP/SMS connection",
  AUTH_LOGIN_METHODS_SAVED: "updated login methods",
  API_GEMINI_SAVED: "updated Gemini AI configuration",
  API_GEMINI_TESTED: "tested the Gemini AI connection",
  API_RAZORPAY_SAVED: "updated Razorpay configuration",
  API_RAZORPAY_TESTED: "tested the Razorpay connection",
};

function humanizeAction(action: string): string {
  return ACTION_LABELS[action] ?? action.toLowerCase().replace(/_/g, " ");
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Kept outside the component: computing "now" is an impure call components/hooks must not make directly during render. */
async function loadDashboardData() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    examCount,
    activeExamCount,
    testSeriesCount,
    pypCount,
    studentCount,
    activeStudentCount,
    newStudentCount,
    questionCount,
    draftQuestionCount,
    attemptCount,
    mockTestCount,
    liveMockTestCount,
    aiExplanationCount,
    pendingReportCount,
    pendingDeletionCount,
    publishedHomepage,
    recentReports,
    recentDeletions,
    recentAuditLogs,
  ] = await Promise.all([
    prisma.exam.count(),
    prisma.exam.count({ where: { isActive: true } }),
    prisma.testSeries.count(),
    prisma.previousYearPaper.count(),
    prisma.student.count(),
    prisma.student.count({ where: { lastLoginAt: { gte: sevenDaysAgo } } }),
    prisma.student.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.question.count(),
    prisma.question.count({ where: { status: QuestionStatus.DRAFT } }),
    prisma.testAttempt.count(),
    prisma.mockTest.count(),
    prisma.mockTest.count({ where: { status: MockTestStatus.PUBLISHED } }),
    prisma.aIExplanation.count(),
    prisma.reportedQuestion.count({ where: { status: ReportStatus.OPEN } }),
    prisma.deletionRequest.count({ where: { status: DeletionRequestStatus.PENDING } }),
    prisma.homepageConfig.findFirst({ where: { status: "PUBLISHED" } }),
    prisma.reportedQuestion.findMany({
      where: { status: ReportStatus.OPEN },
      include: { question: { select: { code: true } } },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
    prisma.deletionRequest.findMany({
      where: { status: DeletionRequestStatus.PENDING },
      include: { student: { select: { name: true } } },
      orderBy: { requestedAt: "desc" },
      take: 2,
    }),
    prisma.auditLog.findMany({
      include: { actor: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 6,
    }),
  ]);

  return {
    examCount,
    activeExamCount,
    testSeriesCount,
    pypCount,
    studentCount,
    activeStudentCount,
    newStudentCount,
    questionCount,
    draftQuestionCount,
    attemptCount,
    mockTestCount,
    liveMockTestCount,
    aiExplanationCount,
    pendingReportCount,
    pendingDeletionCount,
    publishedHomepage,
    recentReports,
    recentDeletions,
    recentAuditLogs,
  };
}

export default async function AdminDashboardPage() {
  const {
    examCount,
    activeExamCount,
    testSeriesCount,
    pypCount,
    studentCount,
    activeStudentCount,
    newStudentCount,
    questionCount,
    draftQuestionCount,
    attemptCount,
    mockTestCount,
    liveMockTestCount,
    aiExplanationCount,
    pendingReportCount,
    pendingDeletionCount,
    publishedHomepage,
    recentReports,
    recentDeletions,
    recentAuditLogs,
  } = await loadDashboardData();

  const attentionItems = [
    ...recentReports.map((r) => ({
      key: `report:${r.id}`,
      badge: "REPORT" as const,
      text: `${r.question.code} — reported (${r.reportType.toLowerCase().replace(/_/g, " ")})`,
      at: r.createdAt,
      href: "/admin/questions/reports",
    })),
    ...recentDeletions.map((d) => ({
      key: `deletion:${d.id}`,
      badge: "DELETION" as const,
      text: `Account deletion request from ${d.student.name}`,
      at: d.requestedAt,
      href: "/admin/students/deletion-requests",
    })),
    ...(draftQuestionCount > 0
      ? [
          {
            key: "draft-questions",
            badge: "DRAFT" as const,
            text: `${draftQuestionCount.toLocaleString("en-IN")} questions still in draft`,
            at: null,
            href: "/admin/questions",
          },
        ]
      : []),
  ];

  const badgeStyle: Record<string, string> = {
    REPORT: "bg-[var(--color-error)]/15 text-[var(--color-error)]",
    DELETION: "bg-[var(--color-warning)]/15 text-[var(--color-warning)]",
    DRAFT: "bg-[var(--color-muted-foreground)]/15 text-[var(--color-muted-foreground)]",
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Master Dashboard</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Everything happening on the platform right now — students, tests, questions, AI usage and what needs your
          attention.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Total Students" value={studentCount} />
        <StatCard label="Active Students" value={activeStudentCount} />
        <StatCard label="New Registrations (7d)" value={newStudentCount} />
        <StatCard label="Total Exams" value={examCount} />
        <StatCard label="Active Exams" value={activeExamCount} />
        <StatCard label="Test Series" value={testSeriesCount} />
        <StatCard label="Previous Year Papers" value={pypCount} />
        <StatCard label="Mock Tests" value={mockTestCount} />
        <StatCard label="Live Mock Tests" value={liveMockTestCount} />
        <StatCard label="Total Questions" value={questionCount} />
        <StatCard label="Draft Questions" value={draftQuestionCount} />
        <StatCard label="Tests Attempted" value={attemptCount} />
        <StatCard label="AI Explanations Generated" value={aiExplanationCount} />
        <StatCard label="Pending Question Reports" value={pendingReportCount} />
        <StatCard label="Deletion Requests" value={pendingDeletionCount} />
        <StatCard label="Revenue (MTD)" value={0} connected={false} />
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-[var(--color-foreground)]">Quick actions</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] px-4 py-3 text-sm font-medium text-[var(--color-foreground)] shadow-[var(--shadow-card)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)]"
            >
              <Plus className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden />
              {action.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Needs your attention</CardTitle>
            <CardDescription>Open reports, deletion requests, and content still in draft.</CardDescription>
          </CardHeader>
          <CardContent>
            {attentionItems.length === 0 ? (
              <p className="text-sm text-[var(--color-muted-foreground)]">Nothing needs your attention right now.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--color-border)]">
                {attentionItems.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    className="flex items-center justify-between gap-3 py-2.5 text-sm hover:opacity-80"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`shrink-0 rounded-[var(--radius-badge)] px-2 py-0.5 text-[11px] font-medium ${badgeStyle[item.badge]}`}>
                        {item.badge === "REPORT" ? <FileWarning className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                        {item.badge === "DELETION" ? <UserX className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                        {item.badge === "DRAFT" ? <FileClock className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                        {item.badge}
                      </span>
                      <span className="text-[var(--color-foreground)]">{item.text}</span>
                    </div>
                    <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
                      {item.at ? timeAgo(item.at) : "ongoing"}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
            <CardDescription>Recent admin actions across the platform.</CardDescription>
          </CardHeader>
          <CardContent>
            {recentAuditLogs.length === 0 ? (
              <p className="text-sm text-[var(--color-muted-foreground)]">No audit events yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-[var(--color-border)]">
                {recentAuditLogs.map((log) => (
                  <div key={log.id} className="py-2.5 text-sm">
                    <p className="text-[var(--color-foreground)]">
                      <span className="font-medium">{log.actor?.name ?? "Unknown admin"}</span> {humanizeAction(log.action)}
                    </p>
                    <p className="text-xs text-[var(--color-muted-foreground)]">{timeAgo(log.createdAt)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Homepage status</CardTitle>
          <CardDescription>Admin → Website → Homepage</CardDescription>
        </CardHeader>
        <CardContent>
          {publishedHomepage ? (
            <p className="text-sm text-[var(--color-foreground)]">
              Version {publishedHomepage.version} is live, published{" "}
              {publishedHomepage.publishedAt?.toLocaleString("en-IN") ?? "—"}.
            </p>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No homepage has been published yet. Go to the Homepage builder to configure and publish one.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
