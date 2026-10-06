import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Circle, AlertTriangle } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getExamTaxonomy } from "@/lib/exam-taxonomy";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MockQuestionsManager, type SelectedQuestion } from "@/components/admin/mock-questions-manager";
import { bankRowSelect, toBankRow } from "@/lib/mock-question-bank";
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
import { RankingSettingsForm } from "@/components/admin/ranking-settings-form";
import { EnrollmentForm } from "./enrollment-form";
import { countMockTestEnrollments } from "@/lib/live-cbt";
import { getSiteUrl } from "@/lib/site-url";
import { getRankingConfig } from "@/lib/leaderboard";
import { MockDetailsForm } from "../mock-details-form";
import { MockTestStatusSelect } from "../status-select";
import { SeriesAssignmentForm } from "./series-assignment-form";
import {
  UNCOVERED_PAID_MOCK_WARNING,
  inertIndividualProducts,
  loadCoverageProducts,
  mockIsFree,
  purchasableProductsFor,
  sellingCoverageLabel,
  seriesPlanProducts,
} from "@/lib/test-series-assignment";

export const metadata = { title: "Mock Test — Mock Test Series.in Admin" };

const STEPS = [
  ["basic", "1 Basic Details"],
  ["coverage", "2 Coverage"],
  ["assignment", "Test Series"],
  ["questions", "3 Questions"],
  ["schedule", "4 Schedule & Availability"],
  ["access", "5 Access & Result"],
  ["live", "Live CBT & Enrollment"],
  ["ranking", "Ranking & Leaderboard"],
  ["publish", "6 Review & Publish"],
] as const;

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
              ...bankRowSelect,
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
  const [ranking, enrolledCount, siteUrl] = await Promise.all([
    getRankingConfig({ kind: "MOCK_TEST", id: mockTest.id }),
    countMockTestEnrollments(mockTest.id),
    getSiteUrl(),
  ]);

  const [bankExams, bankPapers, subjects, importRun, examSeries, coverageProducts] = await Promise.all([
    // Add From Question Bank source pickers — small reference lists only; the
    // questions themselves are searched server-side, page by page.
    canManage ? prisma.exam.findMany({ select: { id: true, name: true, code: true }, orderBy: [{ order: "asc" }, { name: "asc" }] }) : [],
    canManage
      ? prisma.previousYearPaper.findMany({ select: { id: true, examId: true, title: true, year: true }, orderBy: [{ year: "desc" }, { order: "asc" }] })
      : [],
    getExamTaxonomy(prisma, mockTest.examId),
    imported
      ? prisma.bulkImportRun.findFirst({
          where: { id: imported, mockTestId: id },
          select: { id: true, filename: true, successCount: true, replacedCount: true, skippedCount: true, failedCount: true, attachedCount: true },
        })
      : null,
    prisma.testSeries.findMany({ where: { examId: mockTest.examId }, orderBy: [{ order: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, status: true } }),
    loadCoverageProducts(prisma),
  ]);

  const selected: SelectedQuestion[] = mockTest.questions.map(({ question: q }) => ({
    ...toBankRow({ ...q, options: q.options.filter((o) => o.imageUrl).map((o) => ({ id: o.label })) }, true),
    imageUrl: q.imageUrl,
    options: q.options,
  }));

  const now = new Date();
  const coverageMock = { id: mockTest.id, examId: mockTest.examId, testSeriesId: mockTest.testSeriesId, accessType: mockTest.accessType };
  const coveringPlans = purchasableProductsFor(coverageMock, coverageProducts, now);
  const uncoveredPaid = !mockIsFree(coverageMock, coverageProducts) && coveringPlans.length === 0;
  const inertProducts = inertIndividualProducts(coverageMock, coverageProducts);
  const seriesOptions = examSeries.map((s) => ({ ...s, plans: seriesPlanProducts(s.id, mockTest.examId, coverageProducts, now).map((p) => p.name) }));
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
    { ok: true, label: `Access: ${mockTest.accessType} · Results: ${RESULT_RELEASE_LABELS[mockTest.resultReleaseMode]}${releaseAt ? ` (${formatIst(releaseAt)})` : ""} · Leaderboard ${ranking.leaderboardEnabled ? "on" : "off"}${ranking.countsTowardOverall ? " · Counts toward Overall Rank" : ""}` },
    { ok: !mockTest.testSeries || mockTest.testSeries.status === "PUBLISHED", warn: true, label: mockTest.testSeries ? `Test Series is ${mockTest.testSeries.status}` : "Standalone test" },
    { ok: !uncoveredPaid, warn: true, label: uncoveredPaid ? UNCOVERED_PAID_MOCK_WARNING : (sellingCoverageLabel(coveringPlans) ?? "Free for signed-in students") },
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

      <Card id="assignment" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Test Series / Course Assignment</CardTitle>
          <CardDescription>
            Currently: <strong>{mockTest.testSeries?.name ?? "Standalone / No Test Series"}</strong>. A PAID mock is unlocked by its series&apos; Complete
            Series product (Product → Test Series) and/or an Individual Mock Test product for this mock (Admin → Payments → Products).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {mockTest.accessType === "PAID" ? (
            <p className="text-sm text-[var(--color-muted-foreground)]" data-testid="selling-coverage">
              Selling coverage: <strong className="text-[var(--color-foreground)]">{sellingCoverageLabel(coveringPlans) ?? "Not covered by any purchasable product"}</strong>
            </p>
          ) : null}
          {inertProducts.length ? (
            <p className="flex items-start gap-2 rounded-[var(--radius-button)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-[var(--color-foreground)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden /> This mock is FREE, so its individual product (
              {inertProducts.join(", ")}) is never sold. Set the mock to PAID to sell it, or deactivate that product.
            </p>
          ) : null}
          {uncoveredPaid ? (
            <p className="flex items-start gap-2 rounded-[var(--radius-button)] border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm text-[var(--color-foreground)]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" aria-hidden /> {UNCOVERED_PAID_MOCK_WARNING}
            </p>
          ) : null}
          <SeriesAssignmentForm
            mockTestId={mockTest.id}
            currentSeriesId={mockTest.testSeriesId}
            options={seriesOptions}
            accessType={mockTest.accessType}
            readOnly={!canManage}
          />
        </CardContent>
      </Card>

      <Card id="questions" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Step 3 — Questions</CardTitle>
          <CardDescription>
            Every question is a canonical Question Bank question — from {mockTest.exam.name} or, when you choose, any other exam. This test only
            stores which ones and in what order; a reused question keeps its own exam and Previous Year Paper. The order here is the order students see.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MockQuestionsManager
            mockTestId={mockTest.id}
            examName={mockTest.exam.name}
            expected={mockTest.targetQuestionCount}
            examId={mockTest.examId}
            selected={selected}
            exams={bankExams}
            papers={bankPapers}
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
            }}
          />
        </CardContent>
      </Card>

      <Card id="live" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Live CBT &amp; Enrollment</CardTitle>
          <CardDescription>
            A Live CBT is this Mock Test with a Fixed Window — same player, scoring, result, review, Ask AI and leaderboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {mockTest.availableUntil || enrolledCount > 0 ? (
            <Link
              href={`/admin/tests/mock/${mockTest.id}/live-monitor`}
              className="w-fit rounded-[var(--radius-button)] border border-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary)]"
              data-testid="open-live-monitor"
            >
              Open Live CBT Monitor →
            </Link>
          ) : null}
          <div className="flex flex-col gap-2" data-testid="live-cbt-summary">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Live CBT / Fixed Window</p>
            <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              <li>
                Start: <strong>{mockTest.availableFrom ? formatIst(mockTest.availableFrom) : "—"}</strong>
              </li>
              <li>
                End: <strong>{mockTest.availableUntil ? formatIst(mockTest.availableUntil) : "—"}</strong>
              </li>
              <li>
                Attempts: <strong>{mockTest.attemptPolicy === "SINGLE_ATTEMPT" ? "Single attempt" : "Multiple practice attempts"}</strong>
              </li>
              <li>
                Result release: <strong>{RESULT_RELEASE_LABELS[mockTest.resultReleaseMode]}</strong>
              </li>
            </ul>
            {mode !== "FIXED_WINDOW" ? (
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Not a Live CBT yet: choose <a href="#schedule" className="text-[var(--color-primary)] hover:underline">Fixed Window in Step 4</a>. Saving it
                sets Single Attempt and &quot;After test window closes&quot; automatically.
              </p>
            ) : (
              <>
                {mockTest.resultReleaseMode === "IMMEDIATE" ? (
                  <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Results release immediately: an early finisher sees score and answers while
                    the window is still open. Use &quot;After test window closes&quot; in <a href="#access" className="underline">Step 5</a>.
                  </p>
                ) : null}
                {mockTest.attemptPolicy === "MULTIPLE_PRACTICE" ? (
                  <p className="flex items-start gap-1.5 text-xs text-[var(--color-warning)]">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Multiple attempts are allowed inside the window (retakes are never ranked).
                  </p>
                ) : null}
              </>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-muted-foreground)]">Enrollment</p>
            <EnrollmentForm
              mockTestId={mockTest.id}
              enrolledCount={enrolledCount}
              shareUrl={`${siteUrl}/student/test-series/${mockTest.id}`}
              readOnly={!canManage}
              values={{
                enrollmentEnabled: mockTest.enrollmentEnabled,
                showEnrolledCount: mockTest.showEnrolledCount,
                opensAtValue: mockTest.enrollmentOpensAt ? toIstDateTimeLocalValue(mockTest.enrollmentOpensAt) : "",
                closesAtValue: mockTest.enrollmentClosesAt ? toIstDateTimeLocalValue(mockTest.enrollmentClosesAt) : "",
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card id="ranking" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Ranking &amp; Leaderboard</CardTitle>
          <CardDescription>Per-test leaderboard and whether this test will count toward the exam&apos;s Overall Rank.</CardDescription>
        </CardHeader>
        <CardContent>
          <RankingSettingsForm kind="MOCK_TEST" testId={mockTest.id} values={ranking} readOnly={!canManage} />
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
