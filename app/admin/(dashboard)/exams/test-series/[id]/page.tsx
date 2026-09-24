import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TestResourceManager } from "@/components/admin/test-resource-manager";
import { deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { computeProductPrice, describeAccessDuration } from "@/lib/payments/pricing";
import { formatInr } from "@/lib/payments/money";
import { getPaymentMode } from "@/lib/payments/settings";
import { getCanonicalSeriesRow, mockSeriesPath } from "@/lib/mock-series";
import { SeriesStatusSelect } from "../series-status-select";
import { SeriesSettingsForm } from "../series-settings-form";
import { MockTestTable, toMockTestTableRow } from "@/components/admin/mock-test-table";
import { hasPermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { ScheduleTable } from "../../../tests/scheduled/schedule-table";

export const metadata = { title: "Test Series — Mock Test Series.in Admin" };

const COVERAGE_LABELS = { FULL_SYLLABUS: "Full Syllabus", PARTIAL_SYLLABUS: "Partial Syllabus", SUBJECT_WISE: "Subject-wise" } as const;

const SECTIONS = [
  ["overview", "Overview"],
  ["mock-tests", "Mock Tests"],
  ["schedule", "Schedule"],
  ["coverage", "Coverage"],
  ["resources", "Resources"],
  ["pricing", "Pricing & Access"],
  ["students", "Students / Attempts"],
  ["public", "SEO / Public Page"],
  ["settings", "Settings"],
] as const;

/**
 * Canonical management page for one Test Series:
 * Admin → Exams → Test Series → [this series]. Every Mock Test is created,
 * scheduled, covered and priced from here (the old /admin/tests/* entry
 * points link back to it).
 */
export default async function TestSeriesDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const series = await prisma.testSeries.findUnique({
    where: { id },
    include: {
      exam: true,
      mockTests: {
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        include: { _count: { select: { questions: true, testAttempts: true } } },
      },
      resources: { where: { type: "OMR_TEMPLATE" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!series) notFound();

  const canManage = await hasPermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const mockIds = series.mockTests.map((m) => m.id);
  const [subjects, products, mode, canonical, attemptAgg, studentsAgg, examOmr, globalOmr, pdfCount] = await Promise.all([
    prisma.subject.findMany({
      where: { examId: series.examId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, topics: { orderBy: { order: "asc" }, select: { id: true, name: true } } },
    }),
    prisma.product.findMany({
      where: { OR: [{ testSeriesId: series.id }, { productType: "EXAM_ACCESS", examId: series.examId }, { mockTestId: { in: mockIds } }] },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { entitlements: { where: { status: "ACTIVE" } } } } },
    }),
    getPaymentMode(),
    getCanonicalSeriesRow(series.examId),
    prisma.testAttempt.groupBy({ by: ["status"], where: { mockTestId: { in: mockIds } }, _count: { _all: true } }),
    prisma.testAttempt.findMany({ where: { mockTestId: { in: mockIds } }, distinct: ["studentId"], select: { studentId: true } }),
    prisma.testResource.count({ where: { type: "OMR_TEMPLATE", isActive: true, examId: series.examId, mockTestId: null, testSeriesId: null } }),
    prisma.testResource.count({ where: { type: "OMR_TEMPLATE", isActive: true, examId: null, mockTestId: null, testSeriesId: null } }),
    prisma.testResource.count({ where: { type: { in: ["PAPER_PDF", "SOLUTION_PDF"] }, mockTestId: { in: mockIds } } }),
  ]);

  const now = new Date();
  const published = series.mockTests.filter((m) => m.status === "PUBLISHED");
  const available = published.filter((m) => ["AVAILABLE", "LIVE_NOW"].includes(deriveMockTestAvailability(m, now))).length;
  const drafts = series.mockTests.filter((m) => m.status === "DRAFT").length;
  const nextNumber = (series.mockTests.reduce((max, m) => Math.max(max, m.order), 0) || 0) + 1;
  const isCanonical = canonical?.id === series.id;
  const publicHref = isCanonical && series.exam.publicPageEnabled && series.exam.publicSlug ? mockSeriesPath(series.exam.publicSlug) : null;
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  const topicName = new Map(subjects.flatMap((s) => s.topics.map((t) => [t.id, t.name] as const)));
  const submitted = attemptAgg.find((a) => a.status === "SUBMITTED")?._count._all ?? 0;
  const inProgress = attemptAgg.find((a) => a.status === "IN_PROGRESS")?._count._all ?? 0;
  const coverageCount = new Map<string, number>();
  for (const m of series.mockTests)
    for (const sid of m.coverageSubjectIds) coverageCount.set(subjectName.get(sid) ?? "?", (coverageCount.get(subjectName.get(sid) ?? "?") ?? 0) + 1);

  const scheduleRows = series.mockTests.map((m) => ({
    id: m.id,
    title: m.title,
    order: m.order,
    status: m.status,
    availableFrom: m.availableFrom,
    availableUntil: m.availableUntil,
    durationMinutes: m.durationMinutes,
    availability: deriveMockTestAvailability(m, now),
    coverageLabel: COVERAGE_LABELS[m.coverageType],
    questionCount: m._count.questions,
    accessType: m.accessType,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p className="text-xs text-[var(--color-muted-foreground)]">
          <Link href="/admin/exams" className="hover:underline">Exams</Link> › {series.exam.name} ›{" "}
          <Link href="/admin/exams/test-series" className="hover:underline">Test Series</Link>
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-[var(--color-foreground)]">{series.name}</h1>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {series.exam.name} · {series.testCount} planned · {published.length} published · {available} available · {drafts} draft
            </p>
          </div>
          <div className="flex items-center gap-2">
            <SeriesStatusSelect id={series.id} status={series.status} />
            {canManage ? (
              <Link
                href={`/admin/tests/mock/new?testSeriesId=${series.id}`}
                className="rounded-[var(--radius-button)] border border-[var(--color-primary)] bg-[var(--color-primary)]/10 px-3 py-1.5 text-sm text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20"
              >
                Add Mock Test
              </Link>
            ) : null}
          </div>
        </div>
        <nav aria-label="Series sections" className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto">
          {SECTIONS.map(([key, label]) => (
            <a
              key={key}
              href={`#${key}`}
              className="shrink-0 rounded-[var(--radius-button)] border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
            >
              {label}
            </a>
          ))}
        </nav>
      </div>

      {/* OVERVIEW */}
      <Card id="overview" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Overview</CardTitle>
          <CardDescription>
            {series.status === "PUBLISHED"
              ? isCanonical
                ? "Published — this is the exam's canonical Mock Test Series shown on the homepage, Exam Hub and series page."
                : "Published, but another published series of this exam has a lower display order and is the one shown publicly."
              : "Not published — nothing from this series is visible to students or the public yet."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Tile label="Planned" value={series.testCount} />
          <Tile label="Created" value={series.mockTests.length} />
          <Tile label="Published" value={published.length} />
          <Tile label="Available now" value={available} />
          <Tile label="Upcoming" value={published.filter((m) => deriveMockTestAvailability(m, now) === "UPCOMING").length} />
          <Tile label="Remaining to plan" value={Math.max(0, series.testCount - series.mockTests.length)} />
        </CardContent>
      </Card>

      {/* MOCK TESTS */}
      <Card id="mock-tests" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Mock Tests</CardTitle>
          <CardDescription>
            Ordered by Test Number. Each opens the one Mock Test editor — Manage Questions / Bulk Import Questions go straight to its Questions step.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="overflow-x-auto">
            {series.mockTests.length === 0 ? (
              <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">No tests yet — add the first one.</p>
            ) : (
              <MockTestTable
                showSeries={false}
                canManage={canManage}
                rows={series.mockTests.map((mt) => ({
                  ...toMockTestTableRow({ ...mt, exam: series.exam, testSeries: series }),
                  coverageText:
                    mt.coverageType !== "FULL_SYLLABUS"
                      ? [...mt.coverageSubjectIds.map((s) => subjectName.get(s)), ...mt.coverageTopicIds.map((t) => topicName.get(t))].filter(Boolean).join(", ") || "—"
                      : undefined,
                }))}
              />
            )}
          </div>
          {canManage ? (
            <Link
              href={`/admin/tests/mock/new?testSeriesId=${series.id}`}
              className="w-fit rounded-[var(--radius-button)] border border-[var(--color-primary)] bg-[var(--color-primary)]/10 px-3 py-1.5 text-sm text-[var(--color-primary)] hover:bg-[var(--color-primary)]/20"
            >
              + Add Mock Test #{nextNumber}
            </Link>
          ) : null}
        </CardContent>
      </Card>

      {/* SCHEDULE */}
      <Card id="schedule" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>
            Release date per test (IST). Locked before release; Fixed Window tests also close at their end (set in each test&apos;s editor). Bulk CSV scheduling for all{" "}
            {series.testCount || "planned"} mocks:{" "}
            <Link href={`/admin/tests/scheduled?testSeriesId=${series.id}`} className="text-[var(--color-primary)] hover:underline">
              Schedule Manager → Bulk Schedule Upload
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ScheduleTable rows={scheduleRows} readOnly={!canManage} />
        </CardContent>
      </Card>

      {/* COVERAGE */}
      <Card id="coverage" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Coverage</CardTitle>
          <CardDescription>What students are told each mock covers (set per test under Details &amp; Coverage).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-muted-foreground)]">
            {series.mockTests.filter((m) => m.coverageType === "FULL_SYLLABUS").length} full-syllabus ·{" "}
            {series.mockTests.filter((m) => m.coverageType === "PARTIAL_SYLLABUS").length} partial ·{" "}
            {series.mockTests.filter((m) => m.coverageType === "SUBJECT_WISE").length} subject-wise
          </p>
          <div className="flex flex-wrap gap-2">
            {subjects.map((s) => (
              <Badge key={s.id} variant={coverageCount.get(s.name) ? "success" : "neutral"}>
                {s.name}: {coverageCount.get(s.name) ?? 0}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* RESOURCES */}
      <Card id="resources" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Resources — Practice OMR</CardTitle>
          <CardDescription>
            Upload the OMR sheet once here; it is shown on every test in this series, the series page and the Student Dashboard,
            on both FREE and PAID plans. Exam-wide OMR sheets: {examOmr} · sitewide: {globalOmr}. Paper/Solution PDFs are attached
            per test ({pdfCount} uploaded).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TestResourceManager resources={series.resources} allowedTypes={["OMR_TEMPLATE"]} scope={{ testSeriesId: series.id }} />
        </CardContent>
      </Card>

      {/* PRICING */}
      <Card id="pricing" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Pricing &amp; Access</CardTitle>
          <CardDescription>
            Payment mode: <strong>{mode}</strong>
            {mode === "FREE" ? " — every signed-in student currently gets full access; prices are hidden publicly." : ""}. Prices,
            MRP and sales are edited only in{" "}
            <Link href="/admin/payments?tab=products" className="text-[var(--color-primary)] hover:underline">
              Payments → Products
            </Link>{" "}
            and flow to the homepage, Exam Hub, series page, plans and checkout automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {products.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No product sells this series yet.{" "}
              <Link href="/admin/payments/products/new" className="text-[var(--color-primary)] hover:underline">
                Create a Test Series product
              </Link>{" "}
              and select this series.
            </p>
          ) : (
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--color-border)] text-xs uppercase text-[var(--color-muted-foreground)]">
                  <th className="py-2 pr-4">Product</th>
                  <th className="py-2 pr-4">Covers</th>
                  <th className="py-2 pr-4">Price</th>
                  <th className="py-2 pr-4">Active students</th>
                  <th className="py-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const price = computeProductPrice(p, now);
                  return (
                    <tr key={p.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="py-2.5 pr-4">
                        <span className="font-medium text-[var(--color-foreground)]">{p.name}</span>
                        <span className="block text-xs text-[var(--color-muted-foreground)]">
                          {p.code} · {describeAccessDuration(p)} · {p.isActive && p.isVisible ? "active" : "hidden"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-[var(--color-muted-foreground)]">
                        {p.productType === "TEST_SERIES" ? "This series (PAID mocks)" : p.productType === "EXAM_ACCESS" ? "Whole exam (mocks, PYQs, subject tests)" : p.productType}
                      </td>
                      <td className="py-2.5 pr-4">
                        {price.isFree ? "Free" : formatInr(price.pricePaise)}
                        {!price.isFree && price.mrpPaise > price.pricePaise ? (
                          <span className="block text-xs text-[var(--color-muted-foreground)]">
                            MRP {formatInr(price.mrpPaise)} · {price.discountPercent}% off{price.saleActive ? " (sale live)" : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--color-muted-foreground)]">{p._count.entitlements}</td>
                      <td className="py-2.5 pr-4">
                        <Link href={`/admin/payments/products/${p.id}`} className="text-[var(--color-primary)] hover:underline">
                          Edit price
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* STUDENTS */}
      <Card id="students" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Students / Attempts</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Students attempted" value={studentsAgg.length} />
          <Tile label="Submitted attempts" value={submitted} />
          <Tile label="In progress" value={inProgress} />
          <Tile label="Active entitlements" value={products.reduce((n, p) => n + p._count.entitlements, 0)} />
        </CardContent>
      </Card>

      {/* PUBLIC */}
      <Card id="public" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>SEO / Public Page</CardTitle>
          <CardDescription>
            The public page title, H1 and hero text come from the series name and description (Settings below). Exam-level SEO
            and FAQs are edited on the exam (Admin → Exams).
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {publicHref ? (
            <Link href={publicHref} target="_blank" className="text-[var(--color-primary)] hover:underline">
              {publicHref} ↗
            </Link>
          ) : (
            <p className="text-[var(--color-muted-foreground)]">
              Not public yet — requires this series to be Published (and the lowest-order published series of the exam) and the
              exam&apos;s public page to be enabled.
            </p>
          )}
        </CardContent>
      </Card>

      {/* SETTINGS */}
      <Card id="settings" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <SeriesSettingsForm series={series} />
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-center">
      <p className="text-xl font-semibold text-[var(--color-foreground)]">{value}</p>
      <p className="text-[11px] text-[var(--color-muted-foreground)]">{label}</p>
    </div>
  );
}
