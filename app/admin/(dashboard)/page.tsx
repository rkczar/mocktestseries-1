import Link from "next/link";
import { ReportStatus, DeletionRequestStatus, QuestionStatus, MockTestStatus } from "@prisma/client";
import { Plus, FileWarning, UserX, FileClock, Inbox, Users, Radio } from "lucide-react";
import { HardDrive } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { StatCard } from "@/components/admin/stat-card";
import { PlatformStatusStrip } from "@/components/admin/platform-status-strip";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { getStorageSnapshot, formatBytes } from "@/lib/storage-stats";
import { formatInr } from "@/lib/payments/money";
import { dashboardAiCardNodes } from "@/components/admin/ai/dashboard-ai-cards";
import { DashboardGrid, type DashboardGridItem } from "@/components/admin/dashboard-grid";
import { Badge } from "@/components/ui/badge";
import { getAdminSession } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { istStartOfDay } from "@/lib/ist-time";
import { DASHBOARD_CARDS, applyDashboardOrder, dashboardLayoutKey, sanitizeDashboardOrder } from "@/lib/admin-dashboard-layout";
import {
  ONLINE_WINDOW_MINUTES,
  getActionRequired,
  getCommunicationsSummary,
  getLiveActivity,
  getMultipleSessions,
  type ActionItem,
} from "@/lib/admin-dashboard-metrics";

