import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle, AlertTriangle } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MockQuestionsManager, type BankQuestion, type SelectedQuestion } from "@/components/admin/mock-questions-manager";
import { TestResourceManager } from "@/components/admin/test-resource-manager";
import { formatIst, toIstDateTimeLocalValue } from "@/lib/ist-time";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_MODE_LABELS,
  RESULT_RELEASE_LABELS,
  deriveAvailabilityMode,
  deriveMockTestAvailability,
  mockResultReleaseInstant,
} from "@/lib/mock-test-schedule";
import { mockSeriesPath } from "@/lib/mock-series";
import { AccessResultForm, ScheduleForm } from "./schedule-form";
import { MockDetailsForm } from "../mock-details-form";
import { MockTestStatusSelect } from "../status-select";

export const metadata = { title: "Mock Test — Mock Test Series.in Admin" };

const STEPS = [
  ["basic", "1 Basic Details"],
  ["coverage", "2 Coverage"],
  ["questions", "3 Questions"],
  ["schedule", "4 Schedule & Availability"],
  ["access", "5 Access & Result"],
  ["publish", "6 Review & Publish"],
] as const;

const TEXT_PREVIEW = 300;

/**
 * The canonical Mock Test editor — the one place a Mock Test is edited,
 * whether reached from Admin → Tests → Mock Tests or Admin → Exams → Test
 * Series → [series]. Six steps on one page: Basic Details, Coverage,
 * Questions (Question Bank / Bulk Import / selected list), Schedule &
 * Availability, Access & Result, Review & Publish. FULL_ADMIN sees it
 * read-only; every mutation is refused server-side without TEST_SERIES_MANAGE.
 */
