import { requireStudent } from "@/lib/student-session";
import { isMockResultReleased, mockResultReleaseInstant } from "@/lib/mock-test-schedule";
import { getScheduledMockTestsForStudent } from "@/lib/student-data";
import { prisma } from "@/lib/prisma";
import { loadAccessContext, evaluateContentAccess, paywallHref } from "@/lib/payments/access";
import { BackButton } from "@/components/student/back-button";
import { TestSeriesExplorer, type ExplorerGroup } from "./test-series-explorer";

const COVERAGE_LABELS = { FULL_SYLLABUS: "Full Syllabus", PARTIAL_SYLLABUS: "Partial Syllabus", SUBJECT_WISE: "Subject-wise" } as const;

export const metadata = { title: "Test Series — Mock Test Series.in" };

export default async function TestSeriesPage() {
  const student = await requireStudent();
  const { groups } = await getScheduledMockTestsForStudent(student.id);

  const mockTestIds = groups.flatMap((g) => g.tests.map((t) => t.mockTest.id));
  const paperResources = await prisma.testResource.findMany({
    where: { type: "PAPER_PDF", isActive: true, mockTestId: { in: mockTestIds } },
    select: { id: true, mockTestId: true },
  });
  const paperResourceByMockTest = new Map(paperResources.map((r) => [r.mockTestId, r.id]));
  const accessCtx = await loadAccessContext(student.id);
  const lockFor = (mt: { id: string; examId: string; testSeriesId: string | null; accessType: "FREE" | "PAID" }) => {
    const a = evaluateContentAccess(accessCtx, { kind: "MOCK_TEST", id: mt.id, examId: mt.examId, testSeriesId: mt.testSeriesId, accessType: mt.accessType });
    if (a.allowed) return null;
    return {
      status: a.status as "PAYMENT_REQUIRED" | "EXPIRED" | "NOT_AVAILABLE",
      href: a.status === "NOT_AVAILABLE" || a.purchasesPaused ? null : paywallHref(a),
    };
  };

  const explorerGroups: ExplorerGroup[] = groups.map((g) => ({
    seriesId: g.series?.id ?? null,
    seriesName: g.series?.name ?? "Standalone Mock Tests",
    seriesDescription: g.series?.description ?? null,
    tests: g.tests.map((row) => ({
      id: row.mockTest.id,
      title: row.mockTest.title,
      testNumber: row.mockTest.testSeriesId ? row.mockTest.order : null,
      coverageLabel: COVERAGE_LABELS[row.mockTest.coverageType],
      examName: row.mockTest.exam.name,
      questionCount: row.mockTest._count.questions,
      durationMinutes: row.mockTest.durationMinutes,
      availableFrom: row.mockTest.availableFrom ? row.mockTest.availableFrom.toISOString() : null,
      availableUntil: row.mockTest.availableUntil ? row.mockTest.availableUntil.toISOString() : null,
      availability: row.availability,
      resultPending: row.hasSubmittedAttempt && !isMockResultReleased(row.mockTest),
      resultReleaseAt: mockResultReleaseInstant(row.mockTest)?.toISOString() ?? null,
      attemptPolicy: row.mockTest.attemptPolicy,
      bestScore: row.bestScore,
      latestAttempt: row.latestAttempt,
      hasSubmittedAttempt: row.hasSubmittedAttempt,
      paperResourceId: paperResourceByMockTest.get(row.mockTest.id) ?? null,
      lock: lockFor(row.mockTest),
    })),
  }));

  return (
    <div className="flex flex-col gap-6">
      <BackButton href="/student/dashboard" />
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-foreground)]">Test Series</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Scheduled mock tests from Admin. Times are shown in IST — once a test becomes available it stays open, so
          you can take it anytime afterward.
        </p>
      </div>

      <TestSeriesExplorer groups={explorerGroups} />
    </div>
  );
}
