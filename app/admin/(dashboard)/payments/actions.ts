"use server";

import { revalidatePath } from "next/cache";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import { z } from "zod";
import {
  AccessDurationType,
  AccessType,
  CouponDiscountType,
  EntitlementSource,
  EntitlementStatus,
  Prisma,
  ProductType,
  RefundAccessPolicy,
  SaleDiscountType,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { logPaymentAudit } from "@/lib/payments/audit";
import { rupeesToPaise } from "@/lib/payments/money";
import { validatePricingConfig } from "@/lib/payments/pricing";
import { COUPON_CODE_RE } from "@/lib/payments/coupons";
import {
  getInvoiceSettings,
  getPaymentMode,
  getPaymentPolicy,
  PAYMENT_MODES,
  saveInvoiceSettings,
  savePaymentPolicy,
  setPaymentMode,
  type PaymentMode,
} from "@/lib/payments/settings";
import { getRazorpayConfig, saveRazorpayConfig, testRazorpayConnection, RazorpayConfigError } from "@/lib/razorpay-config";
import { reconcileOrder, ensureFulfilment, expireStaleOrders } from "@/lib/payments/orders";
import { requestRefund, RefundError } from "@/lib/payments/refunds";

/**
 * Every mutation here requires PAYMENTS_MANAGE (MASTER_ADMIN only) —
 * FULL_ADMIN holds PAYMENTS_VIEW and gets FORBIDDEN from each of these,
 * regardless of what the UI renders. Each change is audit-logged with safe
 * before/after facts; credential saves log only which fields were rotated.
 */

export interface FormState {
  error?: string;
  success?: string;
}

async function manage() {
  return requirePermission(PERMISSIONS.PAYMENTS_MANAGE);
}

function fail(e: unknown): FormState {
  if (e instanceof UnauthorizedError) return { error: "Forbidden — only Master Admin can change payment settings." };
  if (e instanceof RazorpayConfigError || e instanceof RefundError) return { error: e.message };
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? "Invalid input." };
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { error: "That code is already in use." };
  return { error: "Something went wrong. Nothing was changed." };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optStr = (fd: FormData, k: string, max = 500) => {
  const v = str(fd, k);
  return v ? v.slice(0, max) : null;
};
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
/** "YYYY-MM-DDTHH:mm" from <input type=datetime-local>, interpreted as IST. */
function istDate(fd: FormData, k: string): Date | null {
  const v = str(fd, k);
  if (!v) return null;
  const d = new Date(/T\d{2}:\d{2}$/.test(v) ? `${v}:00+05:30` : /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59+05:30` : v);
  if (Number.isNaN(d.getTime())) throw new z.ZodError([{ code: "custom", message: `Invalid date for ${k}.`, path: [k], input: v }]);
  return d;
}
function paise(fd: FormData, k: string, label: string): number | null {
  const v = str(fd, k);
  if (!v) return null;
  const p = rupeesToPaise(v);
  if (p === null) throw new z.ZodError([{ code: "custom", message: `${label} must be a rupee amount like 499 or 499.50.`, path: [k], input: v }]);
  return p;
}
function int(fd: FormData, k: string, label: string, min: number, max: number): number | null {
  const v = str(fd, k);
  if (!v) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new z.ZodError([{ code: "custom", message: `${label} must be a whole number between ${min} and ${max}.`, path: [k], input: v }]);
  return n;
}

function revalidatePayments() {
  revalidatePath("/admin/payments", "layout");
  // Product price/sale/mode feed the canonical Mock Test Series offer on the
  // homepage, Exam Hub, series page and deep pages (lib/mock-series.ts).
  revalidateMockSeriesSurfaces();
}

// ---------------------------------------------------------------------------
// Global mode
// ---------------------------------------------------------------------------

export async function setPaymentModeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const mode = str(fd, "mode") as PaymentMode;
    if (!PAYMENT_MODES.includes(mode)) return { error: "Choose FREE, PAID or MAINTENANCE." };
    if (str(fd, "confirm") !== mode) return { error: `Type ${mode} to confirm.` };
    const before = await getPaymentMode();
    await setPaymentMode(mode, session.user.id);
    await logPaymentAudit(session.user.id, "PAYMENT_MODE_CHANGED", "PaymentSettings", "payments.mode", { before, after: mode });
    revalidatePayments();
    return { success: `Payment mode is now ${mode}.` };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Products & pricing (the one canonical pricing source)
// ---------------------------------------------------------------------------

const PRODUCT_CODE_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export async function saveProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const id = optStr(fd, "id", 64);
    const productType = z.nativeEnum(ProductType).parse(str(fd, "productType"));
    const accessType = z.nativeEnum(AccessType).parse(str(fd, "accessType"));
    const accessDurationType = z.nativeEnum(AccessDurationType).parse(str(fd, "accessDurationType"));
    const saleEnabled = bool(fd, "saleEnabled");
    const saleTypeRaw = optStr(fd, "saleDiscountType", 20);
    const saleDiscountType = saleTypeRaw ? z.nativeEnum(SaleDiscountType).parse(saleTypeRaw) : null;
    const code = str(fd, "code").toLowerCase();
    if (!PRODUCT_CODE_RE.test(code)) return { error: "Code must be 3-64 lowercase letters, digits or hyphens (used in the checkout URL)." };
    const name = str(fd, "name").slice(0, 150);
    if (!name) return { error: "Name is required." };

    const data = {
      code,
      name,
      description: optStr(fd, "description", 2000),
      productType,
      examId: optStr(fd, "examId", 64),
      testSeriesId: productType === "TEST_SERIES" ? optStr(fd, "testSeriesId", 64) : null,
      mockTestId: productType === "MOCK_TEST" ? optStr(fd, "mockTestId", 64) : null,
      grandTestId: productType === "GRAND_TEST" ? optStr(fd, "grandTestId", 64) : null,
      liveTestId: productType === "LIVE_TEST" ? optStr(fd, "liveTestId", 64) : null,
      accessType,
      isActive: bool(fd, "isActive"),
      isVisible: bool(fd, "isVisible"),
      purchaseEnabled: bool(fd, "purchaseEnabled"),
      mrpPaise: paise(fd, "mrp", "MRP") ?? 0,
      sellingPricePaise: accessType === "FREE" ? 0 : (paise(fd, "sellingPrice", "Selling price") ?? 0),
      saleEnabled,
      saleDiscountType: saleEnabled ? saleDiscountType : null,
      saleDiscountValue: saleEnabled
        ? saleDiscountType === "PERCENTAGE"
          ? int(fd, "saleDiscountValue", "Sale %", 1, 99)
          : paise(fd, "saleDiscountValue", "Sale discount")
        : null,
      saleStartAt: saleEnabled ? istDate(fd, "saleStartAt") : null,
      saleEndAt: saleEnabled ? istDate(fd, "saleEndAt") : null,
      accessDurationType,
      accessDays: accessDurationType === "DAYS" ? int(fd, "accessDays", "Access days", 1, 3650) : null,
      accessExpiresAt: accessDurationType === "FIXED_DATE" ? istDate(fd, "accessExpiresAt") : null,
      order: int(fd, "order", "Sort order", 0, 100000) ?? 0,
    };

    const needsEntity: Record<string, keyof typeof data | null> = {
      EXAM_ACCESS: "examId",
      PYQ_PACKAGE: "examId",
      TEST_SERIES: "testSeriesId",
      MOCK_TEST: "mockTestId",
      GRAND_TEST: "grandTestId",
      LIVE_TEST: "liveTestId",
    };
    const needKey = needsEntity[productType];
    if (needKey && !data[needKey]) return { error: "Choose what this product unlocks." };

    // Resolve the exam from the linked entity so exam-scoped coupons/analytics work.
    if (data.testSeriesId) data.examId = (await prisma.testSeries.findUnique({ where: { id: data.testSeriesId }, select: { examId: true } }))?.examId ?? null;
    if (data.mockTestId) data.examId = (await prisma.mockTest.findUnique({ where: { id: data.mockTestId }, select: { examId: true } }))?.examId ?? null;
    if (data.grandTestId) data.examId = (await prisma.grandTest.findUnique({ where: { id: data.grandTestId }, select: { examId: true } }))?.examId ?? null;
    if (data.liveTestId) data.examId = (await prisma.liveTest.findUnique({ where: { id: data.liveTestId }, select: { examId: true } }))?.examId ?? null;
    if (needKey && !data.examId) return { error: "The linked content no longer exists." };

    const invalid = validatePricingConfig(data);
    if (invalid) return { error: invalid };

    if (id) {
      const before = await prisma.product.findUnique({ where: { id } });
      if (!before) return { error: "Product not found." };
      await prisma.product.update({ where: { id }, data });
      await logPaymentAudit(session.user.id, "PRODUCT_UPDATED", "Product", id, {
        before: { accessType: before.accessType, mrpPaise: before.mrpPaise, sellingPricePaise: before.sellingPricePaise, saleEnabled: before.saleEnabled, isActive: before.isActive, purchaseEnabled: before.purchaseEnabled },
        after: { accessType: data.accessType, mrpPaise: data.mrpPaise, sellingPricePaise: data.sellingPricePaise, saleEnabled: data.saleEnabled, isActive: data.isActive, purchaseEnabled: data.purchaseEnabled },
      });
    } else {
      const created = await prisma.product.create({ data: { ...data, createdByAdminId: session.user.id } });
      await logPaymentAudit(session.user.id, "PRODUCT_CREATED", "Product", created.id, { code, accessType, sellingPricePaise: data.sellingPricePaise });
    }
    revalidatePayments();
    return { success: "Product saved." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Coupons
// ---------------------------------------------------------------------------

export async function saveCouponAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const id = optStr(fd, "id", 64);
    const code = str(fd, "code").toUpperCase();
    if (!COUPON_CODE_RE.test(code)) return { error: "Coupon code must be 3-32 characters: A-Z, 0-9, _ or -." };
    const discountType = z.nativeEnum(CouponDiscountType).parse(str(fd, "discountType"));
    const discountValue =
      discountType === "FREE_ACCESS"
        ? 100
        : discountType === "PERCENTAGE"
          ? int(fd, "discountValue", "Discount %", 1, 100)
          : paise(fd, "discountValue", "Discount amount");
    if (!discountValue || discountValue <= 0) return { error: "Enter a discount value." };
    const ids = (k: string) =>
      fd
        .getAll(k)
        .map((v) => String(v).trim())
        .filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v))
        .slice(0, 200);
    const data = {
      code,
      displayName: optStr(fd, "displayName", 100),
      description: optStr(fd, "description", 1000),
      isActive: bool(fd, "isActive"),
      validFrom: istDate(fd, "validFrom"),
      validUntil: istDate(fd, "validUntil"),
      discountType,
      discountValue,
      maxDiscountPaise: paise(fd, "maxDiscount", "Maximum discount"),
      minOrderPaise: paise(fd, "minOrder", "Minimum order"),
      totalUsageLimit: int(fd, "totalUsageLimit", "Total usage limit", 1, 1_000_000),
      perStudentLimit: int(fd, "perStudentLimit", "Per-student limit", 1, 1000),
      newStudentOnly: bool(fd, "newStudentOnly"),
      productIds: ids("productIds"),
      examIds: ids("examIds"),
      testSeriesIds: ids("testSeriesIds"),
      source: optStr(fd, "source", 100),
      campaign: optStr(fd, "campaign", 100),
      referrerName: optStr(fd, "referrerName", 100),
      referrerCode: optStr(fd, "referrerCode", 64),
      referrerStudentId: optStr(fd, "referrerStudentId", 64),
      referrerAdminId: optStr(fd, "referrerAdminId", 64),
      notes: optStr(fd, "notes", 2000),
    };
    if (data.validFrom && data.validUntil && data.validUntil <= data.validFrom) return { error: "Valid until must be after valid from." };
    if (id) {
      const before = await prisma.coupon.findUnique({ where: { id } });
      if (!before) return { error: "Coupon not found." };
      await prisma.coupon.update({ where: { id }, data });
      await logPaymentAudit(session.user.id, before.isActive && !data.isActive ? "COUPON_DEACTIVATED" : "COUPON_UPDATED", "Coupon", id, {
        code,
        before: { isActive: before.isActive, discountType: before.discountType, discountValue: before.discountValue, totalUsageLimit: before.totalUsageLimit },
        after: { isActive: data.isActive, discountType, discountValue, totalUsageLimit: data.totalUsageLimit },
      });
    } else {
      const c = await prisma.coupon.create({ data: { ...data, createdByAdminId: session.user.id } });
      await logPaymentAudit(session.user.id, "COUPON_CREATED", "Coupon", c.id, { code, discountType, discountValue });
    }
    revalidatePayments();
    return { success: `Coupon ${code} saved.` };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleCouponAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const id = str(fd, "id");
    const c = await prisma.coupon.findUnique({ where: { id } });
    if (!c) return { error: "Coupon not found." };
    await prisma.coupon.update({ where: { id }, data: { isActive: !c.isActive } });
    await logPaymentAudit(session.user.id, c.isActive ? "COUPON_DEACTIVATED" : "COUPON_UPDATED", "Coupon", id, { code: c.code, isActive: !c.isActive });
    revalidatePayments();
    return { success: c.isActive ? "Coupon deactivated." : "Coupon activated." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Gateway credentials
// ---------------------------------------------------------------------------

export async function saveGatewayAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const slot = str(fd, "slot") === "LIVE" ? "LIVE" : "TEST";
    const keySecret = str(fd, "keySecret");
    const webhookSecret = str(fd, "webhookSecret");
    const keyId = str(fd, "keyId");
    await saveRazorpayConfig({ slot, keyId: keyId || undefined, keySecret: keySecret || undefined, webhookSecret: webhookSecret || undefined });
    await logPaymentAudit(session.user.id, "GATEWAY_CREDENTIALS_UPDATED", "PaymentGateway", "api.razorpay", {
      slot,
      keyIdChanged: Boolean(keyId),
      keySecretRotated: Boolean(keySecret),
      webhookSecretRotated: Boolean(webhookSecret),
    });
    revalidatePayments();
    return { success: `${slot} credentials saved. Secrets are encrypted and won't be shown again.` };
  } catch (e) {
    return fail(e);
  }
}

export async function saveGatewayModeAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const environment = str(fd, "environment") === "LIVE" ? "LIVE" : "TEST";
    const enabled = bool(fd, "enabled");
    const before = await getRazorpayConfig();
    if (environment === "LIVE" && !before.live.configured) return { error: "Save LIVE Key ID + Key Secret before switching to LIVE." };
    if (environment === "LIVE" && before.environment !== "LIVE" && str(fd, "confirmLive") !== "LIVE")
      return { error: "Type LIVE to confirm switching to real-money payments." };
    await saveRazorpayConfig({ environment, enabled });
    await logPaymentAudit(session.user.id, "GATEWAY_CREDENTIALS_UPDATED", "PaymentGateway", "api.razorpay", {
      before: { environment: before.environment, enabled: before.enabled },
      after: { environment, enabled },
    });
    revalidatePayments();
    return { success: `Gateway ${enabled ? "enabled" : "disabled"} in ${environment} mode.` };
  } catch (e) {
    return fail(e);
  }
}

