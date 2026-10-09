import "server-only";
import { Prisma, type AccountRecoveryStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseIndianMobile, storedMobileVariants } from "@/lib/indian-mobile";
import { sendEmailOtp, verifyEmailOtp, maskEmail, isEmailOtpAvailable, EmailOtpError } from "@/lib/email-otp";

/**
 * Duplicate-number recovery: a student proved (SMS OTP) a mobile number that
 * another account already holds.
 *
 * - The conflict is recorded server-side as a DRAFT request right after the
 *   OTP succeeded (lib/mobile-verification.ts) — the browser never supplies
 *   the proof. The student may add an optional note and, when the holder
 *   account has an email and Email OTP is on, prove that email too. Then they
 *   submit (PENDING).
 * - Nothing moves until an Admin approves. Approval moves ONLY the mobile
 *   number: the holder keeps every attempt, score, payment and entitlement;
 *   accounts are never merged or deleted.
 * - Approval re-checks everything inside one transaction: still PENDING, the
 *   holder still holds that number, the requester still has no verified
 *   number. Any change → the admin gets a clear error and nothing is written.
 */

export class AccountRecoveryError extends Error {}

/** A proof older than this must be redone (re-verify the number) before submitting. */
const PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NOTE_MAX = 500;
const OPEN: AccountRecoveryStatus[] = ["DRAFT", "PENDING"];

// -------------------------------------------------------------- Student side

/** Called by confirmMobileVerificationOtp() after a successful OTP hit a number held elsewhere. */
export async function recordMobileConflict(requesterId: string, e164: string, holders: { id: string; status: string }[]) {
  const holder = holders.find((h) => h.status !== "DELETED") ?? holders[0];
  const now = new Date();
  const open = await prisma.accountRecoveryRequest.findFirst({ where: { requesterId, status: { in: OPEN } } });
  if (open) {
    if (open.status === "PENDING" && open.mobile === e164) return open; // already under review
    // A new proof replaces the open DRAFT (or a PENDING one for another number).
    return prisma.accountRecoveryRequest.update({
      where: { id: open.id },
      data: {
        mobile: e164,
        holderId: holder?.id ?? null,
        mobileProvedAt: now,
        holderEmailProvedAt: open.mobile === e164 && open.holderId === holder?.id ? open.holderEmailProvedAt : null,
        conflictingAccounts: holders.length,
        status: "DRAFT",
        submittedAt: null,
      },
    });
  }
  try {
    return await prisma.accountRecoveryRequest.create({
      data: { requesterId, holderId: holder?.id ?? null, mobile: e164, mobileProvedAt: now, conflictingAccounts: holders.length },
    });
  } catch (error) {
    // Parallel duplicate submit: the partial unique index kept a single open request.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.accountRecoveryRequest.findFirst({ where: { requesterId, status: { in: OPEN } } });
      if (existing) return existing;
    }
    throw error;
  }
}

export interface StudentRecoveryView {
  id: string;
  status: AccountRecoveryStatus;
  mobile: string;
  /** Masked holder email, shown only to the requester who proved the number. */
  holderEmailMasked: string | null;
  holderEmailProved: boolean;
  emailProofAvailable: boolean;
  proofExpired: boolean;
  submittedAt: Date | null;
  studentNote: string | null;
}

async function toStudentView(row: {
  id: string;
  status: AccountRecoveryStatus;
  mobile: string;
  holderId: string | null;
  holderEmailProvedAt: Date | null;
  mobileProvedAt: Date;
  submittedAt: Date | null;
  studentNote: string | null;
}): Promise<StudentRecoveryView> {
  const holder = row.holderId ? await prisma.student.findUnique({ where: { id: row.holderId }, select: { email: true } }) : null;
  return {
    id: row.id,
    status: row.status,
    mobile: row.mobile,
    holderEmailMasked: maskEmail(holder?.email),
    holderEmailProved: Boolean(row.holderEmailProvedAt),
    emailProofAvailable: Boolean(holder?.email) && (await isEmailOtpAvailable()),
    proofExpired: Date.now() - row.mobileProvedAt.getTime() > PROOF_MAX_AGE_MS,
    submittedAt: row.submittedAt,
    studentNote: row.studentNote,
  };
}

/** The requester's open request (DRAFT/PENDING), or the latest closed one for status display. */
export async function getStudentRecoveryState(requesterId: string): Promise<StudentRecoveryView | null> {
  const row =
    (await prisma.accountRecoveryRequest.findFirst({ where: { requesterId, status: { in: OPEN } } })) ??
    (await prisma.accountRecoveryRequest.findFirst({
      where: { requesterId, status: { in: ["REJECTED", "APPROVED"] }, reviewedAt: { gte: new Date(Date.now() - 30 * 864e5) } },
      orderBy: { reviewedAt: "desc" },
    }));
  return row ? toStudentView(row) : null;
}

