import { DeletionRequestStatus, Prisma, StudentAuthProvider, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { maskEmail, maskPhone } from "@/lib/pii-mask";
import { nextStudentId } from "@/lib/student-id";

/**
 * Student account lifecycle — the single implementation of account-deletion
 * request / approve / reject, and of "may this Student row authenticate?".
 *
 *   ACTIVE -> request -> DELETION_REQUESTED (+ one PENDING DeletionRequest)
 *     reject  -> ACTIVE again
 *     approve -> DELETED: deletion audit record finalized (name, code,
 *                contact, auth methods — never credentials), PII on the
 *                Student row anonymized, every
 *                login identifier (email, mobile, password, Google link)
 *                released, all sessions revoked.
 *
 * Revocation is server-side: student sessions are stateless JWTs, so the
 * Node-runtime jwt callback in lib/auth-student.ts re-checks
 * isStudentAuthEligible() on every auth() call and drops the session when
 * the row is DELETED/SUSPENDED/missing. Because a deleted row is never
 * reactivated (re-registration always creates a NEW Student with a new
 * MTS code), status alone is a sufficient revocation key.
 *
 * DELETED is not a ban: nothing here keeps a deny-list of the old email,
 * phone or Google account. SUSPENDED remains the only blocking status.
 *
 * The DeletionRequest audit record (lib/deletion-history.ts) retains the
 * real name/code/email/phone for authorized Admins. It is history, not an
 * identity: no authentication or registration path may ever query it, so a
 * retained email/phone is never treated as "taken". Each delete/re-register
 * cycle produces its own independent record.
 */

/** Statuses that may hold a session / sign in. A pending deletion is still a live account. */
export const AUTH_ELIGIBLE_STATUSES: readonly StudentStatus[] = [
  StudentStatus.ACTIVE,
  StudentStatus.DELETION_REQUESTED,
];

export function isStudentAuthEligible(status: StudentStatus | null | undefined): boolean {
  return !!status && AUTH_ELIGIBLE_STATUSES.includes(status);
}

/** Current status of a Student row, or null if it no longer exists. */
export async function getStudentAuthStatus(studentDbId: string): Promise<StudentStatus | null> {
  const row = await prisma.student.findUnique({ where: { id: studentDbId }, select: { status: true } });
  return row?.status ?? null;
}

export class DeletionLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeletionLifecycleError";
  }
}

export const DELETED_STUDENT_NAME = "Deleted Student";

type SnapshotSource = {
  id: string;
  studentId: string;
  name: string;
  email: string | null;
  mobile: string | null;
  authProvider: StudentAuthProvider;
  passwordHash: string | null;
  createdAt: Date;
  oauthAccounts: { provider: string }[];
  examEnrollments: { exam: { name: string } }[];
  entitlements: { product: { name: string } }[];
};

/** Relations identitySnapshot() needs — include this wherever a SnapshotSource is loaded. */
const SNAPSHOT_INCLUDE = {
  oauthAccounts: { select: { provider: true } },
  examEnrollments: { select: { exam: { select: { name: true } } } },
  entitlements: { select: { product: { select: { name: true } } } },
} as const;

/**
 * The retained deletion audit record: who the student was, how to contact
 * them, how they signed in. This is an explicit allow-list — a credential
 * (passwordHash), OTP, OAuth token or session value can never reach the
 * record because nothing here copies one. `passwordHash` is only tested for
 * presence to record that "CREDENTIALS" was a login method.
 */