export async function testGatewayAction(): Promise<FormState> {
  try {
    const session = await manage();
    const r = await testRazorpayConnection();
    await logPaymentAudit(session.user.id, "GATEWAY_TESTED", "PaymentGateway", "api.razorpay", { ok: r.ok });
    revalidatePayments();
    return r.ok ? { success: r.message } : { error: r.message };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Entitlements (manual grant / revoke)
// ---------------------------------------------------------------------------

export async function grantEntitlementAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const studentId = str(fd, "studentId");
    const productId = str(fd, "productId");
    const reason = str(fd, "reason").slice(0, 500);
    if (!reason) return { error: "A reason is required." };
    const source = str(fd, "source") === "PROMOTION" ? EntitlementSource.PROMOTION : EntitlementSource.ADMIN_GRANT;
    const [student, product] = await Promise.all([
      prisma.student.findUnique({ where: { id: studentId }, select: { id: true } }),
      prisma.product.findUnique({ where: { id: productId }, select: { id: true } }),
    ]);
    if (!student || !product) return { error: "Student or product not found." };
    const startsAt = istDate(fd, "startsAt") ?? new Date();
    const expiresAt = istDate(fd, "expiresAt");
    if (expiresAt && expiresAt <= startsAt) return { error: "Expiry must be after the start date." };
    const ent = await prisma.studentEntitlement.create({
      data: { studentId, productId, source, startsAt, expiresAt, grantedByAdminId: session.user.id, reason },
    });
    await logPaymentAudit(session.user.id, "ENTITLEMENT_GRANTED", "StudentEntitlement", ent.id, {
      studentId,
      productId,
      source,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
      reason,
    });
    revalidatePath(`/admin/students/${studentId}`);
    revalidatePayments();
    return { success: "Access granted." };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeEntitlementAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const id = str(fd, "id");
    const reason = str(fd, "reason").slice(0, 500);
    if (!reason) return { error: "A reason is required." };
    const ent = await prisma.studentEntitlement.findUnique({ where: { id } });
    if (!ent) return { error: "Entitlement not found." };
    if (ent.status === EntitlementStatus.REVOKED) return { error: "Already revoked." };
    await prisma.studentEntitlement.update({
      where: { id },
      data: { status: EntitlementStatus.REVOKED, revokedAt: new Date(), revokedByAdminId: session.user.id, revokeReason: reason },
    });
    await logPaymentAudit(session.user.id, "ENTITLEMENT_REVOKED", "StudentEntitlement", id, { studentId: ent.studentId, productId: ent.productId, reason });
    revalidatePath(`/admin/students/${ent.studentId}`);
    revalidatePayments();
    return { success: "Access revoked." };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Refunds / reconciliation
// ---------------------------------------------------------------------------

export async function requestRefundAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const paymentId = str(fd, "paymentId");
    if (str(fd, "confirm") !== "REFUND") return { error: "Type REFUND to confirm." };
    const amountPaise = paise(fd, "amount", "Refund amount");
    if (!amountPaise) return { error: "Enter the refund amount." };
    const accessPolicy = z.nativeEnum(RefundAccessPolicy).parse(str(fd, "accessPolicy"));
    const reason = str(fd, "reason").slice(0, 500);
    if (!reason) return { error: "A reason is required." };
    const refund = await requestRefund({
      paymentId,
      amountPaise,
      reason,
      accessPolicy,
      retainUntil: accessPolicy === "RETAIN_UNTIL_DATE" ? istDate(fd, "retainUntil") : null,
      adminId: session.user.id,
    });
    await logPaymentAudit(session.user.id, "REFUND_REQUESTED", "Refund", refund.id, { paymentId, amountPaise, accessPolicy, status: refund.status });
    revalidatePayments();
    return { success: `Refund submitted to Razorpay — status: ${refund.status}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function reconcileOrderAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const orderId = str(fd, "orderId");
    const { outcome } = await reconcileOrder(orderId);
    const repair = await ensureFulfilment(orderId);
    await logPaymentAudit(session.user.id, "ORDER_RECONCILED", "PaymentOrder", orderId, { gateway: outcome, fulfilment: repair });
    revalidatePayments();
    return { success: `Gateway check: ${outcome}. Fulfilment: ${repair}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function expireStaleOrdersAction(): Promise<FormState> {
  try {
    await manage();
    const n = await expireStaleOrders();
    revalidatePayments();
    return { success: `${n} stale order${n === 1 ? "" : "s"} expired.` };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// Invoice settings / policy
// ---------------------------------------------------------------------------

export async function saveInvoiceSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const taxMode = str(fd, "taxMode") === "INCLUSIVE" ? "INCLUSIVE" : "NONE";
    const rate = taxMode === "INCLUSIVE" ? Number(str(fd, "taxRatePercent")) : 0;
    if (taxMode === "INCLUSIVE" && (!Number.isFinite(rate) || rate <= 0 || rate > 50)) return { error: "Tax rate must be between 0 and 50%." };
    const gstin = str(fd, "gstin").toUpperCase();
    if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) return { error: "GSTIN must be 15 characters." };
    if (taxMode === "INCLUSIVE" && !gstin) return { error: "Tax lines need a GSTIN — configure it or set tax mode to None." };
    const before = await getInvoiceSettings();
    const next = {
      legalName: str(fd, "legalName").slice(0, 150),
      tradeName: str(fd, "tradeName").slice(0, 150),
      billingAddress: str(fd, "billingAddress").slice(0, 500),
      supportEmail: str(fd, "supportEmail").slice(0, 150),
      supportPhone: str(fd, "supportPhone").slice(0, 30),
      gstin,
      invoicePrefix: str(fd, "invoicePrefix").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "MTS",
      taxMode: taxMode as "NONE" | "INCLUSIVE",
      taxRatePercent: rate,
      taxSplit: (str(fd, "taxSplit") === "CGST_SGST" ? "CGST_SGST" : "IGST") as "IGST" | "CGST_SGST",
      sacCode: str(fd, "sacCode").replace(/[^0-9]/g, "").slice(0, 8),
      footerNote: str(fd, "footerNote").slice(0, 300),
    };
    await saveInvoiceSettings(next);
    await logPaymentAudit(session.user.id, "INVOICE_SETTINGS_UPDATED", "PaymentSettings", "payments.invoice", {
      before: { taxMode: before.taxMode, taxRatePercent: before.taxRatePercent, invoicePrefix: before.invoicePrefix, gstinSet: Boolean(before.gstin) },
      after: { taxMode: next.taxMode, taxRatePercent: next.taxRatePercent, invoicePrefix: next.invoicePrefix, gstinSet: Boolean(next.gstin) },
    });
    revalidatePayments();
    return { success: "Invoice settings saved. They apply to invoices issued from now on." };
  } catch (e) {
    return fail(e);
  }
}

export async function savePaymentPolicyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const before = await getPaymentPolicy();
    const next = {
      refundAccessPolicy: (str(fd, "refundAccessPolicy") === "REVOKE_IMMEDIATELY" ? "REVOKE_IMMEDIATELY" : "RETAIN") as "REVOKE_IMMEDIATELY" | "RETAIN",
      invoiceZeroValueOrders: bool(fd, "invoiceZeroValueOrders"),
      orderTtlMinutes: int(fd, "orderTtlMinutes", "Order TTL", 10, 1440) ?? 30,
    };
    await savePaymentPolicy(next);
    await logPaymentAudit(session.user.id, "PAYMENT_POLICY_UPDATED", "PaymentSettings", "payments.policy", { before, after: next });
    revalidatePayments();
    return { success: "Policy saved." };
  } catch (e) {
    return fail(e);
  }
}
