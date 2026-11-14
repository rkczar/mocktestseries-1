import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** How long after account creation the first dashboard/welcome visit still counts as the sign-up (OTP + exam choice can take a while). */
const SIGNUP_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Server-recorded, once-per-student claim for the GA4 sign_up event: true only on the FIRST
 * dashboard/welcome render for an account created in the last 24 h. The claim is an AuditLog row
 * with the fixed id `ga4signup:<studentId>` (no migration); a second render — another page, a
 * reload, another browser or device — hits the unique id and gets false.
 */
export async function claimSignupEvent(studentId: string): Promise<boolean> {
  const s = await prisma.student.findUnique({ where: { id: studentId }, select: { createdAt: true } });
  if (!s || Date.now() - s.createdAt.getTime() >= SIGNUP_WINDOW_MS) return false;
  try {
    await prisma.auditLog.create({ data: { id: `ga4signup:${studentId}`, action: "GA4_SIGN_UP_TRACKED", entityType: "Student", entityId: studentId } });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
}
