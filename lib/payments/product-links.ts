import type { ProductType } from "@prisma/client";

/** Where "Open Product" / "Start Learning" goes for each product type. Pure, client-safe. */
export function productHref(p: { productType: ProductType; examId: string | null }): string {
  switch (p.productType) {
    case "TEST_SERIES":
    case "MOCK_TEST":
      return "/student/test-series";
    case "LIVE_TEST":
      return "/student/live-tests";
    default:
      return p.examId ? `/student/exams/${p.examId}` : "/student/exams";
  }
}

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  EXAM_ACCESS: "Full Exam Access",
  TEST_SERIES: "Test Series",
  MOCK_TEST: "Mock Test",
  GRAND_TEST: "Grand Test",
  LIVE_TEST: "Live Test",
  PYQ_PACKAGE: "PYQ Package",
};

/** Display status for an entitlement row at server time `now`. */
export function entitlementDisplayStatus(e: { status: string; source: string; expiresAt: Date | null; startsAt: Date }, now: Date) {
  if (e.status === "REVOKED") return "REVOKED" as const;
  if (e.expiresAt && e.expiresAt <= now) return "EXPIRED" as const;
  if (e.source === "FREE") return "FREE" as const;
  if (!e.expiresAt) return "LIFETIME" as const;
  return "ACTIVE" as const;
}
