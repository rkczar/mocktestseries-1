import "server-only";
import type { ProductType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPaymentMode, type PaymentMode } from "@/lib/payments/settings";
import { computeProductPrice, describeAccessDuration, type ProductPrice } from "@/lib/payments/pricing";
import { canStudentAccessProduct, isPurchasable, loadAccessContext } from "@/lib/payments/access";
import { productHref } from "@/lib/payments/product-links";
import { paidBenefits, type OfferDisplayRow } from "@/lib/payments/offer-display-shared";
import { RENEWAL_REMINDER_DAYS } from "@/lib/payments/student-access";
import { isPlatformOpen } from "@/lib/platform-controls";
import { displayExamName } from "@/lib/exam-display";
import { getExamMockSeries, getSeriesComparison, getSeriesOffer, type SeriesComparison } from "@/lib/mock-series";

/**
 * Public Plans & Pricing catalog (/plans-and-pricing). Reads the Admin →
 * Payments → Products rows directly — every price, discount, validity and
 * benefit comes from there or from the existing comparison engine
 * (lib/mock-series.ts), never from this file. Anonymous: no student data
 * here; per-student buttons come from getPlanStates().
 */

export type PlanCategoryKey = "complete-access" | "test-series" | "pyq" | "grand-tests" | "live-tests" | "single-mocks";

const CATEGORY_BY_TYPE: Record<ProductType, { key: PlanCategoryKey; label: string; order: number }> = {
  EXAM_ACCESS: { key: "complete-access", label: "Complete Access Plans", order: 0 },
  TEST_SERIES: { key: "test-series", label: "Test Series Packages", order: 1 },
  PYQ_PACKAGE: { key: "pyq", label: "Previous Year Paper Packages", order: 2 },
  GRAND_TEST: { key: "grand-tests", label: "Grand Tests", order: 3 },
  LIVE_TEST: { key: "live-tests", label: "Live Tests", order: 4 },
  MOCK_TEST: { key: "single-mocks", label: "Single Mock Tests", order: 5 },
};

export interface CatalogPlan {
  id: string;
  code: string;
  /** Mock title for single mocks (the product name repeats exam + series), else the product name. */
  title: string;
  description: string | null;
  productType: ProductType;
  price: ProductPrice;
  accessDuration: string;
  /** Where an owner opens it (Start Test / View Series). */
  openHref: string;
  durationMinutes: number | null;
  /** Admin-configured "Complete" benefits — series / exam passes only. */
  benefits: OfferDisplayRow[];
}

export interface CatalogCategory {
  key: PlanCategoryKey;
  label: string;
  plans: CatalogPlan[];
}

export interface CatalogExamGroup {
  exam: { id: string; name: string; publicSlug: string | null };
  categories: CatalogCategory[];
  comparison: SeriesComparison | null;
}

export interface PlanCatalog {
  mode: PaymentMode;
  /** Prices are real and payable (not FREE mode). */
  showPrices: boolean;
  /** PAID mode with Platform Controls → Payments open. */
  purchasesOpen: boolean;
  groups: CatalogExamGroup[];
  planCount: number;
}

