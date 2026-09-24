import "server-only";
import { prisma } from "@/lib/prisma";
import { getPaymentMode, type PaymentMode } from "@/lib/payments/settings";
import { computeProductPrice, describeAccessDuration, type ProductPrice } from "@/lib/payments/pricing";
import { canStudentAccessProduct, evaluateContentAccess, loadAccessContext, type AccessContext } from "@/lib/payments/access";
import { deriveMockTestAvailability, type MockTestAvailability } from "@/lib/mock-test-schedule";
import { getAiSettings } from "@/lib/ai-settings";
import { formatInr } from "@/lib/payments/money";

/**
 * The ONE source of truth for an exam's Mock Test Series as the public site
 * sees it: which Test Series is canonical, how many mocks are planned vs
 * published vs available, what each covers, which Product sells it, and at
 * what (server-computed) price. Homepage, Exam Hub, the Mock Test Series
 * landing page, cross-links on PYQ/Syllabus/Pattern/Question Bank, and the
 * Free-vs-Complete comparison all read from here, so changing a price, sale,
 * schedule, or publication in Admin updates every surface at once.
 *
 * Public-safe by construction: never selects question payloads, only counts
 * and titles of PUBLISHED tests in a PUBLISHED series.
 */

export const MOCK_SERIES_SEGMENT = "mock-test-series";

export function mockSeriesPath(examPublicSlug: string): string {
  return `/exams/${examPublicSlug}/${MOCK_SERIES_SEGMENT}`;
}

export interface PublicSeriesTest {
  id: string;
  testNumber: number;
  title: string;
  description: string | null;
  coverageLabel: string;
  coverageItems: string[];
  questionCount: number;
  durationMinutes: number;
  negativeMarking: number;
  availableFrom: Date | null;
  availability: MockTestAvailability;
  accessType: "FREE" | "PAID";
}

export interface ExamMockSeries {
  series: { id: string; name: string; description: string | null; instructions: string | null; examId: string };
  planned: number;
  published: number;
  available: number;
  upcoming: number;
  freeAvailable: number;
  tests: PublicSeriesTest[];
}

const COVERAGE_LABEL = { FULL_SYLLABUS: "Full Syllabus", PARTIAL_SYLLABUS: "Partial Syllabus", SUBJECT_WISE: "Subject-wise" } as const;

/** Canonical series for an exam: the first PUBLISHED Test Series by admin order (a slugged one wins ties). */
export async function getCanonicalSeriesRow(examId: string) {
  return prisma.testSeries.findFirst({
    where: { examId, status: "PUBLISHED" },
    orderBy: [{ order: "asc" }, { slug: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
}

export async function getExamMockSeries(examId: string, now: Date = new Date()): Promise<ExamMockSeries | null> {
  const series = await getCanonicalSeriesRow(examId);
  if (!series) return null;

  const mocks = await prisma.mockTest.findMany({
    where: { testSeriesId: series.id, status: "PUBLISHED" },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      order: true,
      title: true,
      description: true,
      durationMinutes: true,
      negativeMarking: true,
      availableFrom: true,
      accessType: true,
      status: true,
      coverageType: true,
      coverageSubjectIds: true,
      coverageTopicIds: true,
      _count: { select: { questions: true } },
    },
  });

  const subjectIds = [...new Set(mocks.flatMap((m) => m.coverageSubjectIds))];
  const topicIds = [...new Set(mocks.flatMap((m) => m.coverageTopicIds))];
  const [subjects, topics] = await Promise.all([
    subjectIds.length ? prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }) : [],
    topicIds.length ? prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true } }) : [],
  ]);
  const subjectName = new Map(subjects.map((s) => [s.id, s.name]));
  const topicName = new Map(topics.map((t) => [t.id, t.name]));

  const tests: PublicSeriesTest[] = mocks.map((m) => {
    const items =
      m.coverageType === "FULL_SYLLABUS"
        ? []
        : [
            ...m.coverageSubjectIds.map((id) => subjectName.get(id)).filter((n): n is string => Boolean(n)),
            ...m.coverageTopicIds.map((id) => topicName.get(id)).filter((n): n is string => Boolean(n)),
          ];
    return {
      id: m.id,
      testNumber: m.order,
      title: m.title,
      description: m.description,
      coverageLabel: COVERAGE_LABEL[m.coverageType],
      coverageItems: items,
      questionCount: m._count.questions,
      durationMinutes: m.durationMinutes,
      negativeMarking: m.negativeMarking,
      availableFrom: m.availableFrom,
      availability: deriveMockTestAvailability(m, now),
      accessType: m.accessType,
    };
  });

  const available = tests.filter((t) => t.availability === "AVAILABLE").length;
  return {
    series: { id: series.id, name: series.name, description: series.description, instructions: series.instructions, examId: series.examId },
    // Never report fewer planned than actually published.
    planned: Math.max(series.testCount, tests.length),
    published: tests.length,
    available,
    upcoming: tests.length - available,
    freeAvailable: tests.filter((t) => t.availability === "AVAILABLE" && t.accessType === "FREE").length,
    tests,
  };
}