async function ownOpenRequest(requesterId: string, requestId: string, status: AccountRecoveryStatus[] = ["DRAFT"]) {
  const row = await prisma.accountRecoveryRequest.findFirst({ where: { id: requestId, requesterId, status: { in: status } } });
  if (!row) throw new AccountRecoveryError("This request is no longer open. Please verify your number again.");
  return row;
}

/** Optional extra proof: a code sent to the HOLDER account's email. */
export async function sendHolderEmailProof(requesterId: string, requestId: string, ipAddress: string) {
  const row = await ownOpenRequest(requesterId, requestId);
  const holder = row.holderId ? await prisma.student.findUnique({ where: { id: row.holderId }, select: { email: true } }) : null;
  if (!holder?.email) throw new AccountRecoveryError("The other account has no email address to verify.");
  try {
    await sendEmailOtp({ email: holder.email, purpose: "RECOVERY_PROOF", studentId: requesterId, recoveryRequestId: row.id, ipAddress });
  } catch (error) {
    if (error instanceof EmailOtpError) throw new AccountRecoveryError(error.message);
    throw error;
  }
  return { holderEmailMasked: maskEmail(holder.email) };
}

export async function confirmHolderEmailProof(requesterId: string, requestId: string, code: string) {
  const row = await ownOpenRequest(requesterId, requestId);
  const holder = row.holderId ? await prisma.student.findUnique({ where: { id: row.holderId }, select: { email: true } }) : null;
  if (!holder?.email) throw new AccountRecoveryError("The other account has no email address to verify.");
  try {
    await verifyEmailOtp({ email: holder.email, purpose: "RECOVERY_PROOF", studentId: requesterId, recoveryRequestId: row.id, code });
  } catch (error) {
    if (error instanceof EmailOtpError) throw new AccountRecoveryError(error.message);
    throw error;
  }
  await prisma.accountRecoveryRequest.updateMany({ where: { id: row.id, status: "DRAFT" }, data: { holderEmailProvedAt: new Date() } });
}

export async function submitRecoveryRequest(requesterId: string, requestId: string, rawNote: string) {
  const row = await ownOpenRequest(requesterId, requestId);
  if (Date.now() - row.mobileProvedAt.getTime() > PROOF_MAX_AGE_MS) {
    throw new AccountRecoveryError("Your number verification has expired. Please verify the number again, then submit.");
  }
  const note = String(rawNote ?? "").trim().slice(0, NOTE_MAX) || null;
  const updated = await prisma.accountRecoveryRequest.updateMany({
    where: { id: row.id, status: "DRAFT" },
    data: { status: "PENDING", submittedAt: new Date(), studentNote: note },
  });
  if (updated.count !== 1) throw new AccountRecoveryError("This request is no longer open. Please verify your number again.");
  await prisma.studentActivity.create({
    data: { studentId: requesterId, activity: "RECOVERY_REQUEST_SUBMITTED", metadata: { requestId: row.id, emailProved: Boolean(row.holderEmailProvedAt) } },
  });
}

export async function cancelRecoveryRequest(requesterId: string, requestId: string) {
  await ownOpenRequest(requesterId, requestId, OPEN);
  await prisma.accountRecoveryRequest.updateMany({ where: { id: requestId, requesterId, status: { in: OPEN } }, data: { status: "CANCELLED" } });
}

// ---------------------------------------------------------------- Admin side

const accountSelect = {
  id: true,
  studentId: true,
  name: true,
  email: true,
  emailVerifiedAt: true,
  mobile: true,
  mobileVerifiedAt: true,
  authProvider: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  passwordHash: true,
  _count: { select: { testAttempts: true, oauthAccounts: true, entitlements: true } },
} satisfies Prisma.StudentSelect;

type AccountRow = Prisma.StudentGetPayload<{ select: typeof accountSelect }>;

export interface RecoveryAccountSummary {
  id: string;
  studentCode: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  mobile: string | null;
  mobileVerified: boolean;
  authProvider: string;
  status: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  hasPassword: boolean;
  googleLinked: boolean;
  attempts: number;
  entitlements: number;
  capturedPayments: number;
}

async function summarize(row: AccountRow | null): Promise<RecoveryAccountSummary | null> {
  if (!row) return null;
  const capturedPayments = await prisma.payment.count({ where: { studentId: row.id, status: "CAPTURED" } });
  return {
    id: row.id,
    studentCode: row.studentId,
    name: row.name,
    email: row.email,
    emailVerified: Boolean(row.emailVerifiedAt),
    mobile: row.mobile,
    mobileVerified: Boolean(row.mobileVerifiedAt),
    authProvider: row.authProvider,
    status: row.status,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    hasPassword: Boolean(row.passwordHash),
    googleLinked: row._count.oauthAccounts > 0,
    attempts: row._count.testAttempts,
    entitlements: row._count.entitlements,
    capturedPayments,
  };
}

