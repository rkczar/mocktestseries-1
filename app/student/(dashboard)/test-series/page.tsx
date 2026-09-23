import { requireStudent } from "@/lib/student-session";
import { getScheduledMockTestsForStudent } from "@/lib/student-data";
import { prisma } from "@/lib/prisma";
import { BackButton } from "@/components/student/back-button";
import { TestSeriesExplorer, type ExplorerGroup } from "./test-series-explorer";

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

  const explorerGroups: ExplorerGroup[] = groups.map((g) => ({
    seriesId: g.series?.id ?? null,
    seriesName: g.series?.name ?? "Standalone Mock Tests",
    seriesDescription: g.series?.description ?? null,
    tests: g.tests.map((row) => ({
      id: row.mockTest.id,
      title: row.mockTest.title,
      examName: row.mockTest.exam.name,
      questionCount: row.mockTest._count.questions,
      durationMinutes: row.mockTest.durationMinutes,
      availableFrom: row.mockTest.availableFrom ? row.mockTest.availableFrom.toISOString() : null,
      availability: row.availability,
      attemptPolicy: row.mockTest.attemptPolicy,
      bestScore: row.bestScore,
      latestAttempt: row.latestAttempt,
      hasSubmittedAttempt: row.hasSubmittedAttempt,
      paperResourceId: paperResourceByMockTest.get(row.mockTest.id) ?? null,
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