// ---------------------------------------------------------------------------
// Offer — the canonical sellable product + its server-computed price.
// ---------------------------------------------------------------------------

export interface SeriesOffer {
  mode: PaymentMode;
  product: { id: string; code: string; name: string; description: string | null; accessDuration: string; productType: string };
  price: ProductPrice;
  /** True only when a real, purchasable price should be displayed (PAID/MAINTENANCE mode, PAID product). */
  showPrice: boolean;
  /** Purchases currently possible (PAID mode + purchase enabled). */
  purchasable: boolean;
}

/**
 * The product that sells an exam's mock series: a TEST_SERIES product bound
 * to the canonical series wins; otherwise an EXAM_ACCESS product for the exam
 * (which also unlocks the series). Only active + visible products count.
 */
export async function getSeriesOffer(examId: string, seriesId: string | null, now: Date = new Date()): Promise<SeriesOffer | null> {
  const [mode, candidates] = await Promise.all([
    getPaymentMode(),
    prisma.product.findMany({
      where: {
        isActive: true,
        isVisible: true,
        OR: [...(seriesId ? [{ productType: "TEST_SERIES" as const, testSeriesId: seriesId }] : []), { productType: "EXAM_ACCESS" as const, examId }],
      },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const product = candidates.find((p) => p.productType === "TEST_SERIES") ?? candidates[0];
  if (!product) return null;
  const price = computeProductPrice(product, now);
  const paidProduct = product.accessType === "PAID" && !price.isFree;
  return {
    mode,
    product: {
      id: product.id,
      code: product.code,
      name: product.name,
      description: product.description,
      accessDuration: describeAccessDuration(product),
      productType: product.productType,
    },
    price,
    showPrice: mode !== "FREE" && paidProduct,
    purchasable: mode === "PAID" && paidProduct && product.purchaseEnabled,
  };
}

export interface ExamMockSeriesSummary {
  mockSeries: ExamMockSeries | null;
  offer: SeriesOffer | null;
  href: string | null;
}

export async function getExamMockSeriesSummary(exam: { id: string; publicSlug: string | null; publicPageEnabled?: boolean }): Promise<ExamMockSeriesSummary> {
  const mockSeries = await getExamMockSeries(exam.id);
  const offer = await getSeriesOffer(exam.id, mockSeries?.series.id ?? null);
  const href = exam.publicSlug && exam.publicPageEnabled !== false ? mockSeriesPath(exam.publicSlug) : null;
  return { mockSeries, offer, href };
}

// ---------------------------------------------------------------------------
// Primary CTA — depends on who is looking.
// ---------------------------------------------------------------------------

export interface SeriesCta {
  kind: "OPEN" | "BUY" | "LOGIN_TO_BUY" | "START_FREE" | "UNAVAILABLE";
  label: string;
  href: string | null;
}

export async function getSeriesCta(studentId: string | null, offer: SeriesOffer | null): Promise<SeriesCta> {
  const open = "/student/test-series";
  if (!offer || !offer.showPrice) {
    // FREE mode / free product: everything unlocks after sign-in.
    return studentId ? { kind: "OPEN", label: "Open Test Series", href: open } : { kind: "START_FREE", label: "Start Free", href: `/login?callbackUrl=${encodeURIComponent(open)}` };
  }
  const checkout = `/student/checkout/${encodeURIComponent(offer.product.code)}`;
  if (!studentId) return { kind: "LOGIN_TO_BUY", label: "Unlock Complete Series", href: `/login?callbackUrl=${encodeURIComponent(checkout)}` };
  const access = await canStudentAccessProduct(studentId, offer.product.id);
  if (access.allowed) return { kind: "OPEN", label: "Open Test Series", href: open };
  if (!offer.purchasable) return { kind: "UNAVAILABLE", label: "Purchases paused", href: null };
  return { kind: "BUY", label: access.status === "EXPIRED" ? "Renew Complete Series" : "Unlock Complete Series", href: checkout };
}

// ---------------------------------------------------------------------------
// Free vs Complete comparison — derived from the real access engine + AI
// settings, so marketing can never promise what the backend doesn't enforce.
// ---------------------------------------------------------------------------

export interface PlanRow {
  feature: string;
  free: string;
  paid: string;
  note?: string;
}

export async function getPlanComparison(
  examId: string,
  mockSeries: ExamMockSeries | null,
  offer: SeriesOffer | null
): Promise<{ rows: PlanRow[]; everythingFreeNow: boolean }> {
  const [ai, papers, omrCount, pdfCount] = await Promise.all([
    getAiSettings(),
    prisma.previousYearPaper.findMany({ where: { examId, isActive: true }, select: { id: true, year: true } }),
    prisma.testResource.count({
      where: {
        type: "OMR_TEMPLATE",
        isActive: true,
        OR: [
          { examId, mockTestId: null },
          ...(mockSeries ? [{ testSeriesId: mockSeries.series.id }] : []),
          { examId: null, testSeriesId: null, mockTestId: null },
        ],
      },
    }),
    mockSeries
      ? prisma.testResource.count({ where: { type: { in: ["PAPER_PDF", "SOLUTION_PDF"] }, isActive: true, mockTest: { testSeriesId: mockSeries.series.id } } })
      : 0,
  ]);

  // Evaluate what a student WITHOUT any entitlement gets under the product
  // rules as configured (PAID mode), using the same engine the start-attempt
  // gate uses. In FREE mode the gate lets everyone in — flagged separately.
  const base = await loadAccessContext("__anonymous__");
  const products =
    base.mode === "FREE"
      ? await prisma.product.findMany({
          where: { isActive: true },
          select: { id: true, code: true, name: true, productType: true, examId: true, testSeriesId: true, mockTestId: true, grandTestId: true, liveTestId: true, accessType: true, isActive: true, isVisible: true, purchaseEnabled: true, accessDurationType: true, accessExpiresAt: true },
        })
      : base.products;
  const ctx: AccessContext = { mode: "PAID", products, entitlements: [], now: new Date() };
  const freeFor = (c: Parameters<typeof evaluateContentAccess>[1]) => evaluateContentAccess(ctx, c).allowed;

  const pyqFree = papers.length === 0 ? true : freeFor({ kind: "PREVIOUS_YEAR_PAPER", id: papers[0].id, examId });
  const subjectFree = freeFor({ kind: "SUBJECT_TEST", id: null, examId });
  const tests = mockSeries?.tests ?? [];
  const freeMocks = tests.filter((t) => freeFor({ kind: "MOCK_TEST", id: t.id, examId, testSeriesId: mockSeries!.series.id, accessType: t.accessType })).length;
  const planned = mockSeries?.planned ?? 0;
  const years = new Set(papers.map((p) => p.year)).size;
  const aiFree = `${ai.freeDailyLimit} per day`;
  const aiPaid = ai.paidDailyLimit === null ? "Unlimited" : `${ai.paidDailyLimit} per day`;
  const yes = "Yes";
  const pyqLabel = years > 0 ? `${years} year${years === 1 ? "" : "s"}` : "—";

  const rows: PlanRow[] = [
    {
      feature: "Price",
      free: "₹0",
      paid: offer?.showPrice ? formatPriceShort(offer.price) : offer ? "Free right now" : "—",
    },
    {
      feature: "Mock Tests",
      free: freeMocks > 0 ? `${freeMocks} free mock${freeMocks === 1 ? "" : "s"}` : "Sample mocks when released",
      paid: planned > 0 ? `All ${planned} planned mocks (${tests.length} published so far)` : "All mocks in the series",
    },
    { feature: "Scheduled mock access", free: freeMocks > 0 ? "Free mocks, as they release" : "—", paid: "Every mock, as it releases" },
    { feature: "Previous Year Papers", free: pyqFree ? pyqLabel : "—", paid: pyqLabel },
    { feature: "PYQ practice (attempt online)", free: pyqFree ? yes : "—", paid: yes },
    { feature: "Downloadable Practice OMR", free: yes, paid: yes, note: omrCount > 0 ? undefined : "OMR sheets are published by the admin" },
    { feature: "AI Explanations (Ask AI)", free: aiFree, paid: aiPaid },
    { feature: "Examiner Traps & AI Trap Questions", free: `${aiFree} (shared with Ask AI)`, paid: ai.paidDailyLimit === null ? "Unlimited" : `${aiPaid} (shared with Ask AI)` },
    { feature: "Result & Score", free: yes, paid: yes },
    { feature: "Question-by-question Review", free: yes, paid: yes },
    { feature: "Correct Answer Review", free: yes, paid: yes },
    { feature: "Performance Analytics", free: yes, paid: yes },
    { feature: "Subject-wise practice", free: subjectFree ? yes : "—", paid: yes },
    { feature: "Bookmarks / Saved Questions", free: yes, paid: yes },
    ...(pdfCount > 0 ? [{ feature: "Mock paper / solution PDFs", free: "With the mocks you can attempt", paid: "With every mock" }] : []),
    { feature: "Syllabus coverage per mock", free: yes, paid: yes },
    { feature: "Mobile practice", free: yes, paid: yes },
  ];
  return { rows, everythingFreeNow: base.mode === "FREE" };
}

function formatPriceShort(p: ProductPrice): string {
  return p.mrpPaise > p.pricePaise ? `${formatInr(p.pricePaise)} (MRP ${formatInr(p.mrpPaise)}, ${p.discountPercent}% off)` : formatInr(p.pricePaise);
}