function identitySnapshot(s: SnapshotSource) {
  const methods = new Set<string>([s.authProvider]);
  if (s.passwordHash) methods.add(StudentAuthProvider.CREDENTIALS);
  for (const o of s.oauthAccounts) methods.add(o.provider);
  return {
    studentDbIdSnapshot: s.id,
    studentCodeSnapshot: s.studentId,
    studentNameSnapshot: s.name,
    emailSnapshot: s.email,
    phoneSnapshot: s.mobile,
    authMethodsSnapshot: [...methods].sort(),
    studentCreatedAtSnapshot: s.createdAt,
    enrolledExamsSnapshot: s.examEnrollments.map((e) => e.exam.name).sort(),
    purchasedProductsSnapshot: [...new Set(s.entitlements.map((e) => e.product.name))].sort(),
    emailMaskedSnapshot: maskEmail(s.email),
    phoneMaskedSnapshot: maskPhone(s.mobile),
  };
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Student-initiated request. One PENDING request per student, enforced both
 * here and by the partial unique index DeletionRequest_one_pending_per_student
 * (so a double-submit race cannot create two).
 */
export async function createDeletionRequest(studentDbId: string, reason: string | undefined) {
  try {
    return await prisma.$transaction(async (tx) => {
      const student = await tx.student.findUnique({ where: { id: studentDbId }, include: SNAPSHOT_INCLUDE });
      if (!student || !isStudentAuthEligible(student.status)) {
        throw new DeletionLifecycleError("This account is no longer active.");
      }
      const pending = await tx.deletionRequest.findFirst({
        where: { studentId: studentDbId, status: DeletionRequestStatus.PENDING },
        select: { id: true },
      });
      if (pending) throw new DeletionLifecycleError("You already have a pending deletion request.");

      const request = await tx.deletionRequest.create({
        data: { studentId: studentDbId, reason: reason || null, ...identitySnapshot(student) },
      });
      await tx.student.updateMany({
        where: { id: studentDbId, status: StudentStatus.ACTIVE },
        data: { status: StudentStatus.DELETION_REQUESTED },
      });
      await tx.studentActivity.create({
        data: { studentId: studentDbId, activity: "DELETION_REQUESTED", metadata: { requestId: request.id } },
      });
      await tx.auditLog.create({
        data: {
          action: "STUDENT_DELETION_REQUESTED",
          entityType: "DeletionRequest",
          entityId: request.id,
          metadata: { studentCode: student.studentId },
        },
      });
      return request;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DeletionLifecycleError("You already have a pending deletion request.");
    throw error;
  }
}

type AdminActor = { id: string; name: string | null | undefined };

/**
 * Approve = one transaction. The PENDING -> APPROVED claim is a conditional
 * update that also writes the final audit snapshot, so a double-click / two
 * admins racing resolves to exactly one approval (the loser's WHERE
 * re-evaluates to 0 rows after the row lock is released), and the snapshot
 * is written while the row is still PENDING — after that the
 * DeletionRequest_audit_guard trigger makes the record immutable. Any
 * failure rolls back everything — the request is never left APPROVED with
 * a still-usable account.
 */
export async function approveStudentDeletion(requestId: string, admin: AdminActor) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.deletionRequest.findUnique({
      where: { id: requestId },
      include: { student: { include: SNAPSHOT_INCLUDE } },
    });
    if (!request || request.status !== DeletionRequestStatus.PENDING) {
      throw new DeletionLifecycleError("This request is no longer pending.");
    }
    const student = request.student;
    if (!student || student.status === StudentStatus.DELETED) {
      throw new DeletionLifecycleError("This account has already been deleted.");
    }

    // 1. Claim + snapshot BEFORE anonymizing (fresh values — the student may
    //    have changed contact details since filing).
    const claimed = await tx.deletionRequest.updateMany({
      where: { id: requestId, status: DeletionRequestStatus.PENDING },
      data: {
        ...identitySnapshot(student),
        status: DeletionRequestStatus.APPROVED,
        reviewedAt: new Date(),
        reviewedByAdminId: admin.id,
        reviewedByAdminNameSnapshot: admin.name ?? null,
      },
    });
    if (claimed.count === 0) throw new DeletionLifecycleError("This request is no longer pending.");

    // 2. Release the Google identity. A leftover StudentOAuthAccount row is
    //    what made a later Google sign-in resolve to the DELETED student and
    //    fail with AccessDenied. Only this student's own links are removed.
    const oauth = await tx.studentOAuthAccount.deleteMany({ where: { studentId: student.id } });

    // 3. Anonymize profile + account PII and release email/mobile/password
    //    (both unique columns go NULL, so registration can reuse them).
    //    status=DELETED is the server-side session revocation key.
    await tx.studentProfile.updateMany({ where: { studentId: student.id }, data: { photoUrl: null, bio: null } });
    await tx.student.update({
      where: { id: student.id },
      data: {
        name: DELETED_STUDENT_NAME,
        email: null,
        mobile: null,
        passwordHash: null,
        status: StudentStatus.DELETED,
      },
    });

    // 4. Login telemetry kept raw email/mobile as `identifier` — replace it
    //    with the anonymous code so the retained rows no longer carry PII.
    await tx.studentLoginAttempt.updateMany({
      where: { studentId: student.id },
      data: { identifier: `deleted:${student.studentId}` },
    });

    // Attempts, answers, saved questions, payments/orders/invoices and
    // entitlements stay attached to the (now anonymous, unusable) row:
    // exam analytics and accounting remain intact, and nothing is ever
    // re-attached to a future account registered with the same contact.

    const meta = { requestId, studentCode: student.studentId };
    await tx.auditLog.createMany({
      data: [
        { actorId: admin.id, action: "STUDENT_DELETION_APPROVED", entityType: "DeletionRequest", entityId: requestId, metadata: meta },
        {
          actorId: admin.id,
          action: "STUDENT_IDENTITY_ANONYMIZED",
          entityType: "Student",
          entityId: student.id,
          metadata: { ...meta, oauthLinksRemoved: oauth.count },
        },
        { actorId: admin.id, action: "STUDENT_AUTH_REVOKED", entityType: "Student", entityId: student.id, metadata: meta },
      ],
    });

    return { studentDbId: student.id, studentCode: student.studentId };
  });
}

