import type { Product, Coupon } from "@prisma/client";
import { percentOf, discountPercent } from "@/lib/payments/money";

/**
 * The ONE pricing function. Every amount a student sees or is charged is
 * derived here from DB rows + server time — never from browser input. Pure
 * (no DB access) so it is trivially testable and reusable by admin preview.
 */

export type PricingInput = Pick<
  Product,
  | "accessType"
  | "mrpPaise"
  | "sellingPricePaise"
  | "saleEnabled"
  | "saleDiscountType"
  | "saleDiscountValue"
  | "saleStartAt"
  | "saleEndAt"
  | "currency"
>;

export interface ProductPrice {
  isFree: boolean;
  currency: string;
  mrpPaise: number;
  sellingPricePaise: number;
  saleActive: boolean;
  saleDiscountPaise: number;
  /** Price after any active sale, before coupons. */
  pricePaise: number;
  saleEndsAt: Date | null;
  /** Total % off MRP (sale included). */
  discountPercent: number;
  savingsPaise: number;
}

export function isSaleActive(p: PricingInput, now: Date): boolean {
  if (!p.saleEnabled || !p.saleDiscountType || !p.saleDiscountValue) return false;
  if (p.saleStartAt && now < p.saleStartAt) return false;
  if (p.saleEndAt && now >= p.saleEndAt) return false;
  return true;
}

export function computeProductPrice(p: PricingInput, now: Date = new Date()): ProductPrice {
  if (p.accessType === "FREE") {
    return {
      isFree: true,
      currency: p.currency,
      mrpPaise: p.mrpPaise,
      sellingPricePaise: 0,
      saleActive: false,
      saleDiscountPaise: 0,
      pricePaise: 0,
      saleEndsAt: null,
      discountPercent: p.mrpPaise > 0 ? 100 : 0,
      savingsPaise: p.mrpPaise,
    };
  }
  const selling = Math.max(0, p.sellingPricePaise);
  const mrp = Math.max(selling, p.mrpPaise);
  const saleActive = isSaleActive(p, now);
  let saleDiscount = 0;
  if (saleActive) {
    saleDiscount =
      p.saleDiscountType === "PERCENTAGE"
        ? percentOf(selling, Math.min(100, Math.max(0, p.saleDiscountValue ?? 0)))
        : Math.min(selling, Math.max(0, p.saleDiscountValue ?? 0));
  }
  const price = selling - saleDiscount;
  return {
    isFree: false,
    currency: p.currency,
    mrpPaise: mrp,
    sellingPricePaise: selling,
    saleActive,
    saleDiscountPaise: saleDiscount,
    pricePaise: price,
    saleEndsAt: saleActive ? p.saleEndAt : null,
    discountPercent: discountPercent(mrp, price),
    savingsPaise: mrp - price,
  };
}

/** Admin-side validation of a pricing configuration. Returns an error message or null. */
export function validatePricingConfig(p: {
  accessType: "FREE" | "PAID";
  mrpPaise: number;
  sellingPricePaise: number;
  saleEnabled: boolean;
  saleDiscountType: "PERCENTAGE" | "FIXED_AMOUNT" | null;
  saleDiscountValue: number | null;
  saleStartAt: Date | null;
  saleEndAt: Date | null;
  accessDurationType: "DAYS" | "FIXED_DATE" | "LIFETIME";
  accessDays: number | null;
  accessExpiresAt: Date | null;
}): string | null {
  if (p.mrpPaise < 0 || p.sellingPricePaise < 0) return "Prices cannot be negative.";
  if (p.accessType === "PAID") {
    if (p.sellingPricePaise <= 0) return "A PAID product needs a selling price above ₹0 (use a FREE product or a 100% coupon instead).";
    if (p.sellingPricePaise < 100) return "Minimum selling price is ₹1 (Razorpay minimum).";
    if (p.mrpPaise < p.sellingPricePaise) return "MRP cannot be lower than the selling price.";
  }
  if (p.saleEnabled) {
    if (p.accessType !== "PAID") return "A sale only applies to PAID products.";
    if (!p.saleDiscountType || !p.saleDiscountValue || p.saleDiscountValue <= 0) return "Sale needs a discount type and a positive value.";
    if (p.saleDiscountType === "PERCENTAGE" && p.saleDiscountValue >= 100) return "Sale percentage must be between 1 and 99.";
    if (p.saleDiscountType === "FIXED_AMOUNT" && p.sellingPricePaise - p.saleDiscountValue < 100)
      return "Sale discount would take the price below ₹1.";
    if (p.saleStartAt && p.saleEndAt && p.saleEndAt <= p.saleStartAt) return "Sale end must be after sale start.";
  }
  if (p.accessDurationType === "DAYS" && (!p.accessDays || p.accessDays < 1 || p.accessDays > 3650))
    return "Access duration must be between 1 and 3650 days.";
  if (p.accessDurationType === "FIXED_DATE" && !p.accessExpiresAt) return "Pick the fixed access expiry date.";
  return null;
}

/** Discount a coupon gives off `pricePaise` (never more than the price). */
export function computeCouponDiscount(
  coupon: Pick<Coupon, "discountType" | "discountValue" | "maxDiscountPaise">,
  pricePaise: number
): number {
  let d = 0;
  if (coupon.discountType === "FREE_ACCESS") d = pricePaise;
  else if (coupon.discountType === "PERCENTAGE") d = percentOf(pricePaise, Math.min(100, Math.max(0, coupon.discountValue)));
  else d = Math.max(0, coupon.discountValue);
  if (coupon.discountType !== "FREE_ACCESS" && coupon.maxDiscountPaise != null) d = Math.min(d, coupon.maxDiscountPaise);
  d = Math.min(d, pricePaise);
  // Razorpay can't charge between ₹0 and ₹1: a discount that would leave a
  // sub-rupee balance rounds to fully free rather than an uncollectable amount.
  if (pricePaise - d > 0 && pricePaise - d < 100) d = pricePaise;
  return d;
}

/** When an entitlement bought now (or renewed on top of `currentExpiry`) starts/ends. */
export function computeAccessWindow(
  p: Pick<Product, "accessDurationType" | "accessDays" | "accessExpiresAt">,
  now: Date,
  currentExpiry: Date | null
): { startsAt: Date; expiresAt: Date | null } {
  if (p.accessDurationType === "LIFETIME") return { startsAt: now, expiresAt: null };
  if (p.accessDurationType === "FIXED_DATE") return { startsAt: now, expiresAt: p.accessExpiresAt };
  const base = currentExpiry && currentExpiry > now ? currentExpiry : now;
  return { startsAt: now, expiresAt: new Date(base.getTime() + (p.accessDays ?? 0) * 86_400_000) };
}

export function describeAccessDuration(p: Pick<Product, "accessDurationType" | "accessDays" | "accessExpiresAt">): string {
  if (p.accessDurationType === "LIFETIME") return "Lifetime access";
  if (p.accessDurationType === "FIXED_DATE")
    return p.accessExpiresAt
      ? `Access until ${p.accessExpiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}`
      : "Fixed-date access";
  return `${p.accessDays ?? 0} days access`;
}
