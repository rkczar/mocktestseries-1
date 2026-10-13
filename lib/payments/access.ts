import "server-only";
import { isPlatformOpen } from "@/lib/platform-controls";
import { EntitlementStatus, type Product, type StudentEntitlement } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPaymentModeForStudent, type PaymentMode } from "@/lib/payments/settings";
import { getPremiumPolicyRuntime, type PremiumPolicyRuntime } from "@/lib/premium-policy";

/**
 * Canonical entitlement / access engine. Payment rows are NEVER consulted
 * here — a successful payment matters only through the StudentEntitlement it
 * granted. Every protected test start (lib/test-attempt.ts) and every
 * question-serving attempt page goes through assertContentAccess(), so UI
 * hiding is never the control.
 *
 * Decision order (server time throughout):
 *   1. Global mode FREE (unless the student is a
 *      payment verification account)            → FREE_ACCESS
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
 *
 * Premium Access Enforcement (lib/premium-policy.ts), when ON, replaces steps
 * 2–7 for the policy exam with evaluatePremiumPolicy(): admin-selected free
 * offerings → active Premium/covering entitlement → active one-time trial →
 * locked. Paid entitlements are always checked before the trial.
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
  productType: Product["productType"];
}

export interface AccessResult {
  status: AccessStatus;
  allowed: boolean;
  mode: PaymentMode;
  /**
   * PAYMENT_REQUIRED / EXPIRED: products that would unlock this content.
   * ACTIVE_SUBSCRIPTION: the products whose active entitlement grants it.
   */
  products: AccessProductRef[];
  expiresAt: Date | null;
  purchasesPaused: boolean;
  /**
   * canStudentAccessProduct only: an individual Mock Test product whose mock
   * is already unlocked by ANOTHER product the student holds (e.g. Complete
   * Series) — nothing to buy.
   */
  coveredBy?: AccessProductRef | null;
  /** Premium Access Enforcement decided this result (Premium content of the policy exam). */
  premium?: boolean;
  /** Allowed only by the student's active Premium Trial (expiresAt = trial end). */
  viaTrial?: boolean;
  /** Allowed only because the attempt started before a cut-off (getAttemptContentAccess grace). */
  viaGrace?: boolean;
}

export type ProductRow = Pick<
  Product,
  "id" | "code" | "name" | "productType" | "examId" | "testSeriesId" | "mockTestId" | "grandTestId" | "liveTestId" | "accessType" | "isActive" | "isVisible" | "purchaseEnabled" | "accessDurationType" | "accessExpiresAt"
>;
type EntRow = Pick<StudentEntitlement, "productId" | "status" | "startsAt" | "expiresAt">;

export interface AccessContext {
  mode: PaymentMode;
  products: ProductRow[];
  entitlements: EntRow[];
  now: Date;
  /** Platform Controls → New Payments paused (display only: never changes `allowed`). */
  purchasesPaused?: boolean;
  /** Premium Access Enforcement in force (null/absent = legacy rules only). */
  policy?: PremiumPolicyRuntime | null;
  /** The student's one-time Premium Trial window, if ever started (only loaded while enforcement is ON). */
  trial?: TrialWindow | null;
}

export interface TrialWindow {
  examId: string;
  startedAt: Date;
  endsAt: Date;
}

export const PRODUCT_SELECT = {
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
  const mode = await getPaymentModeForStudent(studentId);
  if (mode === "FREE") return { mode, products: [], entitlements: [], now };
  const [products, entitlements, paymentsOpen, policy] = await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, select: PRODUCT_SELECT }),
    prisma.studentEntitlement.findMany({
      where: { studentId, status: EntitlementStatus.ACTIVE },
      select: { productId: true, status: true, startsAt: true, expiresAt: true },
    }),
    isPlatformOpen("payments"),
    getPremiumPolicyRuntime(),
  ]);
  const trial = policy
    ? await prisma.studentPremiumTrial.findUnique({ where: { studentId }, select: { examId: true, startedAt: true, endsAt: true } })
    : null;
  return { mode, products, entitlements, now, purchasesPaused: !paymentsOpen, policy, trial };
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

export function isPurchasable(p: ProductRow, now: Date): boolean {
  if (!p.isVisible || !p.purchaseEnabled || p.accessType !== "PAID") return false;
  if (p.accessDurationType === "FIXED_DATE" && (!p.accessExpiresAt || p.accessExpiresAt <= now)) return false;
  return true;
}

function ref(p: ProductRow): AccessProductRef {
  return { id: p.id, code: p.code, name: p.name, productType: p.productType };
}