/** Paid LIVE-environment order value since the 1st of the current IST month (TEST orders excluded). */
async function getRevenueMtdPaise(): Promise<number> {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const monthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600_000);
  const r = await prisma.paymentOrder.aggregate({
    where: { environment: "LIVE", status: { in: ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"] }, paidAt: { gte: monthStart } },
    _sum: { amountPaise: true },
  });
  return r._sum.amountPaise ?? 0;
}

export const metadata = { title: "Dashboard — Mock Test Series.in Admin" };

const QUICK_ACTIONS = [
  { label: "Add student", href: "/admin/students" },
  { label: "Add teacher", href: "/admin/users/admins" },
  { label: "Create exam", href: "/admin/exams" },
  { label: "Add question", href: "/admin/questions/add" },
  { label: "Create mock test", href: "/admin/tests/mock" },
  { label: "Manage test series", href: "/admin/exams/test-series" },
  { label: "Manage schedule", href: "/admin/tests/scheduled" },
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
  STUDENT_DELETION_REQUESTED: "requested account deletion",
  STUDENT_IDENTITY_ANONYMIZED: "anonymized a deleted student's identity",
  STUDENT_AUTH_REVOKED: "revoked a deleted student's sessions",
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
  PAYMENT_MODE_CHANGED: "changed the payment mode",
  PRODUCT_CREATED: "created a product",
  PRODUCT_UPDATED: "updated product pricing",
  COUPON_CREATED: "created a coupon",
  COUPON_UPDATED: "updated a coupon",
  COUPON_DEACTIVATED: "deactivated a coupon",
  GATEWAY_CREDENTIALS_UPDATED: "updated Razorpay gateway settings",
  GATEWAY_TESTED: "tested the Razorpay connection",
  ENTITLEMENT_GRANTED: "granted student access",
  ENTITLEMENT_REVOKED: "revoked student access",
  REFUND_REQUESTED: "requested a refund",
  INVOICE_SETTINGS_UPDATED: "updated invoice settings",
  PAYMENT_POLICY_UPDATED: "updated the payment policy",
  ORDER_RECONCILED: "reconciled an order",
  PLATFORM_CONTROL_CHANGED: "changed a platform control",
  ADMIN_USER_UPDATED: "updated an admin user",
  ADMIN_ROLE_CHANGED: "changed an admin's role",
  ADMIN_PASSWORD_RESET: "reset an admin's password",
  ADMIN_USER_ACTIVATED: "enabled an admin account",
  ADMIN_USER_DEACTIVATED: "disabled an admin account",
  ADMIN_REAUTH_FAILED: "failed a password re-check",
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
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // "Today" is the IST calendar day (the server clock is UTC).
  const startOfToday = istStartOfDay(now);

  const [
    examCount,
    activeExamCount,
    testSeriesCount,
    activeTestSeriesCount,
    pypCount,
    activeStudentCount,
    newStudentCount,
    questionCount,
    draftQuestionCount,
    attemptCount,
    mockTestCount,
    liveMockTestCount,
    availableTestCount,
    upcomingTestCount,
    nextScheduledTest,
    attemptsTodayCount,
    recentSubmissionCount,
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
    prisma.testSeries.count({ where: { status: "PUBLISHED" } }),
    prisma.previousYearPaper.count(),
    prisma.student.count({ where: { lastLoginAt: { gte: sevenDaysAgo } } }),
    prisma.student.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.question.count(),
    prisma.question.count({ where: { status: QuestionStatus.DRAFT } }),
    prisma.testAttempt.count(),
    prisma.mockTest.count(),
    prisma.mockTest.count({ where: { status: MockTestStatus.PUBLISHED } }),
    prisma.mockTest.count({
      where: { status: MockTestStatus.PUBLISHED, OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
    }),
    prisma.mockTest.count({ where: { status: MockTestStatus.PUBLISHED, availableFrom: { gt: now } } }),
    prisma.mockTest.findFirst({
      where: { status: MockTestStatus.PUBLISHED, availableFrom: { gt: now } },
      orderBy: { availableFrom: "asc" },
      select: { title: true, availableFrom: true },
    }),
    prisma.testAttempt.count({ where: { startedAt: { gte: startOfToday } } }),
    prisma.testAttempt.count({ where: { status: "SUBMITTED", submittedAt: { gte: oneDayAgo } } }),
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
      select: { id: true, requestedAt: true, studentNameSnapshot: true, studentCodeSnapshot: true },
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
    activeTestSeriesCount,
    pypCount,
    activeStudentCount,
    newStudentCount,
    questionCount,
    draftQuestionCount,
    attemptCount,
    mockTestCount,
    liveMockTestCount,
    availableTestCount,
    upcomingTestCount,
    nextScheduledTest,
    attemptsTodayCount,
    recentSubmissionCount,
    aiExplanationCount,
    pendingReportCount,
    pendingDeletionCount,
    publishedHomepage,
    recentReports,
    recentDeletions,
    recentAuditLogs,
  };
}

const PRIORITY_BADGE: Record<ActionItem["priority"], { variant: "error" | "warning" | "neutral"; label: string }> = {
  urgent: { variant: "error", label: "Urgent" },
  attention: { variant: "warning", label: "Attention" },
  none: { variant: "neutral", label: "Clear" },
};

const CARD_LINK =
  "block rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-card)] transition-colors hover:bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)]";

function CountBadge({ count, tone }: { count: number; tone: "urgent" | "attention" | "none" }) {
  const cls =
    tone === "urgent"
      ? "bg-[var(--color-error)] text-white"
      : tone === "attention"
        ? "bg-[var(--color-warning)] text-[#1a1a1a]"
        : "bg-[color-mix(in_srgb,var(--color-foreground)_10%,transparent)] text-[var(--color-muted-foreground)]";
  return <span className={`inline-flex min-w-6 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${cls}`}>{count.toLocaleString("en-IN")}</span>;
}

export default async function AdminDashboardPage() {
  const session = await getAdminSession();
  const perms = new Set<string>(session?.user?.permissions ?? []);
  const can = {
    payments: perms.has(PERMISSIONS.PAYMENTS_VIEW),
    backup: perms.has(PERMISSIONS.BACKUP_VIEW),
    deletion: perms.has(PERMISSIONS.STUDENT_DELETION_VIEW),
    communications: perms.has(PERMISSIONS.COMMUNICATIONS_VIEW),
    recovery: perms.has(PERMISSIONS.ACCOUNT_RECOVERY_VIEW),
    // Same gate as Admin → Monitoring → Authentication, where the detail lives.
    sessions: perms.has(PERMISSIONS.SETTINGS_MANAGE),
  };

  const {
    examCount,
    activeExamCount,
    testSeriesCount,
    activeTestSeriesCount,
    pypCount,
    activeStudentCount: signedIn7d,
    newStudentCount,
    questionCount,
    draftQuestionCount,
    attemptCount,
    mockTestCount,
    liveMockTestCount,
    availableTestCount,
    upcomingTestCount,
    nextScheduledTest,
    attemptsTodayCount,
    recentSubmissionCount,
    aiExplanationCount,
    pendingReportCount,
    pendingDeletionCount,
    publishedHomepage,
    recentReports,
    recentDeletions,
    recentAuditLogs,
  } = await loadDashboardData();
  const now = new Date();
  const [storage, revenueMtdPaise, live, comms, multi, actions, aiCards, savedLayout] = await Promise.all([
    can.backup ? getStorageSnapshot() : Promise.resolve(null),
    can.payments ? getRevenueMtdPaise() : Promise.resolve(0),
    getLiveActivity(now),
    can.communications ? getCommunicationsSummary() : Promise.resolve(null),
    can.sessions ? getMultipleSessions(now, 0) : Promise.resolve(null),
    getActionRequired({ communications: can.communications, reports: true, deletion: can.deletion, recovery: can.recovery, payments: can.payments }, now),
    dashboardAiCardNodes(),
    session?.user?.id ? prisma.setting.findUnique({ where: { key: dashboardLayoutKey(session.user.id) } }) : Promise.resolve(null),
  ]);
  const diskUsedPercent =
    storage?.filesystem.totalBytes && storage.filesystem.usedBytes ? Math.round((storage.filesystem.usedBytes / storage.filesystem.totalBytes) * 100) : null;

  const attentionItems = [
    ...recentReports.map((r) => ({
      key: `report:${r.id}`,
      badge: "REPORT" as const,
      text: `${r.question.code} — reported (${r.reportType.toLowerCase().replace(/_/g, " ")})`,
      at: r.createdAt,
      href: "/admin/questions/reports",
    })),
    ...(can.deletion
      ? recentDeletions.map((d) => ({
          key: `deletion:${d.id}`,
          badge: "DELETION" as const,
          text: `Account deletion request from ${d.studentNameSnapshot ?? d.studentCodeSnapshot ?? "a student"}`,
          at: d.requestedAt,
          href: `/admin/students/deletion-requests/${d.id}`,
        }))
      : []),
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

  const actionPending = actions.reduce((s, a) => s + a.pending, 0);
  const cards: Record<string, React.ReactNode> = {
    "action-required": (
      <Card data-testid="action-required">
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Action Required</CardTitle>
            <CardDescription>Open items across your queues. Opening a queue never resolves anything — items clear only when they are handled there.</CardDescription>
          </div>
          <CountBadge count={actionPending} tone={actions.some((a) => a.priority === "urgent") ? "urgent" : actionPending ? "attention" : "none"} />
        </CardHeader>
        <CardContent>
          {actions.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No queues available for your role.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {actions.map((a) => (
                <li key={a.key}>
                  <Link
                    href={a.href}
                    className="flex items-start justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2.5 text-sm hover:bg-[color-mix(in_srgb,var(--color-foreground)_5%,transparent)]"
                    data-testid={`action-${a.key}`}
                    data-priority={a.priority}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 font-medium text-[var(--color-foreground)]">
                        {a.label} <Badge variant={PRIORITY_BADGE[a.priority].variant}>{PRIORITY_BADGE[a.priority].label}</Badge>
                      </span>
                      <span className="block text-xs text-[var(--color-muted-foreground)]">{a.detail}</span>
                    </span>
                    <CountBadge count={a.pending} tone={a.priority} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    ),
    "total-students": (
      <Link href="/admin/students" className={CARD_LINK}>
        <StatCard
          label="Total Students"
          value={live.totalStudents}
          hint={live.deletedStudents ? `Registered accounts · ${live.deletedStudents} deleted (anonymized) account${live.deletedStudents === 1 ? "" : "s"} not counted` : "Registered accounts"}
        />
      </Link>
    ),
    "online-now": (
      <Card data-testid="online-now">
        <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">Online Now</CardTitle>
          <Radio className={`h-3.5 w-3.5 ${live.onlineNow ? "text-[var(--color-success)]" : "text-[var(--color-muted-foreground)]"}`} aria-hidden />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold text-[var(--color-foreground)]">{live.onlineNow}</p>
          <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">
            Students with signed-in activity in the last {ONLINE_WINDOW_MINUTES} min (server-side; tabs in one browser count once) · last 24h: {live.active24h}
          </p>
        </CardContent>
      </Card>
    ),
    "active-students": (
      <StatCard
        label="Active Students (7d)"
        value={live.active7d}
        hint={`Signed in, took a test or used the site while signed in during the last 7 days · new sign-ins only: ${signedIn7d}`}
      />
    ),
    "new-registrations": <StatCard label="New Registrations (7d)" value={newStudentCount} />,
    "total-exams": <StatCard label="Total Exams" value={examCount} />,
    "active-exams": <StatCard label="Active Exams" value={activeExamCount} />,
    "test-series": <StatCard label="Test Series" value={testSeriesCount} />,
    "active-test-series": <StatCard label="Active Test Series" value={activeTestSeriesCount} />,
    "pyq-papers": <StatCard label="Previous Year Papers" value={pypCount} />,
    "mock-tests": <StatCard label="Mock Tests" value={mockTestCount} />,
    "live-mock-tests": <StatCard label="Live Mock Tests" value={liveMockTestCount} hint="Published mock tests" />,
    "available-tests": <StatCard label="Available Tests" value={availableTestCount} />,
    "upcoming-tests": <StatCard label="Upcoming Tests" value={upcomingTestCount} />,
    "next-scheduled-test": <StatCard label="Next Scheduled Test" value={nextScheduledTest ? nextScheduledTest.title : "—"} />,
    "attempts-today": <StatCard label="Attempts Today" value={attemptsTodayCount} hint="Started since 00:00 IST" />,
    "submissions-24h": <StatCard label="Submissions (24h)" value={recentSubmissionCount} />,
    "total-questions": <StatCard label="Total Questions" value={questionCount} />,
    "draft-questions": <StatCard label="Draft Questions" value={draftQuestionCount} />,
    "tests-attempted": <StatCard label="Tests Attempted" value={attemptCount} />,
    "ai-explanations": <StatCard label="AI Explanations Generated" value={aiExplanationCount} />,
    "pending-reports": (
      <Link href="/admin/questions/reports" className={CARD_LINK}>
        <StatCard label="Pending Question Reports" value={pendingReportCount} />
      </Link>
    ),
    "quick-actions": (
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
    ),
    "needs-attention": (
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
                <Link key={item.key} href={item.href} className="flex items-center justify-between gap-3 py-2.5 text-sm hover:opacity-80">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 rounded-[var(--radius-badge)] px-2 py-0.5 text-[11px] font-medium ${badgeStyle[item.badge]}`}>
                      {item.badge === "REPORT" ? <FileWarning className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                      {item.badge === "DELETION" ? <UserX className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                      {item.badge === "DRAFT" ? <FileClock className="mr-1 inline h-3 w-3" aria-hidden /> : null}
                      {item.badge}
                    </span>
                    <span className="text-[var(--color-foreground)]">{item.text}</span>
                  </div>
                  <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">{item.at ? timeAgo(item.at) : "ongoing"}</span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    ),
    "audit-log": (
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
                    <span className="font-medium">{log.actor?.name ?? (log.action === "STUDENT_DELETION_REQUESTED" ? "A student" : "Unknown admin")}</span> {humanizeAction(log.action)}
                  </p>
                  <p className="text-xs text-[var(--color-muted-foreground)]">{timeAgo(log.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    ),
    "homepage-status": (
      <Card>
        <CardHeader>
          <CardTitle>Homepage status</CardTitle>
          <CardDescription>Admin → Website → Homepage</CardDescription>
        </CardHeader>
        <CardContent>
          {publishedHomepage ? (
            <p className="text-sm text-[var(--color-foreground)]">
              Version {publishedHomepage.version} is live, published {publishedHomepage.publishedAt?.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) ?? "—"}.
            </p>
          ) : (
            <p className="text-sm text-[var(--color-muted-foreground)]">No homepage has been published yet. Go to the Homepage builder to configure and publish one.</p>
          )}
        </CardContent>
      </Card>
    ),
  };

  if (aiCards) {
    cards["ai-usage"] = aiCards.usage;
    cards["ai-cost"] = aiCards.cost;
    cards["ai-month"] = aiCards.month;
  }
  if (can.deletion)
    cards["deletion-requests"] = (
      <Link href="/admin/students?tab=deletion-requests" className={CARD_LINK}>
        <StatCard label="Deletion Requests" value={pendingDeletionCount} />
      </Link>
    );
  if (can.payments)
    cards["revenue-mtd"] = (
      <Link href="/admin/payments?tab=revenue" className={CARD_LINK}>
        <StatCard label="Revenue (MTD, LIVE)" value={formatInr(revenueMtdPaise)} />
      </Link>
    );
  if (comms) {
    const pending = comms.contactPending + comms.growPending;
    const tone = comms.unread ? "urgent" : pending ? "attention" : "none";
    cards["communications"] = (
      <Card data-testid="communications-card" data-tone={tone}>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">
            <Link href="/admin/communications?tab=inbox" className="hover:underline">
              Communications
            </Link>
          </CardTitle>
          <Inbox className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
          <Link href="/admin/communications?tab=inbox" className="flex items-center gap-2 text-2xl font-semibold text-[var(--color-foreground)]">
            {pending} <span className="text-sm font-normal text-[var(--color-muted-foreground)]">pending</span>
            <CountBadge count={comms.unread} tone={comms.unread ? "urgent" : "none"} />
            <span className="sr-only">unread</span>
          </Link>
          <ul className="flex flex-col gap-1 text-xs">
            {(
              [
                ["Unread", comms.unread, comms.unread ? "urgent" : "none", "/admin/communications?tab=inbox"],
                ["Contact", comms.contactPending, comms.contactUnread ? "urgent" : comms.contactPending ? "attention" : "none", "/admin/communications?tab=contact"],
                ["Grow With Us", comms.growPending, comms.growUnread ? "urgent" : comms.growPending ? "attention" : "none", "/admin/communications?tab=grow-with-us"],
                ["From signed-in students", comms.fromStudentsPending, comms.fromStudentsPending ? "attention" : "none", "/admin/communications?tab=inbox"],
              ] as const
            ).map(([label, n, t, href]) => (
              <li key={label}>
                <Link href={href} className="flex items-center justify-between gap-2 hover:underline" data-testid={`comms-${label.toLowerCase().replace(/\W+/g, "-")}`}>
                  <span className="text-[var(--color-muted-foreground)]">{label}</span>
                  <CountBadge count={n} tone={t} />
                </Link>
              </li>
            ))}
          </ul>
          {comms.oldestPendingAt ? <p className="text-[11px] text-[var(--color-muted-foreground)]">Oldest waiting: {timeAgo(comms.oldestPendingAt)}</p> : null}
        </CardContent>
      </Card>
    );
  }
  if (multi)
    cards["multiple-sessions"] = (
      <Link href="/admin/monitoring/authentication#multiple-sessions" className={CARD_LINK} data-testid="multi-sessions-card">
        <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">Multiple Active Sessions</CardTitle>
          <Users className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold text-[var(--color-foreground)]">
            {multi.twoPlus} <span className="text-sm font-normal text-[var(--color-muted-foreground)]">students with 2+</span>
          </p>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-[var(--color-muted-foreground)]">
            <dt>3 or more</dt>
            <dd className="text-right text-[var(--color-foreground)]">{multi.threePlus}</dd>
            <dt>Highest count</dt>
            <dd className="text-right text-[var(--color-foreground)]">{multi.highest || "—"}</dd>
          </dl>
          <p className="mt-1 text-[11px] text-[var(--color-muted-foreground)]">Signed-in sessions used in the last {multi.windowHours}h · display only, nothing is blocked</p>
          <p className="mt-1 text-xs text-[var(--color-primary)]">Security monitoring →</p>
        </CardContent>
      </Link>
    );
  if (storage)
    cards["vps-storage"] = (
      <Link href="/admin/backup" className={CARD_LINK}>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-1">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-[var(--color-muted-foreground)]">VPS Storage</CardTitle>
          <HardDrive className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold text-[var(--color-foreground)]">
            {formatBytes(storage.filesystem.usedBytes)}
            {storage.filesystem.totalBytes ? <span className="text-sm font-normal text-[var(--color-muted-foreground)]"> / {formatBytes(storage.filesystem.totalBytes)}</span> : null}
            {diskUsedPercent != null ? <span className="ml-1 text-sm font-normal text-[var(--color-muted-foreground)]">({diskUsedPercent}%)</span> : null}
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-muted-foreground)]">
            <dt>Available</dt>
            <dd className="text-right text-[var(--color-foreground)]">{formatBytes(storage.filesystem.availBytes)}</dd>
            <dt>Release storage</dt>
            <dd className="text-right text-[var(--color-foreground)]">{formatBytes(storage.view.releases.all)}</dd>
            <dt>Backup storage</dt>
            <dd className="text-right text-[var(--color-foreground)]">{formatBytes(storage.view.backups.total)}</dd>
            <dt>Reclaimable</dt>
            <dd className="text-right text-[var(--color-foreground)]">{formatBytes(storage.view.releases.reclaimable + storage.view.backups.reclaimable)}</dd>
          </dl>
          <p className="mt-2 text-xs text-[var(--color-primary)]">Manage Storage →</p>
        </CardContent>
      </Link>
    );

  const items: DashboardGridItem[] = DASHBOARD_CARDS.filter((c) => cards[c.id] !== undefined).map((c) => ({ id: c.id, label: c.label, size: c.size, node: cards[c.id] }));
  const saved = sanitizeDashboardOrder((savedLayout?.value as { order?: unknown } | null)?.order);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Master Dashboard</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Everything happening on the platform right now — students, tests, questions, AI usage and what needs your attention.
        </p>
        <PlatformStatusStrip className="mt-3" />
      </div>
      <DashboardGrid items={applyDashboardOrder(items, saved)} renderedAt={now.toISOString()} />
    </div>
  );
}
