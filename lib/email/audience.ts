import "server-only";
import type { EmailAudience, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Recipient resolution for Compose / Campaigns — always server-side, from
 * the audience type + ids, never from a list of addresses sent by the
 * browser. Only ACTIVE students with an email address qualify; promotional
 * sends also drop students who unsubscribed or whose address is suppressed.
 *
 *   PAID = holds at least one current non-FREE entitlement (purchase,
 *          coupon, admin grant or promotion; not revoked, not expired)
 *   FREE = every other active student
 */

export const MAX_SELECTED_STUDENTS = 500;

export interface AudienceSpec {
  audience: EmailAudience;
  examId?: string | null;
  studentIds?: string[];
}

function paidEntitlement(now: Date): Prisma.StudentEntitlementWhereInput {
  return {
    status: "ACTIVE",
    source: { not: "FREE" },
    startsAt: { lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };
}

export function audienceWhere(spec: AudienceSpec, now = new Date()): Prisma.StudentWhereInput {
  const base: Prisma.StudentWhereInput = { status: "ACTIVE", email: { not: null } };
  switch (spec.audience) {
    case "ALL":
      return base;
    case "PAID":
      return { ...base, entitlements: { some: paidEntitlement(now) } };
    case "FREE":
      return { ...base, entitlements: { none: paidEntitlement(now) } };
    case "EXAM":
      if (!spec.examId) return { id: "__none__" };
      return { ...base, examEnrollments: { some: { examId: spec.examId } } };
    case "INDIVIDUAL":
    case "SELECTED": {
      const ids = (spec.studentIds ?? []).slice(0, spec.audience === "INDIVIDUAL" ? 1 : MAX_SELECTED_STUDENTS);
      if (ids.length === 0) return { id: "__none__" };
      return { ...base, id: { in: ids } };
    }
  }
}

const promotionalAllowed: Prisma.StudentWhereInput = {
  OR: [{ emailPreference: null }, { emailPreference: { promotionalOptOut: false, suppressedAt: null } }],
};

export function sendableWhere(spec: AudienceSpec, now = new Date()): Prisma.StudentWhereInput {
  return { AND: [audienceWhere(spec, now), promotionalAllowed] };
}

export async function countAudience(spec: AudienceSpec) {
  const now = new Date();
  const [matching, sendable] = await Promise.all([
    prisma.student.count({ where: audienceWhere(spec, now) }),
    prisma.student.count({ where: sendableWhere(spec, now) }),
  ]);
  return { matching, sendable, excluded: matching - sendable };
}

/** Pages through sendable students by id (stable cursor) for queueing. */
export async function* iterateSendable(spec: AudienceSpec, pageSize = 1000) {
  const now = new Date();
  let cursor: string | undefined;
  for (;;) {
    const page = await prisma.student.findMany({
      where: sendableWhere(spec, now),
      select: { id: true, email: true },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) return;
    yield page;
    cursor = page[page.length - 1].id;
    if (page.length < pageSize) return;
  }
}

/** Admin recipient search: name / email / mobile / User ID. */
export async function searchStudents(query: string, limit = 20) {
  const q = query.trim();
  if (q.length < 2) return [];
  const digits = q.replace(/[^\d]/g, "");
  return prisma.student.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q.toLowerCase(), mode: "insensitive" } },
        { studentId: { contains: q.toUpperCase() } },
        ...(digits.length >= 4 ? [{ mobile: { contains: digits } }] : []),
      ],
    },
    select: { id: true, name: true, email: true, mobile: true, studentId: true },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