/** Pure evaluation against a preloaded context — use for lists (one query set, many items). */
export function evaluateContentAccess(ctx: AccessContext, c: ContentDescriptor): AccessResult {
  const base = { mode: ctx.mode, products: [] as AccessProductRef[], expiresAt: null, purchasesPaused: false };
  if (ctx.mode === "FREE") return { ...base, status: "FREE_ACCESS", allowed: true };
  if (ctx.policy?.active && c.examId === ctx.policy.examId) return evaluatePremiumPolicy(ctx, ctx.policy, c);

  const covering = ctx.products.filter((p) => productCovers(p, c));
  if (covering.some((p) => p.accessType === "FREE")) return { ...base, status: "FREE_ACCESS", allowed: true };
  // A mock the admin marked FREE is a free sample even inside a paid series /
  // exam pass (Admin → Test Series → Mock → Access), and even if an
  // individual Mock Test product exists for it: FREE always means open.
  if (c.kind === "MOCK_TEST" && c.accessType === "FREE") {
    return { ...base, status: "FREE_ACCESS", allowed: true };
  }
  const paid = covering.filter((p) => p.accessType === "PAID");
  if (paid.length === 0 && c.accessType !== "PAID") return { ...base, status: "FREE_ACCESS", allowed: true };

  const paidIds = new Set(paid.map((p) => p.id));
  const ents = ctx.entitlements.filter((e) => paidIds.has(e.productId));
  const active = ents.filter((e) => entitlementIsActive(e, ctx.now));
  if (active.length > 0) {
    const expiresAt = active.some((e) => e.expiresAt === null)
      ? null
      : new Date(Math.max(...active.map((e) => e.expiresAt!.getTime())));
    const granting = new Set(active.map((e) => e.productId));
    return { ...base, status: "ACTIVE_SUBSCRIPTION", allowed: true, expiresAt, products: paid.filter((p) => granting.has(p.id)).map(ref) };
  }

  const purchasable = paid.filter((p) => isPurchasable(p, ctx.now));
  const purchasesPaused = ctx.mode === "MAINTENANCE" || ctx.purchasesPaused === true;
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

/** Is this item one of the admin-selected free offerings? */
export function isPolicyFreeContent(policy: PremiumPolicyRuntime, c: ContentDescriptor): boolean {
  if (c.kind === "PREVIOUS_YEAR_PAPER") return Boolean(c.id) && c.id === policy.freePyqId;
  if (c.kind === "MOCK_TEST") return Boolean(c.id) && policy.freeMockTestIds.has(c.id!);
  return false;
}

export function trialIsActive(trial: TrialWindow | null | undefined, examId: string, now: Date): trial is TrialWindow {
  return Boolean(trial) && trial!.examId === examId && trial!.startedAt <= now && trial!.endsAt > now;
}

/**
 * Premium Access Enforcement for one item of the policy exam. Legacy FREE
 * flags / FREE products are deliberately not consulted; PAID products keep
 * working exactly as sold (a Premium product unlocks the whole exam, any
 * other product still unlocks what it covers).
 */
function evaluatePremiumPolicy(ctx: AccessContext, policy: PremiumPolicyRuntime, c: ContentDescriptor): AccessResult {
  const base = { mode: ctx.mode, products: [] as AccessProductRef[], expiresAt: null, purchasesPaused: false, premium: true };
  if (isPolicyFreeContent(policy, c)) return { ...base, premium: false, status: "FREE_ACCESS", allowed: true };

  const covering = ctx.products.filter(
    (p) => p.accessType === "PAID" && ((policy.premiumProductIds.has(p.id) && p.examId === policy.examId) || productCovers(p, c))
  );
  const coveringIds = new Set(covering.map((p) => p.id));
  const ents = ctx.entitlements.filter((e) => coveringIds.has(e.productId));
  const active = ents.filter((e) => entitlementIsActive(e, ctx.now));
  if (active.length > 0) {
    const expiresAt = active.some((e) => e.expiresAt === null) ? null : new Date(Math.max(...active.map((e) => e.expiresAt!.getTime())));
    const granting = new Set(active.map((e) => e.productId));
    return { ...base, status: "ACTIVE_SUBSCRIPTION", allowed: true, expiresAt, products: covering.filter((p) => granting.has(p.id)).map(ref) };
  }

  // Premium plans first, so a single-product paywall lands on the Premium checkout.
  const purchasable = covering
    .filter((p) => isPurchasable(p, ctx.now))
    .sort((a, b) => Number(policy.premiumProductIds.has(b.id)) - Number(policy.premiumProductIds.has(a.id)))
    .map(ref);
  if (trialIsActive(ctx.trial, policy.examId, ctx.now)) {
    return { ...base, status: "ACTIVE_SUBSCRIPTION", allowed: true, viaTrial: true, expiresAt: ctx.trial.endsAt, products: purchasable };
  }

  const purchasesPaused = ctx.mode === "MAINTENANCE" || ctx.purchasesPaused === true;
  const expired = ents.filter((e) => e.expiresAt !== null && e.expiresAt <= ctx.now);
  if (expired.length > 0) {
    return {
      ...base,
      status: "EXPIRED",
      allowed: false,
      purchasesPaused,
      expiresAt: new Date(Math.max(...expired.map((e) => e.expiresAt!.getTime()))),
      products: purchasable,
    };
  }
  if (purchasable.length > 0) return { ...base, status: "PAYMENT_REQUIRED", allowed: false, purchasesPaused, products: purchasable };
  return { ...base, status: "NOT_AVAILABLE", allowed: false, purchasesPaused };
}

/** Minimal attempt shape the grace rules need (TestAttempt rows satisfy it). */
export interface GraceAttempt {
  startedAt: Date;
  durationMode?: string | null;
}

/** Untimed-attempt grace when no policy value applies (matches the policy default). */
export const DEFAULT_ATTEMPT_GRACE_MINUTES = 60;

/**
 * May an IN_PROGRESS attempt that is now denied still be finished? Only when
 * it was legitimately started before a cut-off:
 *   - during the student's trial (cut-off = trial end),
 *   - before Premium enforcement was switched ON, when the legacy rules
 *     allowed it (cut-off = enforcedSince), or
 *   - while a covering paid entitlement was still valid (cut-off = its
 *     expiry) — a plan running out mid-test never cuts the test off.
 * Timed attempts then run to their own frozen time limit (the engine
 * finalizes them on expiry); untimed (UNLIMITED) attempts get the grace
 * minutes after the cut-off. Never starts anything new.
 */
export function attemptGraceAllows(ctx: AccessContext, c: ContentDescriptor, attempt: GraceAttempt, denied?: AccessResult): boolean {
  const policy = ctx.policy?.active && c.examId === ctx.policy.examId ? ctx.policy : null;
  const untimed = attempt.durationMode === "UNLIMITED";
  const graceMs = (policy?.attemptGraceMinutes ?? DEFAULT_ATTEMPT_GRACE_MINUTES) * 60_000;
  const within = (cutoff: Date) => attempt.startedAt < cutoff && (!untimed || ctx.now.getTime() < cutoff.getTime() + graceMs);
  if (policy) {
    const trial = ctx.trial;
    if (trial && trial.examId === policy.examId && attempt.startedAt >= trial.startedAt && within(trial.endsAt)) return true;
    if (policy.enforcedSince && within(policy.enforcedSince) && evaluateContentAccess({ ...ctx, policy: null, trial: null }, c).allowed) return true;
  }
  const result = denied ?? evaluateContentAccess(ctx, c);
  if (result.status === "EXPIRED" && result.expiresAt && within(result.expiresAt)) return true;
  return false;
}

/**
 * Access for an EXISTING attempt (run / OMR entry pages, resume): the normal
 * decision, plus the grace rules above. Use this — never getContentAccess —
 * wherever an attempt's questions are served.
 */
export async function getAttemptContentAccess(
  studentId: string,
  attempt: Parameters<typeof describeAttemptContent>[0] & GraceAttempt
): Promise<AccessResult> {
  const ctx = await loadAccessContext(studentId);
  const c = describeAttemptContent(attempt);
  const access = evaluateContentAccess(ctx, c);
  if (access.allowed || !attemptGraceAllows(ctx, c, attempt, access)) return access;
  return { ...access, status: "ACTIVE_SUBSCRIPTION", allowed: true, viaGrace: true };
}

// Answer save / reveal gate. Saves are frequent (every option click), so an
// ALLOWED decision is remembered per (attempt, student) for 30s in this
// worker; a denial is never cached. The worst case is a save accepted up to
// 30s after access ended — well inside the grace rules above.
const ANSWER_ACCESS_TTL_MS = 30_000;
const answerAccessAllowedUntil = new Map<string, number>();

/**
 * Every answer save and reveal goes through this (lib/test-attempt.ts
 * loadEditableQuestion), so a direct Server Action call can never write or
 * reveal answers on an attempt whose content the student may no longer use.
 * Same decision as the run page: access, or the attempt's grace.
 */
export async function getAttemptAnswerAccess(
  studentId: string,
  attempt: Parameters<typeof describeAttemptContent>[0] & GraceAttempt & { id: string }
): Promise<AccessResult | null> {
  const key = `${attempt.id}:${studentId}`;
  const now = Date.now();
  const until = answerAccessAllowedUntil.get(key);
  if (until && until > now) return null;
  const access = await getAttemptContentAccess(studentId, attempt);
  if (!access.allowed) {
    answerAccessAllowedUntil.delete(key);
    return access;
  }
  if (answerAccessAllowedUntil.size > 20_000) answerAccessAllowedUntil.clear();
  answerAccessAllowedUntil.set(key, now + ANSWER_ACCESS_TTL_MS);
  return null;
}

/** Test hook: forget cached answer-access decisions (scripts only). */
export function clearAnswerAccessCache() {
  answerAccessAllowedUntil.clear();
}

export async function getContentAccess(studentId: string, c: ContentDescriptor): Promise<AccessResult> {
  return evaluateContentAccess(await loadAccessContext(studentId), c);
}

export class PaymentRequiredError extends Error {
  constructor(
    public readonly access: AccessResult,
    public readonly content?: ContentDescriptor
  ) {
    super(accessDeniedMessage(access));
    this.name = "PaymentRequiredError";
  }
}

export function accessDeniedMessage(a: AccessResult): string {
  if (a.premium && (a.status === "PAYMENT_REQUIRED" || a.status === "NOT_AVAILABLE"))
    return a.purchasesPaused
      ? "This is a Premium test. Purchases are temporarily paused — please try again later."
      : "This is a Premium test. Upgrade to Premium (or start your one-time free trial from the dashboard) to continue.";
  if (a.status === "EXPIRED") return "Your access to this test has expired. Renew to continue.";
  if (a.status === "PAYMENT_REQUIRED")
    return a.purchasesPaused
      ? "This test requires a purchase. Purchases are temporarily paused — please try again later."
      : "This test requires a purchase. Unlock it to start.";
  return "This test is not available right now.";
}

/** Throws PaymentRequiredError unless the student may receive this content's questions. */
export async function assertContentAccess(studentId: string, c: ContentDescriptor): Promise<AccessResult> {
  const access = await getContentAccess(studentId, c);
  if (!access.allowed) throw new PaymentRequiredError(access, c);
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
  const mode = await getPaymentModeForStudent(studentId);
  const product = await prisma.product.findUnique({ where: { id: productId }, select: PRODUCT_SELECT });
  const purchasesPaused = mode === "MAINTENANCE" || (mode !== "FREE" && !(await isPlatformOpen("payments")));
  const base = { mode, products: product ? [ref(product)] : [], expiresAt: null, purchasesPaused };
  if (!product || !product.isActive) return { ...base, status: "NOT_AVAILABLE", allowed: false };
  if (mode === "FREE" || product.accessType === "FREE") return { ...base, status: "FREE_ACCESS", allowed: true };

  // Individual Mock Test product: a FREE mock needs no purchase, and a mock
  // already unlocked by another product (Complete Series / Exam Access) must
  // not be sold again.
  if (product.productType === "MOCK_TEST") {
    const mock = product.mockTestId
      ? await prisma.mockTest.findUnique({ where: { id: product.mockTestId }, select: { id: true, examId: true, testSeriesId: true, accessType: true } })
      : null;
    if (!mock) return { ...base, status: "NOT_AVAILABLE", allowed: false };
    const ctx = await loadAccessContext(studentId, now);
    const content0 = { kind: "MOCK_TEST" as const, id: mock.id, examId: mock.examId, testSeriesId: mock.testSeriesId, accessType: mock.accessType };
    // Under Premium Access Enforcement only the admin-selected free offerings are free; the legacy flag is ignored.
    const underPolicy = Boolean(ctx.policy?.active && mock.examId === ctx.policy.examId);
    if (underPolicy ? isPolicyFreeContent(ctx.policy!, content0) : mock.accessType === "FREE") return { ...base, status: "FREE_ACCESS", allowed: true };
    // A trial never counts as "already covered": trial students can still buy.
    const content = evaluateContentAccess(
      { ...ctx, trial: null, products: ctx.products.filter((p) => p.id !== product.id) },
      content0
    );
    if (content.status === "ACTIVE_SUBSCRIPTION") {
      return { ...base, status: "ACTIVE_SUBSCRIPTION", allowed: true, expiresAt: content.expiresAt, coveredBy: content.products[0] ?? null };
    }
  }

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
export function paywallHref(a: AccessResult, content?: ContentDescriptor): string {
  // Premium content: the dashboard popup shows this student's options (free trial if unused, else Buy Premium).
  if (a.premium && (a.status === "PAYMENT_REQUIRED" || a.status === "NOT_AVAILABLE")) return "/student/dashboard?premium=locked";
  if (!a.purchasesPaused && a.products.length === 1) return `/student/checkout/${encodeURIComponent(a.products[0].code)}`;
  // Several ways to unlock one mock (e.g. this mock alone or Complete Series):
  // its details page lists every option with its current price.
  if (!a.purchasesPaused && a.products.length > 1 && content?.kind === "MOCK_TEST" && content.id)
    return `/student/test-series/${encodeURIComponent(content.id)}`;
  return `/student/plans?locked=${a.status === "EXPIRED" ? "expired" : "1"}`;
}
