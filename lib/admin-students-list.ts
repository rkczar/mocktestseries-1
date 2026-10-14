import "server-only";
import { EntitlementStatus, Prisma, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPremiumPolicy } from "@/lib/premium-policy";

/**
 * Admin → Students → All Students: server-side search, filters and
 * pagination over the complete Student table. Only the requested page is
 * read; counts come from COUNT queries, so every registered student is
 * reachable however many there are. Read-only — never writes a student row.
 */

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export type AccountFilter = "all" | "active" | "inactive";
export type AccessFilter = "all" | "premium" | "trial" | "free";
export type SortOrder = "newest" | "oldest";

export interface StudentListParams {
  q: string;
  account: AccountFilter;
  access: AccessFilter;
  sort: SortOrder;
  page: number;
  perPage: PageSize;
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function parseStudentListParams(sp: Record<string, string | string[] | undefined>): StudentListParams {
  const per = Number(one(sp.per));
  const page = Math.floor(Number(one(sp.page)));
  const account = one(sp.account);
  const access = one(sp.access);
  return {
    q: one(sp.q).trim().slice(0, 100),
    account: account === "active" || account === "inactive" ? account : "all",
    access: access === "premium" || access === "trial" || access === "free" ? access : "all",
    sort: one(sp.sort) === "oldest" ? "oldest" : "newest",
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    perPage: (PAGE_SIZES as readonly number[]).includes(per) ? (per as PageSize) : 50,
  };
}

/** "MTS0030", "mts-30", "30" → "MTS-000030" (the stored studentId format). */
export function normalizeStudentCode(q: string): string | null {
  const m = /^(?:mts)?[-\s]?0*(\d{1,6})$/i.exec(q.replace(/\s+/g, ""));
  return m ? `MTS-${m[1].padStart(6, "0")}` : null;
}

/** Which product ids count as "Premium": the policy's Premium products, else any paid/granted entitlement. */
async function premiumEntitlementWhere(now: Date): Promise<Prisma.StudentEntitlementWhereInput> {
  const policy = await getPremiumPolicy().catch(() => null);
  const ids = policy?.premiumProductIds ?? [];
  return {
    status: EntitlementStatus.ACTIVE,
    startsAt: { lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    ...(ids.length ? { productId: { in: ids } } : { source: { not: "FREE" } }),
  };
}

export async function buildStudentWhere(p: StudentListParams, now: Date): Promise<Prisma.StudentWhereInput> {
  const and: Prisma.StudentWhereInput[] = [{ status: { not: StudentStatus.DELETED } }];
  if (p.account === "active") and.push({ status: StudentStatus.ACTIVE });
  if (p.account === "inactive") and.push({ status: { in: [StudentStatus.SUSPENDED, StudentStatus.DELETION_REQUESTED] } });

  if (p.q) {
    const or: Prisma.StudentWhereInput[] = [
      { studentId: { contains: p.q, mode: "insensitive" } },
      { name: { contains: p.q, mode: "insensitive" } },
      { email: { contains: p.q, mode: "insensitive" } },
      { mobile: { contains: p.q } },
    ];
    const code = normalizeStudentCode(p.q);
    if (code) or.push({ studentId: code });
    const digits = p.q.replace(/\D/g, "");
    if (digits.length >= 4 && digits !== p.q) or.push({ mobile: { contains: digits } });
    and.push({ OR: or });
  }

  if (p.access !== "all") {
    const premium: Prisma.StudentWhereInput = { entitlements: { some: await premiumEntitlementWhere(now) } };
    const trial: Prisma.StudentWhereInput = { premiumTrial: { is: { startedAt: { lte: now }, endsAt: { gt: now } } } };
    if (p.access === "premium") and.push(premium);
    if (p.access === "trial") and.push(trial, { NOT: premium });
    if (p.access === "free") and.push({ NOT: premium }, { NOT: trial });
  }
  return { AND: and };
}

export type StudentAccessLabel = "PREMIUM" | "TRIAL" | "FREE";

export async function loadStudentList(p: StudentListParams, now: Date = new Date()) {
  const where = await buildStudentWhere(p, now);
  const [total, filtered] = await Promise.all([
    prisma.student.count({ where: { status: { not: StudentStatus.DELETED } } }),
    prisma.student.count({ where }),
  ]);
  const pageCount = Math.max(1, Math.ceil(filtered / p.perPage));
  const page = Math.min(p.page, pageCount);
  const dir = p.sort === "oldest" ? "asc" : "desc";
  const students = await prisma.student.findMany({
    where,
    // createdAt alone can tie (bulk-created rows); the unique id makes the order deterministic.
    orderBy: [{ createdAt: dir }, { id: dir }],
    skip: (page - 1) * p.perPage,
    take: p.perPage,
    select: {
      id: true,
      studentId: true,
      name: true,
      email: true,
      mobile: true,
      status: true,
      createdAt: true,
      lastLoginAt: true,
      _count: { select: { testAttempts: true } },
      premiumTrial: { select: { startedAt: true, endsAt: true } },
    },
  });

  // Access label for just this page's rows (one query).
  const premiumIds = new Set(
    (
      await prisma.studentEntitlement.findMany({
        where: { studentId: { in: students.map((s) => s.id) }, ...(await premiumEntitlementWhere(now)) },
        select: { studentId: true },
      })
    ).map((e) => e.studentId)
  );
  // Last activity = the most recent server-side touch of any session/device (throttled to 5 min), else last sign-in.
  const seen = await prisma.studentDevice.groupBy({
    by: ["studentId"],
    where: { studentId: { in: students.map((s) => s.id) } },
    _max: { lastSeenAt: true },
  });
  const seenMap = new Map(seen.map((r) => [r.studentId, r._max.lastSeenAt]));

  const rows = students.map((s) => {
    const trialActive = Boolean(s.premiumTrial && s.premiumTrial.startedAt <= now && s.premiumTrial.endsAt > now);
    const access: StudentAccessLabel = premiumIds.has(s.id) ? "PREMIUM" : trialActive ? "TRIAL" : "FREE";
    const lastSeen = seenMap.get(s.id) ?? null;
    const lastActivity = [lastSeen, s.lastLoginAt].filter((d): d is Date => d instanceof Date).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    return { ...s, access, lastActivity };
  });

  return { total, filtered, page, pageCount, perPage: p.perPage, rows };
}