export default async function MockTestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; imported?: string }>;
}) {
  const { id } = await params;
  const { created, imported } = await searchParams;
  const canManage = await hasPermission(PERMISSIONS.TEST_SERIES_MANAGE);

  const mockTest = await prisma.mockTest.findUnique({
    where: { id },
    include: {
      exam: true,
      testSeries: true,
      questions: {
        orderBy: { order: "asc" },
        select: {
          question: {
            select: {
              id: true,
              code: true,
              text: true,
              imageUrl: true,
              difficulty: true,
              status: true,
              source: true,
              examYear: true,
              previousYearPaperId: true,
              subject: { select: { id: true, name: true } },
              topic: { select: { id: true, name: true } },
              subTopic: { select: { id: true, name: true } },
              previousYearPaper: { select: { year: true } },
              options: { orderBy: { order: "asc" }, select: { label: true, text: true, imageUrl: true, isCorrect: true } },
            },
          },
        },
      },
      resources: { where: { type: { in: ["PAPER_PDF", "SOLUTION_PDF"] } }, orderBy: { createdAt: "desc" } },
      _count: { select: { testAttempts: true } },
    },
  });
  if (!mockTest) notFound();

  const [bankRows, subjects, importRun] = await Promise.all([
    prisma.question.findMany({
      where: { examId: mockTest.examId, status: { not: "ARCHIVED" } },
      select: {
        id: true,
        code: true,
        text: true,
        imageUrl: true,
        difficulty: true,
        status: true,
        source: true,
        examYear: true,
        previousYearPaperId: true,
        subject: { select: { id: true, name: true, order: true } },
        topic: { select: { id: true, name: true } },
        subTopic: { select: { id: true, name: true } },
        previousYearPaper: { select: { year: true } },
        options: { where: { imageUrl: { not: null } }, select: { id: true }, take: 1 },
      },
      orderBy: [{ subject: { order: "asc" } }, { createdAt: "asc" }],
    }),
    prisma.subject.findMany({
      where: { examId: mockTest.examId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, topics: { orderBy: { order: "asc" }, select: { id: true, name: true } } },
    }),
    imported
      ? prisma.bulkImportRun.findFirst({
          where: { id: imported, mockTestId: id },
          select: { id: true, filename: true, successCount: true, replacedCount: true, skippedCount: true, failedCount: true, attachedCount: true },
        })
      : null,
  ]);

  const toBase = (q: (typeof bankRows)[number] | (typeof mockTest.questions)[number]["question"], optionHasImage: boolean): BankQuestion => ({
    id: q.id,
    code: q.code,
    text: q.text.length > TEXT_PREVIEW ? `${q.text.slice(0, TEXT_PREVIEW)}…` : q.text,
    subjectId: q.subject.id,
    subjectName: q.subject.name,
    topicId: q.topic?.id ?? null,
    topicName: q.topic?.name ?? null,
    subTopicId: q.subTopic?.id ?? null,
    subTopicName: q.subTopic?.name ?? null,
    year: q.previousYearPaper?.year ?? q.examYear ?? null,
    isPyq: q.source === "PYQ" || q.previousYearPaperId !== null,
    difficulty: q.difficulty,
    status: q.status,
    hasImage: Boolean(q.imageUrl) || optionHasImage,
  });
  // bankRows' options are pre-filtered to image-bearing ones (take 1).
  const bank = bankRows.map((q) => toBase(q, q.options.length > 0));
  const selected: SelectedQuestion[] = mockTest.questions.map(({ question: q }) => ({
    ...toBase(q, q.options.some((o) => Boolean(o.imageUrl))),
    text: q.text,
    imageUrl: q.imageUrl,
    options: q.options,
  }));

  const now = new Date();
  const mode = deriveAvailabilityMode(mockTest);
  const windowState = deriveMockTestAvailability(mockTest, now);
  const releaseAt = mockResultReleaseInstant(mockTest);
  const seriesHref = mockTest.testSeries ? `/admin/exams/test-series/${mockTest.testSeries.id}` : null;
  const publicHref = mockTest.testSeries?.status === "PUBLISHED" && mockTest.exam.publicSlug ? mockSeriesPath(mockTest.exam.publicSlug) : null;
  const publishedCount = selected.filter((q) => q.status === "PUBLISHED").length;
  const bulkImportHref = `/admin/questions/bulk-import?examId=${mockTest.examId}&target=MOCK_TEST&mockTestId=${mockTest.id}&from=mock`;

  const checklist: { ok: boolean; warn?: boolean; label: string }[] = [
    { ok: publishedCount > 0, label: `${publishedCount} published question${publishedCount === 1 ? "" : "s"} students will receive` },
    {
      ok: mockTest.targetQuestionCount === null || selected.length === mockTest.targetQuestionCount,
      warn: true,
      label:
        mockTest.targetQuestionCount === null
          ? "No expected question count set"
          : `${selected.length} / ${mockTest.targetQuestionCount} expected questions`,
    },
    { ok: selected.length === publishedCount, warn: true, label: `${selected.length - publishedCount} draft question(s) hidden from students` },
    { ok: true, label: `Availability: ${AVAILABILITY_MODE_LABELS[mode]}${mockTest.availableFrom ? ` · from ${formatIst(mockTest.availableFrom)}` : ""}${mockTest.availableUntil ? ` · until ${formatIst(mockTest.availableUntil)}` : ""}` },
    { ok: true, label: `Access: ${mockTest.accessType} · Results: ${RESULT_RELEASE_LABELS[mockTest.resultReleaseMode]}${releaseAt ? ` (${formatIst(releaseAt)})` : ""} · Leaderboard ${mockTest.leaderboardEnabled ? "on" : "off"}` },
    { ok: !mockTest.testSeries || mockTest.testSeries.status === "PUBLISHED", warn: true, label: mockTest.testSeries ? `Test Series is ${mockTest.testSeries.status}` : "Standalone test" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-[var(--color-muted-foreground)]">
          <Link href="/admin/tests" className="hover:underline">Tests</Link> ›{" "}
          <Link href="/admin/tests?tab=mock" className="hover:underline">Mock Tests</Link>
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
              {mockTest.exam.name} · {mockTest.durationMinutes} min · {selected.length}
              {mockTest.targetQuestionCount !== null ? ` / ${mockTest.targetQuestionCount}` : ""} questions · {mockTest._count.testAttempts} attempts
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {mockTest.status === "PUBLISHED" ? (
              <Badge variant={windowState === "UPCOMING" ? "info" : windowState === "CLOSED" ? "neutral" : windowState === "LIVE_NOW" ? "warning" : "success"}>
                {AVAILABILITY_LABELS[windowState]}
              </Badge>
            ) : null}
            {selected.length === 0 ? <Badge variant="warning">Needs Questions</Badge> : null}
            <Badge variant={mockTest.accessType === "FREE" ? "primary" : "neutral"}>{mockTest.accessType}</Badge>
            <MockTestStatusSelect mockTestId={mockTest.id} status={mockTest.status} readOnly={!canManage} />
            {publicHref ? (
              <Link href={publicHref} target="_blank" className="text-sm text-[var(--color-primary)] hover:underline">
                View public page ↗
              </Link>
            ) : null}
          </div>
        </div>
        <nav aria-label="Mock Test editor steps" className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto">
          {STEPS.map(([key, label]) => (
            <a
              key={key}
              href={`#${key}`}
              className="shrink-0 rounded-[var(--radius-button)] border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              {label}
            </a>
          ))}
        </nav>
        {!canManage ? (
          <p className="rounded-[var(--radius-button)] border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
            Read-only view — only a Master Admin can edit, import, schedule or publish Mock Tests.
          </p>
        ) : null}
        {created ? (
          <p className="rounded-[var(--radius-button)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-foreground)]">
            Draft saved. Next: add questions (Step 3), set the schedule (Step 4), then publish (Step 6).
          </p>
        ) : null}
        {importRun ? (
          <p className="rounded-[var(--radius-button)] border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-3 py-2 text-sm text-[var(--color-foreground)]">
            Bulk import of <strong>{importRun.filename}</strong> finished: {importRun.successCount} new, {importRun.replacedCount} replaced,{" "}
            {importRun.skippedCount} existing duplicates reused, {importRun.failedCount} failed — <strong>{importRun.attachedCount}</strong> attached to this
            test.{" "}
            <Link href={`/admin/questions/bulk-import/history/${importRun.id}`} className="text-[var(--color-primary)] hover:underline">
              Import report
            </Link>
          </p>
        ) : null}
      </div>

      <Card id="basic" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Step 1 — Basic Details</CardTitle>
          <CardDescription>
            Exam <strong>{mockTest.exam.name}</strong> · Test Series <strong>{mockTest.testSeries?.name ?? "Standalone"}</strong>. Test number, title,
            expected question count, duration, negative marking and instructions; Step 2 (coverage) is part of the same form.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MockDetailsForm
            mockTestId={mockTest.id}
            subjects={subjects}
            readOnly={!canManage}
            values={{
              title: mockTest.title,
              order: mockTest.order,
              description: mockTest.description,
              durationMinutes: mockTest.durationMinutes,
              negativeMarking: mockTest.negativeMarking,
              instructions: mockTest.instructions,
              targetQuestionCount: mockTest.targetQuestionCount,
              coverageType: mockTest.coverageType,
              coverageSubjectIds: mockTest.coverageSubjectIds,
              coverageTopicIds: mockTest.coverageTopicIds,
            }}
          />
        </CardContent>
      </Card>

      <Card id="questions" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Step 3 — Questions</CardTitle>
          <CardDescription>
            Every question is a canonical Question Bank question of {mockTest.exam.name} — this test only stores which ones and in what order. The
            order here is the order students see.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MockQuestionsManager
            mockTestId={mockTest.id}
            examName={mockTest.exam.name}
            expected={mockTest.targetQuestionCount}
            selected={selected}
            bank={bank}
            bulkImportHref={bulkImportHref}
            readOnly={!canManage}
          />
        </CardContent>
      </Card>

      <Card id="schedule" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Step 4 — Schedule &amp; Availability</CardTitle>
          <CardDescription>
            Current: <strong>{AVAILABILITY_MODE_LABELS[mode]}</strong>. All times are IST and evaluated on the server — a student&apos;s clock never
            decides. Scheduled/fixed-window tests also appear under Tests → Scheduled Tests.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScheduleForm
            mockTestId={mockTest.id}
            mode={mode}
            availableFromValue={mockTest.availableFrom ? toIstDateTimeLocalValue(mockTest.availableFrom) : ""}
            availableUntilValue={mockTest.availableUntil ? toIstDateTimeLocalValue(mockTest.availableUntil) : ""}
            readOnly={!canManage}
          />
        </CardContent>
      </Card>

      <Card id="access" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Step 5 — Access &amp; Result</CardTitle>
          <CardDescription>FREE/PAID access (entitlements come from Payments), attempt policy, result release and leaderboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <AccessResultForm
            mockTestId={mockTest.id}
            isFixedWindow={mode === "FIXED_WINDOW"}
            readOnly={!canManage}
            values={{
              accessType: mockTest.accessType,
              attemptPolicy: mockTest.attemptPolicy,
              resultReleaseMode: mockTest.resultReleaseMode,
              resultReleaseAtValue: mockTest.resultReleaseAt ? toIstDateTimeLocalValue(mockTest.resultReleaseAt) : "",
              leaderboardEnabled: mockTest.leaderboardEnabled,
            }}
          />
        </CardContent>
      </Card>

      <Card id="publish" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Step 6 — Review &amp; Publish</CardTitle>
          <CardDescription>Publishing requires at least one published question. Status: {mockTest.status}.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-1.5 text-sm">
            {checklist.map((c) => (
              <li key={c.label} className="flex items-start gap-2">
                {c.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" aria-hidden />
                ) : c.warn ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
                ) : (
                  <Circle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-error)]" aria-hidden />
                )}
                <span className="text-[var(--color-foreground)]">{c.label}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <span className="text-sm text-[var(--color-muted-foreground)]">Status</span>
            <MockTestStatusSelect mockTestId={mockTest.id} status={mockTest.status} readOnly={!canManage} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
          <CardDescription>
            Paper PDF and Solution PDF for this test, released server-side per policy. The practice OMR sheet is managed once on the Test Series (or
            sitewide).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TestResourceManager resources={mockTest.resources} allowedTypes={["PAPER_PDF", "SOLUTION_PDF"]} scope={{ mockTestId: mockTest.id }} />
        </CardContent>
      </Card>
    </div>
  );
}
