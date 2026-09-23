import "server-only";
import { EntitlementStatus, type Product, type StudentEntitlement } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPaymentMode, type PaymentMode } from "@/lib/payments/settings";

/**
 * Canonical entitlement / access engine. Payment rows are NEVER consulted
 * here — a successful payment matters only through the StudentEntitlement it
 * granted. Every protected test start (lib/test-attempt.ts) and every
 * question-serving attempt page goes through assertContentAccess(), so UI
 * hiding is never the control.
 *
 * Decision order (server time throughout):
 *   1. Global mode FREE                         → FREE_ACCESS
 *   2. Any covering active product is FREE      → FREE_ACCESS
 *   3. No covering PAID product and the content
 *      itself isn't flagged PAID                → FREE_ACCESS
 *   4. Active, non-revoked entitlement on any
 *      covering PAID product                    → ACTIVE_SUBSCRIPTION
 *   5. Only expired entitlements                 → EXPIRED
 *   6. A purchasable covering product exists     → PAYMENT_REQUIRED
 *   7. Otherwise                                 → NOT_AVAILABLE
 *
 * FREE mode deliberately writes no entitlements, so switching back to PAID
 * leaves only real purchases/grants in force.
 */

export type AccessStatus = "FREE_ACCESS" | "ACTIVE_SUBSCRIPTION" | "PAYMENT_REQUIRED" | "EXPIRED" | "NOT_AVAILABLE";

export type ContentKind = "MOCK_TEST" | "GRAND_TEST" | "LIVE_TEST" | "PREVIOUS_YEAR_PAPER" | "SUBJECT_TEST" | "CUSTOM_MODULE";

export interface ContentDescriptor {
  kind: ContentKind;
  id: string | null;
  examId: string;
  testSeriesId?: string | null;
  /** Legacy per-content flag (MockTest/GrandTest/LiveTest/CustomModule.accessType). */
  accessType?: "FREE" | "PAID" | null;
}

export interface AccessProductRef {
  id: string;
  code: string;
  name: string;
}

export interface AccessResult {
  status: AccessStatus;
  allowed: boolean;
  mode: PaymentMode;
  /** Products that would unlock this content (for PAYMENT_REQUIRED / EXPIRED). */
  products: AccessProductRef[];
  expiresAt: Date | null;
  purchasesPaused: boolean;
}

type ProductRow = Pick<
  Product,
  "id" | "code" | "name" | "productType" | "examId" | "testSeriesId" | "mockTestId" | "grandTestId" | "liveTestId" | "accessType" | "isActive" | "isVisible" | "purchaseEnabled" | "accessDurationType" | "accessExpiresAt"
>;
type EntRow = Pick<StudentEntitlement, "productId" | "status" | "startsAt" | "expiresAt">;

export interface AccessContext {
  mode: PaymentMode;
  products: ProductRow[];
  entitlements: EntRow[];
  now: Date;
}

const PRODUCT_SELECT = {
  id: true,
  code: true,
  name: true,
  productType: true,
  examId: true,
  testSeriesId: true,
  mockTestId: true,
  grandTestId: true,
  liveTestId: true,
  accessType: true,
  isActive: true,
  isVisible: true,
  purchaseEnabled: true,
  accessDurationType: true,
  accessExpiresAt: true,
} as const;

export async function loadAccessContext(studentId: string, now: Date = new Date()): Promise<AccessContext> {
  const mode = await getPaymentMode();
  if (mode === "FREE") return { mode, products: [], entitlements: [], now };
  const [products, entitlements] = await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, select: PRODUCT_SELECT }),
    prisma.studentEntitlement.findMany({
      where: { studentId, status: EntitlementStatus.ACTIVE },
      select: { productId: true, status: true, startsAt: true, expiresAt: true },
    }),
  ]);
  return { mode, products, entitlements, now };
}

