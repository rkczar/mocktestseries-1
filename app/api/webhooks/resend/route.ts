import { NextRequest, NextResponse } from "next/server";
import { handleResendEvent, verifyResendSignature } from "@/lib/email/webhook";

/**
 * Resend delivery-status webhook (configure in Resend → Webhooks:
 * https://mocktestseries.in/api/webhooks/resend with email.delivered,
 * email.bounced, email.complained, email.failed). Disabled (503) until
 * RESEND_WEBHOOK_SECRET is set — unsigned events are never accepted. The raw
 * body is read as text BEFORE parsing so the signature covers exactly the
 * bytes Resend signed. Responses never echo payload data.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 });

  const verified = verifyResendSignature(raw, request.headers);
  if (!verified.ok) return NextResponse.json({ ok: false, error: verified.error }, { status: verified.status });

  try {
    await handleResendEvent(raw);
  } catch (error) {
    console.error("[email] webhook processing failed", { code: (error as { code?: string })?.code ?? "UNKNOWN" });
    // 500 makes Resend retry later.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
