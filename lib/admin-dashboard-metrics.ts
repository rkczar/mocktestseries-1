import "server-only";
import { CommunicationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Admin Dashboard metrics that need a precise definition (Live activity,
 * multiple sessions, communications, Action Required). Every number is a
 * read-only query against real rows — nothing is estimated.
 *
 * Activity source: the server touches StudentSession.lastSeenAt and
 * StudentDevice.lastSeenAt on authenticated student requests
 * (lib/student-devices.ts checkStudentToken), throttled to one write per
 * 5 minutes per session/device. So:
 *   - ONLINE NOW   = distinct students touched in the last 10 minutes
 *                    (two throttle intervals, so a student actively using
 *                    the site is never missed between writes);
 *   - ACTIVE (7d)  = distinct non-deleted students with server activity,
 *                    a sign-in, or a test attempt started in the last 7 days.
 * Several tabs in one browser share one cookie → one session, so tabs never
 * count twice.
 */

export const ONLINE_WINDOW_MINUTES = 10;
export const MULTI_SESSION_WINDOW_HOURS = 24;

export interface LiveActivity {
  onlineNow: number;
  active24h: number;
  active7d: number;
  totalStudents: number;
  deletedStudents: number;
}

export async function getLiveActivity(now: Date = new Date()): Promise<LiveActivity> {
  const online = new Date(now.getTime() - ONLINE_WINDOW_MINUTES * 60_000);
  const day = new Date(now.getTime() - 24 * 3600_000);
  const week = new Date(now.getTime() - 7 * 24 * 3600_000);
  const rows = await prisma.$queryRaw<{ online: bigint; d1: bigint; d7: bigint }[]>(Prisma.sql`
    WITH touches AS (
      SELECT "studentId", "lastSeenAt" AS at FROM "StudentSession" WHERE "revokedAt" IS NULL AND "lastSeenAt" >= ${week}
      UNION ALL
      SELECT "studentId", "lastSeenAt" FROM "StudentDevice" WHERE active AND "lastSeenAt" >= ${week}
      UNION ALL
      SELECT id, "lastLoginAt" FROM "Student" WHERE "lastLoginAt" >= ${week}
      UNION ALL
      SELECT "studentId", "startedAt" FROM "TestAttempt" WHERE "startedAt" >= ${week}
    ),
    live AS (
      SELECT "studentId", "lastSeenAt" AS at FROM "StudentSession" WHERE "revokedAt" IS NULL AND "expiresAt" > ${now} AND "lastSeenAt" >= ${online}
      UNION ALL
      SELECT "studentId", "lastSeenAt" FROM "StudentDevice" WHERE active AND "lastSeenAt" >= ${online}
    )
    SELECT
      (SELECT count(DISTINCT l."studentId") FROM live l JOIN "Student" s ON s.id = l."studentId" WHERE s.status <> 'DELETED') AS online,
      (SELECT count(DISTINCT t."studentId") FROM touches t JOIN "Student" s ON s.id = t."studentId" WHERE s.status <> 'DELETED' AND t.at >= ${day}) AS d1,
      (SELECT count(DISTINCT t."studentId") FROM touches t JOIN "Student" s ON s.id = t."studentId" WHERE s.status <> 'DELETED') AS d7`);
  const [total, deleted] = await Promise.all([prisma.student.count({ where: { status: { not: "DELETED" } } }), prisma.student.count({ where: { status: "DELETED" } })]);
  const r = rows[0];
  return { onlineNow: Number(r?.online ?? 0), active24h: Number(r?.d1 ?? 0), active7d: Number(r?.d7 ?? 0), totalStudents: total, deletedStudents: deleted };
}

// ---------------------------------------------------------------------------
// Multiple active sessions
// ---------------------------------------------------------------------------

export interface MultiSessionRow {
  studentDbId: string;
  studentId: string;
  name: string;
  activeSessions: number;
  lastActivity: Date;
  sessions: { method: string; device: string; browser: string | null; os: string | null; signedInAt: Date; lastSeenAt: Date }[];
}

export interface MultiSessionSummary {
  windowHours: number;
  twoPlus: number;
  threePlus: number;
  highest: number;
  rows: MultiSessionRow[];
}

/**
 * An ACTIVE SESSION is one tracked sign-in (StudentSession) that is not
 * revoked, not expired, whose device still holds a slot, and that made an
 * authenticated request in the last 24 hours. Past login attempts are not
 * sessions; tabs in one browser share one session. Tokens issued before
 * session tracking existed have no session row and are not counted.
 * Display only — nothing here blocks or signs anyone out. Token hashes are
 * never selected.
 */
export async function getMultipleSessions(now: Date = new Date(), limit = 100): Promise<MultiSessionSummary> {
  const since = new Date(now.getTime() - MULTI_SESSION_WINDOW_HOURS * 3600_000);
  const where: Prisma.StudentSessionWhereInput = {
    revokedAt: null,
    expiresAt: { gt: now },
    lastSeenAt: { gte: since },
    device: { active: true },
    student: { status: { not: "DELETED" } },
  };
  const grouped = await prisma.studentSession.groupBy({
    by: ["studentId"],
    where,
    _count: { _all: true },
    _max: { lastSeenAt: true },
    having: { studentId: { _count: { gte: 2 } } },
  });
  grouped.sort((a, b) => b._count._all - a._count._all || (b._max.lastSeenAt?.getTime() ?? 0) - (a._max.lastSeenAt?.getTime() ?? 0));
  const top = grouped.slice(0, limit);
  const [students, sessions] = await Promise.all([
    prisma.student.findMany({ where: { id: { in: top.map((g) => g.studentId) } }, select: { id: true, studentId: true, name: true } }),
    prisma.studentSession.findMany({
      where: { ...where, studentId: { in: top.map((g) => g.studentId) } },
      orderBy: { lastSeenAt: "desc" },
      select: { studentId: true, method: true, createdAt: true, lastSeenAt: true, device: { select: { displayName: true, browser: true, os: true } } },
    }),
  ]);
  const byId = new Map(students.map((s) => [s.id, s]));
  return {
    windowHours: MULTI_SESSION_WINDOW_HOURS,
    twoPlus: grouped.length,
    threePlus: grouped.filter((g) => g._count._all >= 3).length,
    highest: grouped.reduce((m, g) => Math.max(m, g._count._all), 0),
    rows: top.map((g) => ({
      studentDbId: g.studentId,
      studentId: byId.get(g.studentId)?.studentId ?? "—",
      name: byId.get(g.studentId)?.name ?? "—",
      activeSessions: g._count._all,
      lastActivity: g._max.lastSeenAt ?? now,
      sessions: sessions
        .filter((s) => s.studentId === g.studentId)
        .map((s) => ({ method: s.method, device: s.device.displayName, browser: s.device.browser, os: s.device.os, signedInAt: s.createdAt, lastSeenAt: s.lastSeenAt })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Communications + Action Required
// ---------------------------------------------------------------------------

/** Open = still needs a reply/decision. RESOLVED and ARCHIVED are done; READ is opened but not handled. */
const PENDING: CommunicationStatus[] = ["NEW", "READ", "IN_PROGRESS"];

export interface CommunicationsSummary {
  unread: number;
  contactPending: number;
  contactUnread: number;
  growPending: number;
  growUnread: number;
  fromStudentsPending: number;
  oldestPendingAt: Date | null;
}

export async function getCommunicationsSummary(): Promise<CommunicationsSummary> {
  const [rows, fromStudents, oldest] = await Promise.all([
    prisma.communication.groupBy({ by: ["type", "status"], where: { status: { in: PENDING } }, _count: { _all: true } }),
    prisma.communication.count({ where: { status: { in: PENDING }, studentId: { not: null } } }),
    prisma.communication.findFirst({ where: { status: { in: PENDING } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const n = (type: string, statuses: CommunicationStatus[]) => rows.filter((r) => r.type === type && statuses.includes(r.status)).reduce((s, r) => s + r._count._all, 0);
  return {
    unread: n("CONTACT", ["NEW"]) + n("GROW_WITH_US", ["NEW"]),
    contactPending: n("CONTACT", PENDING),
    contactUnread: n("CONTACT", ["NEW"]),
    growPending: n("GROW_WITH_US", PENDING),
    growUnread: n("GROW_WITH_US", ["NEW"]),
    fromStudentsPending: fromStudents,
    oldestPendingAt: oldest?.createdAt ?? null,
  };
}

export type ActionPriority = "urgent" | "attention" | "none";

export interface ActionItem {
  key: string;
  label: string;
  pending: number;
  priority: ActionPriority;
  detail: string;
  href: string;
}

/**
 * One row per actionable queue the viewer may see. Each pending item is
 * counted in exactly one row (Contact vs Grow With Us are disjoint types).
 * `can` is the viewer's permission set — rows for queues they can't open
 * are omitted entirely, counts included.
 */
export async function getActionRequired(can: { communications: boolean; reports: boolean; deletion: boolean; recovery: boolean; payments: boolean }, now: Date = new Date()): Promise<ActionItem[]> {
  const day = new Date(now.getTime() - 24 * 3600_000);
  const zero = Promise.resolve(0);
  const [comms, reportsOpen, reportsOld, deletion, deletionOld, recovery, recoveryOld, webhookFailed, refundsOpen, refundsFailed, paidNoAccess] = await Promise.all([
    can.communications ? getCommunicationsSummary() : Promise.resolve(null),
    can.reports ? prisma.reportedQuestion.count({ where: { status: "OPEN" } }) : zero,
    can.reports ? prisma.reportedQuestion.count({ where: { status: "OPEN", createdAt: { lt: day } } }) : zero,
    can.deletion ? prisma.deletionRequest.count({ where: { status: "PENDING" } }) : zero,
    can.deletion ? prisma.deletionRequest.count({ where: { status: "PENDING", requestedAt: { lt: day } } }) : zero,
    can.recovery ? prisma.accountRecoveryRequest.count({ where: { status: "PENDING" } }) : zero,
    can.recovery ? prisma.accountRecoveryRequest.count({ where: { status: "PENDING", submittedAt: { lt: day } } }) : zero,
    can.payments ? prisma.paymentWebhookEvent.count({ where: { status: "FAILED" } }) : zero,
    can.payments ? prisma.refund.count({ where: { status: { in: ["REQUESTED", "PROCESSING"] } } }) : zero,
    can.payments ? prisma.refund.count({ where: { status: "FAILED" } }) : zero,
    // A LIVE order marked PAID that never produced an entitlement means a student paid without getting access.
    can.payments ? prisma.paymentOrder.count({ where: { environment: "LIVE", status: "PAID", entitlement: null } }) : zero,
  ]);

  const items: ActionItem[] = [];
  const prio = (urgent: boolean, pending: number): ActionPriority => (pending === 0 ? "none" : urgent ? "urgent" : "attention");
  if (comms) {
    items.push({
      key: "contact",
      label: "Contact messages",
      pending: comms.contactPending,
      priority: prio(comms.contactUnread > 0, comms.contactPending),
      detail: comms.contactPending ? `${comms.contactUnread} unread · ${comms.contactPending - comms.contactUnread} opened, not resolved` : "Nothing waiting",
      href: "/admin/communications?tab=contact",
    });
    items.push({
      key: "grow-with-us",
      label: "Grow With Us",
      pending: comms.growPending,
      priority: prio(comms.growUnread > 0, comms.growPending),
      detail: comms.growPending ? `${comms.growUnread} unread · ${comms.growPending - comms.growUnread} opened, not resolved` : "Nothing waiting",
      href: "/admin/communications?tab=grow-with-us",
    });
  }
  if (can.reports)
    items.push({
      key: "reports",
      label: "Question reports",
      pending: reportsOpen,
      priority: prio(reportsOld > 0, reportsOpen),
      detail: reportsOpen ? `${reportsOpen} open${reportsOld ? ` · ${reportsOld} older than 24h` : ""}` : "Nothing waiting",
      href: "/admin/questions/reports",
    });
  if (can.recovery)
    items.push({
      key: "recovery",
      label: "Account recovery",
      pending: recovery,
      priority: prio(recoveryOld > 0, recovery),
      detail: recovery ? `${recovery} waiting for review${recoveryOld ? ` · ${recoveryOld} older than 24h` : ""}` : "Nothing waiting",
      href: "/admin/students?tab=account-recovery",
    });
  if (can.deletion)
    items.push({
      key: "deletion",
      label: "Student support: deletion requests",
      pending: deletion,
      priority: prio(deletionOld > 0, deletion),
      detail: deletion ? `${deletion} pending${deletionOld ? ` · ${deletionOld} older than 24h` : ""}` : "Nothing waiting",
      href: "/admin/students?tab=deletion-requests",
    });
  if (can.payments) {
    const total = webhookFailed + refundsOpen + refundsFailed + paidNoAccess;
    const parts = [
      paidNoAccess && `${paidNoAccess} paid order(s) without access`,
      webhookFailed && `${webhookFailed} failed webhook(s)`,
      refundsFailed && `${refundsFailed} failed refund(s)`,
      refundsOpen && `${refundsOpen} refund(s) in progress`,
    ].filter(Boolean);
    items.push({
      key: "payments",
      label: "Payment issues",
      pending: total,
      priority: prio(paidNoAccess + webhookFailed + refundsFailed > 0, total),
      detail: parts.length ? parts.join(" · ") : "Nothing waiting",
      href: paidNoAccess || webhookFailed ? "/admin/payments?tab=orders" : "/admin/payments?tab=refunds",
    });
  }
  return items;
}
