import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Email preferences + the signed link used by "Unsubscribe / Email
 * preferences" in every email (no login needed, per RFC 8058 one-click).
 *
 * Token = base64url(studentDbId) + "." + HMAC-SHA256(secret, "email-pref:" + id).
 * It identifies a student and can only toggle that student's promotional
 * opt-out — nothing else. Signing key: EMAIL_PREFERENCES_SECRET, else
 * AUTH_SECRET (domain-separated by the "email-pref:" prefix).
 */

function secret(): string {
  const value = process.env.EMAIL_PREFERENCES_SECRET || process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET must be set");
  return value;
}

function sign(studentId: string): string {
  return crypto.createHmac("sha256", secret()).update(`email-pref:${studentId}`).digest("base64url");
}

export function preferencesToken(studentId: string): string {
  return `${Buffer.from(studentId).toString("base64url")}.${sign(studentId)}`;
}

/** Student.id for a valid token, else null. Constant-time signature compare. */
export function verifyPreferencesToken(token: string | null | undefined): string | null {
  if (!token || token.length > 300) return null;
  const [idPart, sig] = token.split(".");
  if (!idPart || !sig) return null;
  let studentId: string;
  try {
    studentId = Buffer.from(idPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!/^[a-z0-9]{10,40}$/i.test(studentId)) return null;
  const expected = Buffer.from(sign(studentId));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? studentId : null;
}

export function preferencesUrl(siteUrl: string, studentId: string): string {
  return `${siteUrl}/email/preferences?token=${encodeURIComponent(preferencesToken(studentId))}`;
}

export function unsubscribeUrl(siteUrl: string, studentId: string): string {
  return `${siteUrl}/api/email/unsubscribe?token=${encodeURIComponent(preferencesToken(studentId))}`;
}

export async function getEmailPreference(studentId: string) {
  const row = await prisma.emailPreference.findUnique({ where: { studentId } });
  return {
    promotionalOptOut: row?.promotionalOptOut ?? false,
    optedOutAt: row?.optedOutAt ?? null,
    suppressedAt: row?.suppressedAt ?? null,
    suppressionReason: row?.suppressionReason ?? null,
  };
}

export async function setPromotionalOptOut(studentId: string, optOut: boolean, source: string) {
  const now = new Date();
  await prisma.emailPreference.upsert({
    where: { studentId },
    create: { studentId, promotionalOptOut: optOut, optedOutAt: optOut ? now : null },
    update: { promotionalOptOut: optOut, optedOutAt: optOut ? now : null },
  });
  await prisma.studentActivity.create({
    data: { studentId, activity: optOut ? "EMAIL_UNSUBSCRIBED" : "EMAIL_RESUBSCRIBED", metadata: { source } },
  });
  if (optOut) {
    // Promotional mail already queued for this student is not sent.
    await prisma.emailDeliveryLog.updateMany({
      where: { studentId, category: "PROMOTIONAL", status: "QUEUED" },
      data: { status: "SKIPPED", failureReason: "Student unsubscribed from promotional email" },
    });
  }
}
