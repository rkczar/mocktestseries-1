import "server-only";
import { prisma } from "@/lib/prisma";
import { getRazorpayConfig } from "@/lib/razorpay-config";
import { evaluateContentAccess, loadAccessContext, type AccessContext } from "@/lib/payments/access";
import { getExamMockSeries, getSeriesComparison, getSeriesOffer, mockSeriesPath, type SeriesOffer } from "@/lib/mock-series";
import { paidBenefits, type OfferDisplayConfig, type OfferDisplayRow } from "@/lib/payments/offer-display-shared";

/**
 * Per-exam Free / Complete / Expired state for the logged-in student — the
 * data behind the Student Dashboard access card and the Test Series banner.
 *
 * The state is decided ONLY by the canonical entitlement engine
 * (evaluateContentAccess) against a PAID mock of the exam's canonical series:
 * the exact decision that locks/unlocks that series' tests on the Test
 * Series page and in lib/test-attempt.ts. Payment rows, URL params and
 * client state are never consulted.
 */

export type ExamAccessState = "FREE_MODE" | "ACTIVE" | "EXPIRED" | "FREE" | "UNAVAILABLE";

export interface ExamAccessSummary {
  exam: { id: string; name: string };
  state: ExamAccessState;
  series: { id: string; name: string; planned: number; published: number } | null;
  offer: SeriesOffer | null;
  /** Checkout link only when a purchase can actually complete (PAID mode, purchasable product, gateway ready). */
  checkoutHref: string | null;
  /** Why no checkout link is offered to a student who could otherwise buy. */
  unavailableReason: string | null;
  freeMocks: number;
  lockedMocks: number;
  benefits: string[];
  comparison: OfferDisplayRow[];
  display: OfferDisplayConfig;
  comparisonHref: string;
  /** Present for ACTIVE / EXPIRED. */
  entitlement: {
    productIds: string[];
    productName: string;
    since: Date | null;
    expiresAt: Date | null;
    daysLeft: number | null;
    source: string | null;
  } | null;
}

const DAY = 86_400_000;

/** Can a paid checkout actually complete right now? (gateway enabled + active-environment keys). */
export async function isCheckoutGatewayReady(): Promise<boolean> {
  const rzp = await getRazorpayConfig();
  return rzp.enabled && rzp.configured;
}
export const RENEWAL_REMINDER_DAYS = 15;

export async function getStudentExamAccessSummaries(
  studentId: string,
  exams: { id: string; name: string; publicSlug?: string | null; publicPageEnabled?: boolean }[]
): Promise<ExamAccessSummary[]> {
  if (exams.length === 0) return [];
  const now = new Date();
  const [ctx, gatewayReady] = await Promise.all([loadAccessContext(studentId, now), isCheckoutGatewayReady()]);
  const out = await Promise.all(exams.map((e) => summarise(studentId, e, ctx, gatewayReady, now)));
  return out.filter((s): s is ExamAccessSummary => s !== null);
}

