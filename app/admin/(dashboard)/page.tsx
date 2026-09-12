import { ReportStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { StatCard } from "@/components/admin/stat-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const metadata = { title: "Dashboard — Mock Test Series.in Admin" };

export default async function AdminDashboardPage() {
  const [
    examCount,
    activeExamCount,
    testSeriesCount,
    pypCount,
    adminUserCount,
    publishedHomepage,
    studentCount,
    questionCount,
    attemptCount,
    pendingReportCount,
  ] = await Promise.all([
    prisma.exam.count(),
    prisma.exam.count({ where: { isActive: true } }),
    prisma.testSeries.count(),
    prisma.previousYearPaper.count(),
    prisma.adminUser.count(),
    prisma.homepageConfig.findFirst({ where: { status: "PUBLISHED" } }),
    prisma.student.count(),
    prisma.question.count(),
    prisma.testAttempt.count(),
    prisma.reportedQuestion.count({ where: { status: ReportStatus.OPEN } }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Dashboard</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">Website Overview</p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <StatCard label="Total Exams" value={examCount} />
        <StatCard label="Active Exams" value={activeExamCount} />
        <StatCard label="Test Series" value={testSeriesCount} />
        <StatCard label="Previous Year Papers" value={pypCount} />
        <StatCard label="Admin Users" value={adminUserCount} />
        <StatCard label="Total Students" value={studentCount} />
        <StatCard label="Total Questions" value={questionCount} />
        <StatCard label="Total Test Attempts" value={attemptCount} />
        <StatCard label="Pending Question Reports" value={pendingReportCount} />
        <StatCard label="Today's Revenue" value={0} connected={false} />
        <StatCard label="AI Answers Generated" value={0} connected={false} />
        <StatCard label="Pending AI Work" value={0} connected={false} />
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
