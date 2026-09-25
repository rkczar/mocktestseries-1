import { NextRequest, NextResponse } from "next/server";
import { handleRazorpayWebhook } from "@/lib/payments/webhooks";
import { enforcePaymentRateLimit, PaymentRateLimitError } from "@/lib/payments/rate-limit";
import { clientIpFromHeaders } from "@/lib/client-ip";

/**
 * Razorpay webhook endpoint (configure in Razorpay Dashboard → Webhooks:
 * https://mocktestseries.in/api/webhooks/razorpay with events payment.*,
 * order.paid, refund.*). The raw body is read as text BEFORE parsing so the
 * HMAC is computed over exactly the bytes Razorpay signed. No session auth —
 * the signature is the authentication. Responses never echo payload data.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: NextRequest) {
  const ip = clientIpFromHeaders(request.headers);
  try {
    await enforcePaymentRateLimit("webhook", ip);
  } catch (e) {
    if (e instanceof PaymentRateLimitError) return NextResponse.json({ ok: false }, { status: 429 });
    throw e;
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });

  const result = await handleRazorpayWebhook(raw, request.headers.get("x-razorpay-signature"), request.headers.get("x-razorpay-event-id"));
  return NextResponse.json(result.body, { status: result.httpStatus });
}