/** Does `product` unlock `content`? */
export function productCovers(product: ProductRow, c: ContentDescriptor): boolean {
  switch (product.productType) {
    case "EXAM_ACCESS":
      return product.examId === c.examId;
    case "PYQ_PACKAGE":
      return c.kind === "PREVIOUS_YEAR_PAPER" && product.examId === c.examId;
    case "TEST_SERIES":
      return c.kind === "MOCK_TEST" && !!c.testSeriesId && product.testSeriesId === c.testSeriesId;
    case "MOCK_TEST":
      return c.kind === "MOCK_TEST" && product.mockTestId === c.id;
    case "GRAND_TEST":
      return c.kind === "GRAND_TEST" && product.grandTestId === c.id;
    case "LIVE_TEST":
      return c.kind === "LIVE_TEST" && product.liveTestId === c.id;
    default:
      return false;
  }
}

function entitlementIsActive(e: EntRow, now: Date): boolean {
  return e.status === EntitlementStatus.ACTIVE && e.startsAt <= now && (e.expiresAt === null || e.expiresAt > now);
}

function isPurchasable(p: ProductRow, now: Date): boolean {
  if (!p.isVisible || !p.purchaseEnabled || p.accessType !== "PAID") return false;
  if (p.accessDurationType === "FIXED_DATE" && (!p.accessExpiresAt || p.accessExpiresAt <= now)) return false;
  return true;
}

function ref(p: ProductRow): AccessProductRef {
  return { id: p.id, code: p.code, name: p.name };
}

/** Pure evaluation against a preloaded context — use for lists (one query set, many items). */
export function evaluateContentAccess(ctx: AccessContext, c: ContentDescriptor): AccessResult {
  const base = { mode: ctx.mode, products: [] as AccessProductRef[], expiresAt: null, purchasesPaused: false };
  if (ctx.mode === "FREE") return { ...base, status: "FREE_ACCESS", allowed: true };

  const covering = ctx.products.filter((p) => productCovers(p, c));
  if (covering.some((p) => p.accessType === "FREE")) return { ...base, status: "FREE_ACCESS", allowed: true };
  const paid = covering.filter((p) => p.accessType === "PAID");
  if (paid.length === 0 && c.accessType !== "PAID") return { ...base, status: "FREE_ACCESS", allowed: true };

  const paidIds = new Set(paid.map((p) => p.id));
  const ents = ctx.entitlements.filter((e) => paidIds.has(e.productId));
  const active = ents.filter((e) => entitlementIsActive(e, ctx.now));
  if (active.length > 0) {
    const expiresAt = active.some((e) => e.expiresAt === null)
      ? null
      : new Date(Math.max(...active.map((e) => e.expiresAt!.getTime())));
    return { ...base, status: "ACTIVE_SUBSCRIPTION", allowed: true, expiresAt, products: paid.map(ref) };
  }

  const purchasable = paid.filter((p) => isPurchasable(p, ctx.now));
  const purchasesPaused = ctx.mode === "MAINTENANCE";
  const expired = ents.filter((e) => e.expiresAt !== null && e.expiresAt <= ctx.now);
  if (expired.length > 0) {
    return {
      ...base,
      status: "EXPIRED",
      allowed: false,
      purchasesPaused,
      expiresAt: new Date(Math.max(...expired.map((e) => e.expiresAt!.getTime()))),
      products: purchasable.map(ref),
    };
  }
  if (purchasable.length > 0) {
    return { ...base, status: "PAYMENT_REQUIRED", allowed: false, purchasesPaused, products: purchasable.map(ref) };
  }
  return { ...base, status: "NOT_AVAILABLE", allowed: false, purchasesPaused };
}

export async function getContentAccess(studentId: string, c: ContentDescriptor): Promise<AccessResult> {
  return evaluateContentAccess(await loadAccessContext(studentId), c);
}

export class PaymentRequiredError extends Error {
  constructor(public readonly access: AccessResult) {
    super(accessDeniedMessage(access));
    this.name = "PaymentRequiredError";
  }
}

export function accessDeniedMessage(a: AccessResult): string {
  if (a.status === "EXPIRED") return "Your access to this test has expired. Renew to continue.";
  if (a.status === "PAYMENT_REQUIRED")
    return a.purchasesPaused
      ? "This is premium content. Purchases are temporarily paused — please try again later."
      : "This is premium content. Unlock it to start the test.";
  return "This test is not available right now.";
}

/** Throws PaymentRequiredError unless the student may receive this content's questions. */
export async function assertContentAccess(studentId: string, c: ContentDescriptor): Promise<AccessResult> {
  const access = await getContentAccess(studentId, c);
  if (!access.allowed) throw new PaymentRequiredError(access);
  return access;
}

