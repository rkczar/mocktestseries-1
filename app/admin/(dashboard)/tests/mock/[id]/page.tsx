import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { QuestionStatus } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MockQuestionPicker } from "@/components/admin/mock-question-picker";
import { TestResourceManager } from "@/components/admin/test-resource-manager";
import { toIstDateTimeLocalValue } from "@/lib/ist-time";
import { deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { mockSeriesPath } from "@/lib/mock-series";
import { syncMockTestQuestionsAction } from "../actions";
import { ScheduleForm } from "./schedule-form";
import { MockDetailsForm } from "../mock-details-form";
import { MockTestStatusSelect } from "../status-select";

export const metadata = { title: "Mock Test — Mock Test Series.in Admin" };

/**
 * Canonical Mock Test editor, reached from Admin → Exams → Test Series →
 * [series] → Mock Tests. Details & coverage, questions, schedule, resources
 * and publication all live here — no second editing location.
 */
export default async function MockTestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { id } = await params;
  const { created } = await searchParams;

  const mockTest = await prisma.mockTest.findUnique({
    where: { id },
    include: {
      exam: true,
      testSeries: true,
      questions: { orderBy: { order: "asc" }, select: { questionId: true } },
      resources: { where: { type: { in: ["PAPER_PDF", "SOLUTION_PDF"] } }, orderBy: { createdAt: "desc" } },
      _count: { select: { testAttempts: true } },
    },
  });
  if (!mockTest) notFound();

  const [questions, subjects] = await Promise.all([
    prisma.question.findMany({
      where: { examId: mockTest.examId, status: QuestionStatus.PUBLISHED },
      select: {
        id: true,
        code: true,
        text: true,
        difficulty: true,
        source: true,
        previousYearPaperId: true,
        subject: { select: { id: true, name: true } },
        topic: { select: { id: true, name: true } },
        subTopic: { select: { name: true } },
        previousYearPaper: { select: { year: true } },
      },
      orderBy: [{ subject: { order: "asc" } }, { createdAt: "asc" }],
    }),
    prisma.subject.findMany({
      where: { examId: mockTest.examId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, topics: { orderBy: { order: "asc" }, select: { id: true, name: true } } },
    }),
  ]);

  const availability = mockTest.status === "PUBLISHED" ? deriveMockTestAvailability(mockTest) : null;
  const seriesHref = mockTest.testSeries ? `/admin/exams/test-series/${mockTest.testSeries.id}` : null;
  const publicHref = mockTest.testSeries?.status === "PUBLISHED" && mockTest.exam.publicSlug ? mockSeriesPath(mockTest.exam.publicSlug) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-[var(--color-muted-foreground)]">
          <Link href="/admin/exams" className="hover:underline">Exams</Link> ›{" "}
          <Link href="/admin/exams/test-series" className="hover:underline">Test Series</Link>
          {seriesHref ? (
            <>
              {" "}›{" "}
              <Link href={seriesHref} className="hover:underline">
                {mockTest.testSeries!.name}
              </Link>
            </>
          ) : null}{" "}
          › Mock {mockTest.order}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{mockTest.title}</h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {mockTest.exam.name} · {mockTest.durationMinutes} min · {mockTest.questions.length} questions · {mockTest._count.testAttempts} attempts
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {availability ? <Badge variant={availability === "AVAILABLE" ? "success" : "info"}>{availability}</Badge> : null}
            <Badge variant={mockTest.accessType === "FREE" ? "primary" : "neutral"}>{mockTest.accessType}</Badge>
            <MockTestStatusSelect mockTestId={mockTest.id} status={mockTest.status} />
            {publicHref ? (
              <Link href={publicHref} target="_blank" className="text-sm text-[var(--color-primary)] hover:underline">
                View public page ↗
              </Link>
            ) : null}
          </div>
        </div>
        {created ? (
          <p className="rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)]">
            Draft saved. Next: assign questions below, set the release date, then switch status to Published.
          </p>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details &amp; Coverage</CardTitle>
          <CardDescription>Test number, title, timing, FREE/PAID access and what students are told this test covers.</CardDescription>
        </CardHeader>
        <CardContent>
          <MockDetailsForm
            mockTestId={mockTest.id}
            subjects={subjects}
            values={{
              title: mockTest.title,
              order: mockTest.order,
              description: mockTest.description,
              durationMinutes: mockTest.durationMinutes,
              negativeMarking: mockTest.negativeMarking,
              instructions: mockTest.instructions,
              accessType: mockTest.accessType,
              targetQuestionCount: mockTest.targetQuestionCount,
              coverageType: mockTest.coverageType,
              coverageSubjectIds: mockTest.coverageSubjectIds,
              coverageTopicIds: mockTest.coverageTopicIds,
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Questions</CardTitle>
          <CardDescription>
            Published questions from {mockTest.exam.name}. Filter, bulk-select, then reorder — the saved order is the order students see.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MockQuestionPicker
            questions={questions.map((q) => ({
              id: q.id,
              code: q.code,
              text: q.text,
              subjectId: q.subject.id,
              subjectName: q.subject.name,
              topicId: q.topic?.id ?? null,
              topicName: q.topic?.name ?? null,
              subTopicName: q.subTopic?.name ?? null,
              difficulty: q.difficulty,
              isPyq: q.source === "PYQ" || q.previousYearPaperId !== null,
              paperLabel: q.previousYearPaper ? String(q.previousYearPaper.year) : null,
            }))}
            initiallySelected={mockTest.questions.map((q) => q.questionId)}
            target={mockTest.targetQuestionCount}
            action={syncMockTestQuestionsAction.bind(null, mockTest.id)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Schedule &amp; Attempt Policy</CardTitle>
          <CardDescription>
            Locked before the release date, available at and after it — indefinitely (this is not a Live Test). The whole
            series can also be scheduled at once from the series&apos; Schedule section.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScheduleForm
            mockTestId={mockTest.id}
            availableFromValue={mockTest.availableFrom ? toIstDateTimeLocalValue(mockTest.availableFrom) : ""}
            attemptPolicy={mockTest.attemptPolicy}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
          <CardDescription>
            Paper PDF and Solution PDF for this test, released server-side per policy. The practice OMR sheet is managed once
            on the Test Series (or sitewide) and shown on every test — no need to upload it per test.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TestResourceManager resources={mockTest.resources} allowedTypes={["PAPER_PDF", "SOLUTION_PDF"]} scope={{ mockTestId: mockTest.id }} />
        </CardContent>
      </Card>
    </div>
  );
}