export async function listRecoveryRequests() {
  const rows = await prisma.accountRecoveryRequest.findMany({
    where: { status: { not: "DRAFT" } },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      requester: { select: { studentId: true, name: true } },
      holder: { select: { studentId: true, name: true } },
    },
  });
  const drafts = await prisma.accountRecoveryRequest.count({ where: { status: "DRAFT" } });
  return { rows, drafts };
}

export async function getRecoveryRequestDetail(requestId: string) {
  const row = await prisma.accountRecoveryRequest.findUnique({ where: { id: requestId } });
  if (!row) return null;
  const [requester, holder] = await Promise.all([
    row.requesterId ? prisma.student.findUnique({ where: { id: row.requesterId }, select: accountSelect }).then(summarize) : null,
    row.holderId ? prisma.student.findUnique({ where: { id: row.holderId }, select: accountSelect }).then(summarize) : null,
  ]);
  return { request: row, requester, holder };
}

/**
 * Approve = move the proven number from the holder to the requester. Nothing
 * else changes on either account.
 */
export async function approveRecoveryRequest(requestId: string, admin: { id: string; name: string | null | undefined }, rawNotes: string) {
  const notes = String(rawNotes ?? "").trim().slice(0, 1000) || null;
  await prisma.$transaction(async (tx) => {
    // Row lock: two admins approving at once serialize here.
    await tx.$queryRaw`SELECT id FROM "AccountRecoveryRequest" WHERE id = ${requestId} FOR UPDATE`;
    const req = await tx.accountRecoveryRequest.findUnique({ where: { id: requestId } });
    if (!req || req.status !== "PENDING") throw new AccountRecoveryError("This request is no longer pending.");
    if (!req.requesterId) throw new AccountRecoveryError("The requesting account no longer exists.");
    const mobile = parseIndianMobile(req.mobile);
    if (!mobile) throw new AccountRecoveryError("The stored number is not a valid Indian mobile.");

    const requester = await tx.student.findUnique({ where: { id: req.requesterId }, select: { id: true, status: true, mobile: true, mobileVerifiedAt: true } });
    if (!requester || requester.status !== "ACTIVE") throw new AccountRecoveryError("The requesting account is not active.");
    if (requester.mobileVerifiedAt) throw new AccountRecoveryError("The requesting account has verified another number since this request. Reject it instead.");

    const holders = await tx.student.findMany({
      where: { mobile: { in: storedMobileVariants(mobile) }, id: { not: requester.id } },
      select: { id: true, mobile: true },
    });
    if (holders.length > 1) throw new AccountRecoveryError("More than one other account holds this number. Resolve it from the student records first.");
    const holder = holders[0] ?? null;
    if (holder && holder.id !== req.holderId) throw new AccountRecoveryError("A different account holds this number now. Ask the student to verify again.");

    if (holder) {
      await tx.student.update({ where: { id: holder.id }, data: { mobile: null, mobileVerifiedAt: null } });
      await tx.studentActivity.create({
        data: { studentId: holder.id, activity: "MOBILE_RELEASED_BY_ADMIN", metadata: { requestId, previousMobile: holder.mobile, movedTo: requester.id } },
      });
    }
    await tx.student.update({ where: { id: requester.id }, data: { mobile: mobile.e164, mobileVerifiedAt: new Date() } });
    await tx.studentActivity.create({
      data: {
        studentId: requester.id,
        activity: "MOBILE_VERIFIED",
        metadata: { method: "admin-approved-recovery", requestId, ...(requester.mobile && requester.mobile !== mobile.e164 ? { previousMobile: requester.mobile } : {}) },
      },
    });
    await tx.accountRecoveryRequest.update({
      where: { id: requestId },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedByAdminId: admin.id,
        reviewedByName: admin.name ?? null,
        adminNotes: notes,
        holderPreviousMobile: holder?.mobile ?? null,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: admin.id,
        action: "ACCOUNT_RECOVERY_APPROVED",
        entityType: "AccountRecoveryRequest",
        entityId: requestId,
        metadata: { requesterId: requester.id, holderId: holder?.id ?? null, effect: "mobile-moved" },
      },
    });
  });
}

export async function rejectRecoveryRequest(requestId: string, admin: { id: string; name: string | null | undefined }, rawNotes: string) {
  const notes = String(rawNotes ?? "").trim().slice(0, 1000) || null;
  const updated = await prisma.accountRecoveryRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "REJECTED", reviewedAt: new Date(), reviewedByAdminId: admin.id, reviewedByName: admin.name ?? null, adminNotes: notes },
  });
  if (updated.count !== 1) throw new AccountRecoveryError("This request is no longer pending.");
  await prisma.auditLog.create({
    data: { actorId: admin.id, action: "ACCOUNT_RECOVERY_REJECTED", entityType: "AccountRecoveryRequest", entityId: requestId, metadata: {} },
  });
}
