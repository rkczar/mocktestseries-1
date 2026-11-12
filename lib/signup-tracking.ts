import "server-only";
import { prisma } from "@/lib/prisma";

/** True for an account created in the last 30 minutes (drives the one-time GA4 sign_up event). */
export async function recentSignup(studentId: string): Promise<boolean> {
  const s = await prisma.student.findUnique({ where: { id: studentId }, select: { createdAt: true } });
  return !!s && Date.now() - s.createdAt.getTime() < 30 * 60_000;
}