export async function rejectStudentDeletion(requestId: string, admin: AdminActor) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.deletionRequest.updateMany({
      where: { id: requestId, status: DeletionRequestStatus.PENDING },
      data: {
        status: DeletionRequestStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedByAdminId: admin.id,
        reviewedByAdminNameSnapshot: admin.name ?? null,
      },
    });
    if (claimed.count === 0) throw new DeletionLifecycleError("This request is no longer pending.");

    const request = await tx.deletionRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { studentId: true, studentCodeSnapshot: true },
    });
    if (request.studentId) await tx.student.updateMany({
      where: { id: request.studentId, status: StudentStatus.DELETION_REQUESTED },
      data: { status: StudentStatus.ACTIVE },
    });
    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "STUDENT_DELETION_REJECTED",
        entityType: "DeletionRequest",
        entityId: requestId,
        metadata: { requestId, studentCode: request.studentCodeSnapshot },
      },
    });
  });
}

/**
 * Google sign-in identity resolution (called from the signIn callback in
 * lib/auth-student.ts): existing link -> account with the same email ->
 * brand-new Student. Returns null only when a new account would be needed
 * but Google supplied no email. The caller still enforces
 * isStudentAuthEligible() on the result.
 */
export async function resolveGoogleStudent(input: {
  providerAccountId: string;
  email: string | undefined;
  name: string | null;
  picture: string | null;
}) {
  const { providerAccountId, email } = input;
  const existingLink = await prisma.studentOAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider: "GOOGLE", providerAccountId } },
    include: { student: true },
  });

  let student = existingLink?.student ?? null;

  // Approval removes a deleted account's Google link, but a link left behind
  // by the pre-lifecycle approval code must never resolve this Google
  // identity to the dead account — that returned AccessDenied and blocked
  // re-registration. Drop the stale link and continue as a new sign-up.
  // SUSPENDED is a real block and is deliberately NOT released here.
  if (existingLink && student?.status === StudentStatus.DELETED) {
    await prisma.studentOAuthAccount.delete({ where: { id: existingLink.id } });
    student = null;
  }

  if (!student && email) {
    student = await prisma.student.findUnique({ where: { email } });
    if (student) {
      await prisma.studentOAuthAccount.create({
        data: { studentId: student.id, provider: "GOOGLE", providerAccountId, email },
      });
      return { student, created: false };
    }
  }

  if (student) return { student, created: false };
  if (!email) return null;

  const studentId = await nextStudentId();
  const created = await prisma.student.create({
    data: { studentId, name: input.name ?? "Student", email, authProvider: StudentAuthProvider.GOOGLE },
  });
  await prisma.studentProfile.create({ data: { studentId: created.id, photoUrl: input.picture ?? undefined } });
  await prisma.studentOAuthAccount.create({
    data: { studentId: created.id, provider: "GOOGLE", providerAccountId, email },
  });
  await prisma.studentActivity.create({
    data: { studentId: created.id, activity: "REGISTERED", metadata: { method: "google" } },
  });
  return { student: created, created: true };
}