async function summarise(
  studentId: string,
  exam: { id: string; name: string; publicSlug?: string | null; publicPageEnabled?: boolean },
  ctx: AccessContext,
  gatewayReady: boolean,
  now: Date
): Promise<ExamAccessSummary | null> {
  const mockSeries = await getExamMockSeries(exam.id, now);
  const offer = await getSeriesOffer(exam.id, mockSeries?.series.id ?? null, now);
  if (!mockSeries && !offer) return null;
  const comparison = await getSeriesComparison(exam.id, mockSeries, offer);

  const comparisonHref =
    exam.publicSlug && exam.publicPageEnabled !== false ? `${mockSeriesPath(exam.publicSlug)}#plans` : "/student/plans";
  const base = {
    exam: { id: exam.id, name: exam.name },
    series: mockSeries
      ? { id: mockSeries.series.id, name: mockSeries.series.name, planned: mockSeries.planned, published: mockSeries.published }
      : null,
    offer,
    freeMocks: comparison.freeMocks,
    lockedMocks: Math.max(0, comparison.publishedMocks - comparison.freeMocks),
    benefits: paidBenefits(comparison.rows).map((r) => r.feature),
    comparison: comparison.rows,
    display: comparison.display,
    comparisonHref,
  };

  if (ctx.mode === "FREE") return { ...base, state: "FREE_MODE", checkoutHref: null, unavailableReason: null, entitlement: null };

  // A PAID mock of the canonical series (or, with no series, the exam pass):
  // whatever unlocks it is what "Complete Access" means for this exam.
  const access = evaluateContentAccess(
    ctx,
    mockSeries
      ? { kind: "MOCK_TEST", id: "__complete_access__", examId: exam.id, testSeriesId: mockSeries.series.id, accessType: "PAID" }
      : { kind: "SUBJECT_TEST", id: null, examId: exam.id }
  );

  const buyable = offer && offer.purchasable && access.products.some((p) => p.id === offer.product.id);
  const checkoutHref = buyable && gatewayReady ? `/student/checkout/${encodeURIComponent(offer.product.code)}` : null;
  const unavailableReason = checkoutHref
    ? null
    : access.purchasesPaused
      ? "Purchases are temporarily paused. Please check back soon."
      : offer?.showPrice
        ? "Online purchase is not available right now. Please check back soon."
        : null;

  if (access.status === "ACTIVE_SUBSCRIPTION" || access.status === "EXPIRED") {
    const productIds = access.status === "ACTIVE_SUBSCRIPTION" ? access.products.map((p) => p.id) : coveringPaidIds(ctx, exam.id, mockSeries?.series.id ?? null);
    const ents = await prisma.studentEntitlement.findMany({
      where: { studentId, productId: { in: productIds }, status: "ACTIVE" },
      orderBy: { startsAt: "asc" },
      select: { productId: true, startsAt: true, expiresAt: true, source: true, product: { select: { name: true } } },
    });
    const relevant =
      access.status === "ACTIVE_SUBSCRIPTION"
        ? ents.filter((e) => e.startsAt <= now && (e.expiresAt === null || e.expiresAt > now))
        : ents.filter((e) => e.expiresAt !== null && e.expiresAt <= now);
    const primary = relevant.find((e) => e.expiresAt === null) ?? relevant.at(-1) ?? null;
    const expiresAt = access.expiresAt;
    return {
      ...base,
      state: access.status === "ACTIVE_SUBSCRIPTION" ? "ACTIVE" : "EXPIRED",
      checkoutHref,
      unavailableReason,
      entitlement: {
        productIds: [...new Set(relevant.map((e) => e.productId))],
        productName: primary?.product.name ?? offer?.product.name ?? exam.name,
        since: relevant[0]?.startsAt ?? null,
        expiresAt,
        daysLeft: access.status === "ACTIVE_SUBSCRIPTION" && expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY)) : null,
        source: primary?.source ?? null,
      },
    };
  }

  if (access.status === "FREE_ACCESS" && !offer?.showPrice) {
    // No paid product applies to this exam: everything is already free.
    return { ...base, state: "FREE_MODE", checkoutHref: null, unavailableReason: null, entitlement: null };
  }
  return {
    ...base,
    state: access.status === "PAYMENT_REQUIRED" || access.status === "FREE_ACCESS" ? "FREE" : "UNAVAILABLE",
    checkoutHref,
    unavailableReason,
    entitlement: null,
  };
}

function coveringPaidIds(ctx: AccessContext, examId: string, seriesId: string | null): string[] {
  return ctx.products
    .filter(
      (p) =>
        p.accessType === "PAID" &&
        ((p.productType === "EXAM_ACCESS" && p.examId === examId) || (p.productType === "TEST_SERIES" && seriesId !== null && p.testSeriesId === seriesId))
    )
    .map((p) => p.id);
}