/**
 * Descriptor for an existing attempt, so question-serving pages (run / OMR
 * entry) re-check access on every load — an attempt started in FREE mode
 * can't keep serving paid questions after the platform switches to PAID.
 */
export function describeAttemptContent(attempt: {
  sourceType: string;
  testType: string;
  examId: string;
  mockTestId: string | null;
  grandTestId: string | null;
  liveTestId: string | null;
  previousYearPaperId: string | null;
  customModuleId: string | null;
  mockTest?: { testSeriesId: string | null; accessType: "FREE" | "PAID" } | null;
  grandTest?: { accessType: "FREE" | "PAID" } | null;
  liveTest?: { accessType: "FREE" | "PAID" } | null;
  customModule?: { accessType: "FREE" | "PAID" } | null;
}): ContentDescriptor {
  if (attempt.mockTestId)
    return { kind: "MOCK_TEST", id: attempt.mockTestId, examId: attempt.examId, testSeriesId: attempt.mockTest?.testSeriesId ?? null, accessType: attempt.mockTest?.accessType ?? null };
  if (attempt.grandTestId)
    return { kind: "GRAND_TEST", id: attempt.grandTestId, examId: attempt.examId, accessType: attempt.grandTest?.accessType ?? null };
  if (attempt.liveTestId)
    return { kind: "LIVE_TEST", id: attempt.liveTestId, examId: attempt.examId, accessType: attempt.liveTest?.accessType ?? null };
  if (attempt.previousYearPaperId) return { kind: "PREVIOUS_YEAR_PAPER", id: attempt.previousYearPaperId, examId: attempt.examId };
  if (attempt.customModuleId)
    return { kind: "CUSTOM_MODULE", id: attempt.customModuleId, examId: attempt.examId, accessType: attempt.customModule?.accessType ?? null };
  return { kind: "SUBJECT_TEST", id: null, examId: attempt.examId };
}

/**
 * canStudentAccessProduct — product-level view used by checkout ("Continue"
 * vs "Buy Now" vs "Renew"). Same rules as content access.
 */
export async function canStudentAccessProduct(studentId: string, productId: string, now: Date = new Date()): Promise<AccessResult> {
  const mode = await getPaymentMode();
  const product = await prisma.product.findUnique({ where: { id: productId }, select: PRODUCT_SELECT });
  const base = { mode, products: product ? [ref(product)] : [], expiresAt: null, purchasesPaused: mode === "MAINTENANCE" };
  if (!product || !product.isActive) return { ...base, status: "NOT_AVAILABLE", allowed: false };
  if (mode === "FREE" || product.accessType === "FREE") return { ...base, status: "FREE_ACCESS", allowed: true };

  const ents = await prisma.studentEntitlement.findMany({
    where: { studentId, productId, status: EntitlementStatus.ACTIVE },
    select: { productId: true, status: true, startsAt: true, expiresAt: true },
  });
  const active = ents.filter((e) => entitlementIsActive(e, now));
  if (active.length > 0) {
    const expiresAt = active.some((e) => e.expiresAt === null) ? null : new Date(Math.max(...active.map((e) => e.expiresAt!.getTime())));
    return { ...base, status: "ACTIVE_SUBSCRIPTION", allowed: true, expiresAt };
  }
  const expired = ents.filter((e) => e.expiresAt !== null && e.expiresAt <= now);
  if (expired.length > 0)
    return { ...base, status: "EXPIRED", allowed: false, expiresAt: new Date(Math.max(...expired.map((e) => e.expiresAt!.getTime()))) };
  if (!isPurchasable(product, now)) return { ...base, status: "NOT_AVAILABLE", allowed: false };
  return { ...base, status: "PAYMENT_REQUIRED", allowed: false };
}

/** Where to send a student who was denied: the single unlocking product's checkout, else the plans list. */
export function paywallHref(a: AccessResult): string {
  if (!a.purchasesPaused && a.products.length === 1) return `/student/checkout/${encodeURIComponent(a.products[0].code)}`;
  return `/student/plans?locked=${a.status === "EXPIRED" ? "expired" : "1"}`;
}
