"use server";

import { z } from "zod";
import { requireStudent } from "@/lib/student-session";
import { enforcePaymentRateLimit, PaymentRateLimitError } from "@/lib/payments/rate-limit";
import {
  CheckoutError,
  createCheckoutOrder,
  getCheckoutQuote,
  getOrderStatusForStudent,
  verifyCheckoutPayment,
  type CreateOrderResult,
  type VerifyResult,
} from "@/lib/payments/orders";

/**
 * Student checkout Server Actions. Server Actions carry Next.js's built-in
 * Origin check (CSRF), and each one re-derives the student from the session
 * — the browser only ever supplies identifiers (product id/code, coupon
 * code, Razorpay callback ids). Amounts are never accepted from the client.
 * Errors returned are fixed user-facing strings, never stack traces.
 */

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function toError(e: unknown): { ok: false; error: string } {
  if (e instanceof CheckoutError || e instanceof PaymentRateLimitError) return { ok: false, error: e.message };
  return { ok: false, error: "Something went wrong. Please try again." };
}

const codeSchema = z.string().trim().min(1).max(64);
const idSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export interface CouponQuoteView {
  payablePaise: number;
  couponCode: string | null;
  couponDiscountPaise: number;
  couponLabel: string | null;
  couponError: string | null;
}

export async function applyCouponAction(productCode: string, couponCode: string): Promise<ActionResult<CouponQuoteView>> {
  try {
    const student = await requireStudent();
    const p = codeSchema.safeParse(productCode);
    const c = z.string().trim().min(1).max(40).safeParse(couponCode);
    if (!p.success || !c.success) return { ok: false, error: "Enter a coupon code." };
    await enforcePaymentRateLimit("coupon", student.id);
    const quote = await getCheckoutQuote(student.id, p.data, c.data);
    if (!quote) return { ok: false, error: "This product isn't available." };
    return {
      ok: true,
      data: {
        payablePaise: quote.payablePaise,
        couponCode: quote.coupon?.code ?? null,
        couponDiscountPaise: quote.coupon?.discountPaise ?? 0,
        couponLabel: quote.coupon?.label ?? null,
        couponError: quote.couponError,
      },
    };
  } catch (e) {
    return toError(e);
  }
}

export async function createOrderAction(productId: string, couponCode: string | null): Promise<ActionResult<CreateOrderResult>> {
  try {
    const student = await requireStudent();
    const p = idSchema.safeParse(productId);
    if (!p.success) return { ok: false, error: "Invalid product." };
    const coupon = couponCode ? z.string().trim().max(40).parse(couponCode) : null;
    await enforcePaymentRateLimit("create-order", student.id);
    return { ok: true, data: await createCheckoutOrder(student.id, p.data, coupon || null) };
  } catch (e) {
    return toError(e);
  }
}

const verifySchema = z.object({
  orderId: idSchema,
  razorpay_order_id: z.string().trim().min(1).max(64).regex(/^order_[A-Za-z0-9]+$/),
  razorpay_payment_id: z.string().trim().min(1).max(64).regex(/^pay_[A-Za-z0-9]+$/),
  razorpay_signature: z.string().trim().min(1).max(128).regex(/^[a-f0-9]+$/i),
});

export async function verifyPaymentAction(input: unknown): Promise<ActionResult<VerifyResult>> {
  try {
    const student = await requireStudent();
    const parsed = verifySchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid payment response." };
    await enforcePaymentRateLimit("verify", student.id);
    return {
      ok: true,
      data: await verifyCheckoutPayment(student.id, {
        orderId: parsed.data.orderId,
        razorpayOrderId: parsed.data.razorpay_order_id,
        razorpayPaymentId: parsed.data.razorpay_payment_id,
        razorpaySignature: parsed.data.razorpay_signature,
      }),
    };
  } catch (e) {
    return toError(e);
  }
}

export async function orderStatusAction(orderId: string): Promise<ActionResult<{ status: string; productCode: string }>> {
  try {
    const student = await requireStudent();
    const p = idSchema.safeParse(orderId);
    if (!p.success) return { ok: false, error: "Invalid order." };
    await enforcePaymentRateLimit("status", student.id);
    const o = await getOrderStatusForStudent(student.id, p.data);
    if (!o) return { ok: false, error: "Order not found." };
    return { ok: true, data: { status: o.status, productCode: o.product.code } };
  } catch (e) {
    return toError(e);
  }
}
