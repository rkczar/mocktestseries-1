import "server-only";
import { DeletionRequestStatus, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Admin read side of the retained DELETION AUDIT RECORD (DeletionRequest
 * snapshot, written by lib/student-lifecycle.ts). Callers must gate on
 * PERMISSIONS.STUDENT_DELETION_VIEW first — these return real contact data.
 *
 * Retained after an approved deletion, and why:
 *   name, student code, email, phone  — identify which person deleted which
 *                                       account (support, disputes, fraud)
 *   login methods, account created at — understand the account that existed
 *   enrolled exams, purchased products — which courses the account had
 *   reason, requested/reviewed at, reviewer — the deletion decision itself
 *   original Student.id               — join to retained anonymous attempt /
 *                                       payment / invoice rows (never a login)
 * Never retained: password or hash, OTP, OAuth tokens, session tokens, any
 * auth or payment secret.
 *
 * Every snapshot field falls back to nothing but itself: the live Student
 * row is anonymized on approval, so reading it would show "Deleted Student".
 */

const SELECT = {
  id: true,
  status: true,
  reason: true,
  notes: true,
  requestedAt: true,
  reviewedAt: true,
  studentId: true,
  studentDbIdSnapshot: true,
  studentCodeSnapshot: true,
  studentNameSnapshot: true,
  emailSnapshot: true,
  phoneSnapshot: true,
  emailMaskedSnapshot: true,
  phoneMaskedSnapshot: true,
  authMethodsSnapshot: true,
  studentCreatedAtSnapshot: true,
  enrolledExamsSnapshot: true,
  purchasedProductsSnapshot: true,
  reviewedByAdminNameSnapshot: true,
  reviewedByAdmin: { select: { name: true } },
  student: {
    select: {
      studentId: true,
      name: true,
      email: true,
      mobile: true,
      status: true,
      // Kept on the anonymized row, so still readable for pre-snapshot records.
      examEnrollments: { select: { exam: { select: { name: true } } } },
      entitlements: { select: { product: { select: { name: true } } } },
    },
  },
} as const;

type Row = NonNullable<Awaited<ReturnType<typeof findOne>>>;

function findOne(id: string) {
  return prisma.deletionRequest.findUnique({ where: { id }, select: SELECT });
}

function toRecord(r: Row) {
  // Before snapshots existed a PENDING/REJECTED row's identity lived only on
  // the Student row; use it while that row is still un-anonymized.
  const live = r.student && r.student.status !== StudentStatus.DELETED ? r.student : null;
  const email = r.emailSnapshot ?? live?.email ?? null;
  const phone = r.phoneSnapshot ?? live?.mobile ?? null;
  return {
    id: r.id,
    status: r.status,
    reason: r.reason,
    notes: r.notes,
    requestedAt: r.requestedAt,
    reviewedAt: r.reviewedAt,
    reviewer: r.reviewedByAdminNameSnapshot ?? r.reviewedByAdmin?.name ?? null,
    name: r.studentNameSnapshot ?? live?.name ?? null,
    code: r.studentCodeSnapshot ?? r.student?.studentId ?? null,
    email,
    phone,
    /** True when raw contact was never captured (approved before retention) and only a masked form exists. */
    contactMaskedOnly: !email && !phone && Boolean(r.emailMaskedSnapshot || r.phoneMaskedSnapshot),
    emailMasked: r.emailMaskedSnapshot,
    phoneMasked: r.phoneMaskedSnapshot,
    authMethods: r.authMethodsSnapshot,
    enrolledExams: r.enrolledExamsSnapshot.length
      ? r.enrolledExamsSnapshot
      : (r.student?.examEnrollments.map((e) => e.exam.name).sort() ?? []),
    purchasedProducts: r.purchasedProductsSnapshot.length
      ? r.purchasedProductsSnapshot
      : [...new Set(r.student?.entitlements.map((e) => e.product.name) ?? [])].sort(),
    accountCreatedAt: r.studentCreatedAtSnapshot,
    originalStudentDbId: r.studentDbIdSnapshot ?? r.studentId,
    liveStudentStatus: r.student?.status ?? null,
  };
}

export type DeletionRecord = ReturnType<typeof toRecord>;

export async function listDeletionRecords(): Promise<DeletionRecord[]> {
  const rows = await prisma.deletionRequest.findMany({ orderBy: { requestedAt: "desc" }, select: SELECT });
  return rows.map(toRecord);
}

/** One record plus what actually happened to the account and its history. */
export async function getDeletionRecordDetail(id: string) {
  const row = await findOne(id);
  if (!row) return null;
  const record = toRecord(row);
  const dbId = record.originalStudentDbId;
  const [attempts, orders, payments, invoices, entitlements] = dbId
    ? await Promise.all([
        prisma.testAttempt.count({ where: { studentId: dbId } }),
        prisma.paymentOrder.count({ where: { studentId: dbId } }),
        prisma.payment.count({ where: { studentId: dbId } }),
        prisma.invoice.count({ where: { studentId: dbId } }),
        prisma.studentEntitlement.count({ where: { studentId: dbId } }),
      ])
    : [0, 0, 0, 0, 0];

  const status = record.liveStudentStatus;
  const approved = record.status === DeletionRequestStatus.APPROVED;
  return {
    record,
    outcome: {
      // An approved deletion's row is DELETED (or gone); it can never sign in.
      activeAccount: !approved && (status === StudentStatus.ACTIVE || status === StudentStatus.DELETION_REQUESTED),
      authRevoked: approved && status !== StudentStatus.ACTIVE && status !== StudentStatus.DELETION_REQUESTED,
      attemptsRetained: attempts,
      paymentRecordsRetained: { orders, payments, invoices },
      entitlementsRetained: entitlements,
    },
  };
}
