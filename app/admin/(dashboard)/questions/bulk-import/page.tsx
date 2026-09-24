import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { formatIst } from "@/lib/ist-time";
import { AVAILABILITY_LABELS, deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { BulkImportWorkspace, type ImportContext, type ImportTarget, type MockTargetOption } from "./bulk-import-workspace";

/**
 * The one Bulk Import engine. Reached plainly from Question Bank → Bulk
 * Import (Import Target: Question Bank Only / Previous Year Paper / Mock
 * Test), or from Mock Test → Questions → Bulk Import Questions, which passes
 * ?examId=&target=MOCK_TEST&mockTestId=&from=mock so the Exam and Target
 * arrive pre-selected and locked. Every non-archived Mock Test is offered —
 * including scheduled/upcoming ones with no questions yet — and the
 * workspace narrows the list to the selected Exam.
 */
export default async function BulkImportPage({
  searchParams,
}: {
  searchParams: Promise<{ examId?: string; target?: string; mockTestId?: string; from?: string }>;
}) {
  const params = await searchParams;
  const [exams, papers, mocks, canTargetMock] = await Promise.all([
    prisma.exam.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, year: true },
    }),
    prisma.previousYearPaper.findMany({
      orderBy: [{ year: "desc" }, { title: "asc" }],
      select: { id: true, examId: true, year: true, title: true, paperCode: true },
    }),
    prisma.mockTest.findMany({
      where: { status: { not: "ARCHIVED" } },
      orderBy: [{ testSeriesId: "asc" }, { order: "asc" }],
      select: {
        id: true,
        examId: true,
        order: true,
        title: true,
        status: true,
        availableFrom: true,
        availableUntil: true,
        targetQuestionCount: true,
        testSeries: { select: { name: true } },
        _count: { select: { questions: true } },
      },
    }),
    hasPermission(PERMISSIONS.TEST_SERIES_MANAGE),
  ]);

  const now = new Date();
  const mockTests: MockTargetOption[] = mocks.map((m) => {
    const state = deriveMockTestAvailability(m, now);
    const when =
      state === "UPCOMING" && m.availableFrom ? ` · ${formatIst(m.availableFrom)}` : state === "LIVE_NOW" && m.availableUntil ? ` · ends ${formatIst(m.availableUntil)}` : "";
    return {
      id: m.id,
      examId: m.examId,
      order: m.order,
      title: m.title,
      status: m.status,
      seriesName: m.testSeries?.name ?? null,
      questionCount: m._count.questions,
      expected: m.targetQuestionCount,
      scheduleLabel: `${AVAILABILITY_LABELS[state]}${when}`,
    };
  });

  // Context from the Mock Test editor is only honored when it is internally
  // consistent (the test exists) and the admin may attach to tests;
  // otherwise the page opens as a plain Question Bank import.
  const linkedMock = params.target === "MOCK_TEST" && canTargetMock ? mockTests.find((m) => m.id === params.mockTestId) : undefined;
  const plainTarget: ImportTarget = params.target === "PREVIOUS_YEAR_PAPER" ? "PREVIOUS_YEAR_PAPER" : "QUESTION_BANK";
  const initial: ImportContext = linkedMock
    ? { examId: linkedMock.examId, target: "MOCK_TEST", mockTestId: linkedMock.id, fromMock: params.from === "mock" }
    : { examId: exams.some((e) => e.id === params.examId) ? params.examId! : "", target: plainTarget, mockTestId: "", fromMock: false };

  return <BulkImportWorkspace exams={exams} papers={papers} mockTests={mockTests} canTargetMock={canTargetMock} initial={initial} />;
}
