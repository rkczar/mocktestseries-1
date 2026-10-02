import "server-only";
import crypto from "node:crypto";
import type { EmailStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resendWebhookSecret } from "@/lib/email/config";

/**
 * Resend delivery webhooks (POST /api/webhooks/resend). Resend signs
 * webhooks with Svix: headers `svix-id`, `svix-timestamp`, `svix-signature`
 * ("v1,<base64 sig>" entries, space-separated); the signed content is
 * `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64-decoded part
 * of the `whsec_…` secret. Events older/newer than 5 minutes are rejected
 * (replay protection).
 *
 * Without RESEND_WEBHOOK_SECRET the endpoint is DISABLED (503) — unsigned
 * events are never accepted. Status updates are monotonic (a late
 * "delivered" never overwrites "bounced"), so a replayed or reordered event
 * is harmless.
 */

const TOLERANCE_SECONDS = 5 * 60;

export type WebhookVerification = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function verifyResendSignature(rawBody: string, headers: Headers, nowSeconds = Math.floor(Date.now() / 1000)): WebhookVerification {
  const secret = resendWebhookSecret();
  if (!secret) return { ok: false, status: 503, error: "Webhook not configured" };
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatureHeader = headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader) return { ok: false, status: 401, error: "Missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return { ok: false, status: 401, error: "Stale or invalid timestamp" };

  let key: Buffer;
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    return { ok: false, status: 503, error: "Webhook secret is malformed" };
  }
  const expected = Buffer.from(crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64"));
  const valid = signatureHeader.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
  return valid ? { ok: true } : { ok: false, status: 401, error: "Invalid signature" };
}

interface ResendEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    failed?: { reason?: string };
  };
}

const RANK: Record<EmailStatus, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  FAILED: 4,
  BOUNCED: 5,
  COMPLAINED: 6,
  SKIPPED: -1,
  CANCELLED: -1,
};

export async function handleResendEvent(rawBody: string): Promise<{ handled: boolean; reason?: string }> {
  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return { handled: false, reason: "invalid json" };
  }
  const messageId = event.data?.email_id;
  const type = (event.type ?? "").slice(0, 60);
  if (!messageId || !type) return { handled: false, reason: "no email id" };

  const log = await prisma.emailDeliveryLog.findUnique({ where: { providerMessageId: messageId }, select: { id: true, status: true, studentId: true } });
  if (!log) return { handled: false, reason: "unknown email" };

  let next: EmailStatus | null = null;
  let failureReason: string | undefined;
  const now = new Date();
  switch (type) {
    case "email.delivered":
      next = "DELIVERED";
      break;
    case "email.bounced":
      next = "BOUNCED";
      failureReason = [event.data?.bounce?.type, event.data?.bounce?.subType, event.data?.bounce?.message].filter(Boolean).join(" — ").slice(0, 300) || "Bounced";
      break;
    case "email.complained":
      next = "COMPLAINED";
      failureReason = "Recipient marked the email as spam";
      break;
    case "email.failed":
      next = "FAILED";
      failureReason = (event.data?.failed?.reason ?? "Provider reported a delivery failure").slice(0, 300);
      break;
    default:
      // email.sent / delivery_delayed / opened / clicked …: recorded, status unchanged.
      break;
  }

  if (next && RANK[next] > RANK[log.status]) {
    await prisma.emailDeliveryLog.updateMany({
      where: { id: log.id, status: log.status },
      data: { status: next, lastEventType: type, ...(next === "DELIVERED" ? { deliveredAt: now } : {}), ...(failureReason ? { failureReason } : {}) },
    });
  } else {
    await prisma.emailDeliveryLog.update({ where: { id: log.id }, data: { lastEventType: type } });
  }

  // Protect sender reputation: a hard bounce or a spam complaint suppresses the address.
  if (log.studentId && (type === "email.complained" || (type === "email.bounced" && /permanent/i.test(event.data?.bounce?.type ?? "")))) {
    const reason = type === "email.complained" ? "Spam complaint" : "Hard bounce";
    await prisma.emailPreference.upsert({
      where: { studentId: log.studentId },
      create: {
        studentId: log.studentId,
        suppressedAt: now,
        suppressionReason: reason,
        ...(type === "email.complained" ? { promotionalOptOut: true, optedOutAt: now } : {}),
      },
      update: {
        suppressedAt: now,
        suppressionReason: reason,
        ...(type === "email.complained" ? { promotionalOptOut: true, optedOutAt: now } : {}),
      },
    });
  }
  return { handled: true };
}
