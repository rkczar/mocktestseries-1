import "server-only";
import crypto from "node:crypto";
import { PaymentStatus } from "@prisma/client";
import { getRazorpayCredentials, type RazorpayCredentials, type RazorpayEnvironment } from "@/lib/razorpay-config";

/**
 * Minimal server-side client for Razorpay's official REST API
 * (https://razorpay.com/docs/api/) — Basic Auth with key_id:key_secret, the
 * same calls the official `razorpay` Node SDK wraps. Using fetch directly
 * keeps the secret in exactly one place and avoids a dependency.
 *
 * Errors thrown from here carry only a safe category/HTTP status — never the
 * request, the credentials, or the raw provider response body.
 */

const API = "https://api.razorpay.com/v1";

export class RazorpayApiError extends Error {
  constructor(
    public readonly category: "NOT_CONFIGURED" | "AUTH" | "BAD_REQUEST" | "NOT_FOUND" | "SERVER" | "NETWORK",
    public readonly httpStatus?: number
  ) {
    super(`Razorpay API error: ${category}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
    this.name = "RazorpayApiError";
  }
}

async function creds(environment: RazorpayEnvironment): Promise<RazorpayCredentials> {
  const c = await getRazorpayCredentials(environment);
  if (!c) throw new RazorpayApiError("NOT_CONFIGURED");
  return c;
}

async function call<T>(environment: RazorpayEnvironment, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const c = await creds(environment);
  let res: Response;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        Authorization: "Basic " + Buffer.from(`${c.keyId}:${c.keySecret}`).toString("base64"),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new RazorpayApiError("NETWORK");
  }
  if (res.ok) return (await res.json()) as T;
  const category =
    res.status === 401 ? "AUTH" : res.status === 404 ? "NOT_FOUND" : res.status >= 500 ? "SERVER" : "BAD_REQUEST";
  throw new RazorpayApiError(category, res.status);
}

export interface RzpOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: "created" | "attempted" | "paid";
}

export interface RzpPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method?: string;
  captured?: boolean;
  amount_refunded?: number;
  error_code?: string | null;
  error_description?: string | null;
  created_at?: number;
}

export interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: "pending" | "processed" | "failed";
}

export function createRazorpayOrder(
  environment: RazorpayEnvironment,
  input: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }
) {
  return call<RzpOrder>(environment, "POST", "/orders", {
    amount: input.amountPaise,
    currency: input.currency,
    receipt: input.receipt.slice(0, 40),
    notes: input.notes,
  });
}

export function fetchRazorpayOrder(environment: RazorpayEnvironment, gatewayOrderId: string) {
  return call<RzpOrder>(environment, "GET", `/orders/${encodeURIComponent(gatewayOrderId)}`);
}

export async function fetchRazorpayOrderPayments(environment: RazorpayEnvironment, gatewayOrderId: string) {
  const r = await call<{ items: RzpPayment[] }>(environment, "GET", `/orders/${encodeURIComponent(gatewayOrderId)}/payments`);
  return r.items ?? [];
}

export function fetchRazorpayPayment(environment: RazorpayEnvironment, paymentId: string) {
  return call<RzpPayment>(environment, "GET", `/payments/${encodeURIComponent(paymentId)}`);
}

export function captureRazorpayPayment(environment: RazorpayEnvironment, paymentId: string, amountPaise: number, currency: string) {
  return call<RzpPayment>(environment, "POST", `/payments/${encodeURIComponent(paymentId)}/capture`, {
    amount: amountPaise,
    currency,
  });
}

export function createRazorpayRefund(
  environment: RazorpayEnvironment,
  paymentId: string,
  input: { amountPaise: number; notes: Record<string, string>; receipt: string }
) {
  return call<RzpRefund>(environment, "POST", `/payments/${encodeURIComponent(paymentId)}/refund`, {
    amount: input.amountPaise,
    notes: input.notes,
    receipt: input.receipt.slice(0, 40),
  });
}

export function fetchRazorpayRefund(environment: RazorpayEnvironment, paymentId: string, refundId: string) {
  return call<RzpRefund>(
    environment,
    "GET",
    `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`
  );
}

function hmacHex(secret: string, data: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

/** Constant-time hex comparison; false on any length/format mismatch. */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const ab = Buffer.from(a.toLowerCase(), "hex");
  const bb = Buffer.from(b.toLowerCase(), "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Standard Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret).
 * `gatewayOrderId` MUST be the one stored on our own order row — never the
 * browser-supplied razorpay_order_id.
 */
export function checkoutSignatureIsValid(keySecret: string, gatewayOrderId: string, paymentId: string, signature: string) {
  return safeEqualHex(hmacHex(keySecret, `${gatewayOrderId}|${paymentId}`), signature);
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook_secret). */
export function webhookSignatureIsValid(webhookSecret: string, rawBody: string, signature: string) {
  return safeEqualHex(hmacHex(webhookSecret, rawBody), signature);
}

/** Maps Razorpay's payment status vocabulary onto our canonical PaymentStatus. */
export function mapRazorpayPaymentStatus(p: Pick<RzpPayment, "status" | "amount" | "amount_refunded">): PaymentStatus {
  switch (p.status) {
    case "authorized":
      return PaymentStatus.AUTHORIZED;
    case "captured":
      return (p.amount_refunded ?? 0) > 0 ? PaymentStatus.PARTIALLY_REFUNDED : PaymentStatus.CAPTURED;
    case "refunded":
      return (p.amount_refunded ?? p.amount) >= p.amount ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
    case "failed":
      return PaymentStatus.FAILED;
    default:
      return PaymentStatus.CREATED;
  }
}

/** Only a short, known-safe method label is ever persisted. */
export function safeMethodLabel(method: string | undefined): string | null {
  if (!method) return null;
  return ["card", "upi", "netbanking", "wallet", "emi", "cardless_emi", "paylater", "bank_transfer"].includes(method)
    ? method
    : "other";
}