export async function getPublicPlanCatalog(now: Date = new Date()): Promise<PlanCatalog> {
  const [mode, paymentsOpen, products] = await Promise.all([
    getPaymentMode(),
    isPlatformOpen("payments"),
    prisma.product.findMany({
      where: { isActive: true, isVisible: true, purchaseEnabled: true, accessType: "PAID" },
      include: {
        exam: { select: { id: true, name: true, isActive: true, order: true, publicSlug: true, publicPageEnabled: true } },
        testSeries: { select: { status: true, isActive: true } },
        mockTest: { select: { title: true, status: true, accessType: true, durationMinutes: true } },
        grandTest: { select: { title: true, status: true, durationMinutes: true } },
        liveTest: { select: { title: true, status: true } },
      },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // Only products a student could actually buy and use today.
  const listed = products.filter((p) => {
    if (!isPurchasable(p, now) || computeProductPrice(p, now).isFree) return false;
    if (!p.exam?.isActive) return false;
    switch (p.productType) {
      case "TEST_SERIES":
        return p.testSeries?.status === "PUBLISHED" && p.testSeries.isActive;
      case "MOCK_TEST":
        // A FREE mock is never sold (lib/payments/access.ts canStudentAccessProduct).
        return p.mockTest?.status === "PUBLISHED" && p.mockTest.accessType === "PAID";
      case "GRAND_TEST":
        return p.grandTest?.status === "PUBLISHED";
      case "LIVE_TEST":
        return p.liveTest?.status === "SCHEDULED" || p.liveTest?.status === "LIVE";
      default:
        return true;
    }
  });

  const byExam = new Map<string, typeof listed>();
  for (const p of listed) byExam.set(p.examId!, [...(byExam.get(p.examId!) ?? []), p]);

  const groups = await Promise.all(
    [...byExam.values()].map(async (rows): Promise<CatalogExamGroup & { order: number }> => {
      const exam = rows[0].exam!;
      const series = await getExamMockSeries(exam.id, now);
      const offer = await getSeriesOffer(exam.id, series?.series.id ?? null, now);
      const comparison = series ? await getSeriesComparison(exam.id, series, offer) : null;
      const benefits = comparison ? paidBenefits(comparison.rows) : [];

      const categories = new Map<PlanCategoryKey, CatalogCategory & { order: number }>();
      for (const p of rows) {
        const cat = CATEGORY_BY_TYPE[p.productType];
        const entry = categories.get(cat.key) ?? { key: cat.key, label: cat.label, order: cat.order, plans: [] };
        entry.plans.push({
          id: p.id,
          code: p.code,
          title: p.mockTest?.title ?? p.grandTest?.title ?? p.liveTest?.title ?? p.name,
          description: p.description,
          productType: p.productType,
          price: computeProductPrice(p, now),
          accessDuration: describeAccessDuration(p),
          openHref: productHref(p),
          durationMinutes: p.mockTest?.durationMinutes ?? p.grandTest?.durationMinutes ?? null,
          benefits: p.productType === "TEST_SERIES" || p.productType === "EXAM_ACCESS" ? benefits : [],
        });
        categories.set(cat.key, entry);
      }
      return {
        order: exam.order,
        exam: { id: exam.id, name: displayExamName(exam.name), publicSlug: exam.publicPageEnabled ? exam.publicSlug : null },
        categories: [...categories.values()].sort((a, b) => a.order - b.order).map((c) => ({ key: c.key, label: c.label, plans: c.plans })),
        comparison,
      };
    })
  );

  return {
    mode,
    showPrices: mode !== "FREE",
    purchasesOpen: mode === "PAID" && paymentsOpen,
    groups: groups.sort((a, b) => a.order - b.order).map((g) => ({ exam: g.exam, categories: g.categories, comparison: g.comparison })),
    planCount: listed.length,
  };
}

// ---------------------------------------------------------------------------
// Per-student button state — same rules as checkout (canStudentAccessProduct).
// ---------------------------------------------------------------------------

export type PlanStateKind = "ACTIVE" | "COVERED" | "FREE" | "EXPIRED" | "BUY" | "UNAVAILABLE";

export interface PlanState {
  kind: PlanStateKind;
  expiresAt: Date | null;
  coveredBy: string | null;
  /** Active but inside the renewal reminder window: offer Renew next to Open. */
  renewSoon: boolean;
  purchasesPaused: boolean;
}

/** Types an Exam Access pass already unlocks for the same exam. */
const EXAM_PASS_COVERS: ProductType[] = ["TEST_SERIES", "PYQ_PACKAGE", "GRAND_TEST", "LIVE_TEST"];

export async function getPlanStates(studentId: string, catalog: PlanCatalog, now: Date = new Date()): Promise<Map<string, PlanState>> {
  const plans = catalog.groups.flatMap((g) => g.categories.flatMap((c) => c.plans.map((p) => ({ ...p, examId: g.exam.id }))));
  const ctx = await loadAccessContext(studentId, now);
  const activeIds = new Set(
    ctx.entitlements.filter((e) => e.startsAt <= now && (e.expiresAt === null || e.expiresAt > now)).map((e) => e.productId)
  );
  const examPasses = ctx.products.filter((p) => p.productType === "EXAM_ACCESS" && p.accessType === "PAID" && activeIds.has(p.id));
  const renewBy = now.getTime() + RENEWAL_REMINDER_DAYS * 86_400_000;

  const entries = await Promise.all(
    plans.map(async (plan): Promise<[string, PlanState]> => {
      const a = await canStudentAccessProduct(studentId, plan.id, now);
      const base = { expiresAt: a.expiresAt, coveredBy: null, renewSoon: false, purchasesPaused: a.purchasesPaused };
      const pass = EXAM_PASS_COVERS.includes(plan.productType) ? examPasses.find((p) => p.examId === plan.examId && p.id !== plan.id) : undefined;
      if (a.status === "ACTIVE_SUBSCRIPTION" && a.coveredBy) return [plan.id, { ...base, kind: "COVERED", coveredBy: a.coveredBy.name }];
      if (a.status === "ACTIVE_SUBSCRIPTION") {
        const renewSoon = a.expiresAt !== null && a.expiresAt.getTime() <= renewBy && !a.purchasesPaused;
        return [plan.id, { ...base, kind: "ACTIVE", renewSoon }];
      }
      if (pass) return [plan.id, { ...base, kind: "COVERED", coveredBy: pass.name }];
      if (a.status === "FREE_ACCESS") return [plan.id, { ...base, kind: "FREE" }];
      if (a.status === "EXPIRED") return [plan.id, { ...base, kind: "EXPIRED" }];
      if (a.status === "PAYMENT_REQUIRED") return [plan.id, { ...base, kind: "BUY" }];
      return [plan.id, { ...base, kind: "UNAVAILABLE" }];
    })
  );
  return new Map(entries);
}
