import "server-only";
import { EntitlementStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { examDayEnd, isPolicyComplete, type PremiumPolicy } from "@/lib/premium-policy";

/**
 * Admin-side rules for Free Access & Trial (Admin → Payments). Kept out of
 * the Server Action file so the same checks are unit-testable with tsx.
 */

export class PolicyValidationError extends Error {}

/** Every id in the policy must point at real content of the policy exam — nothing is trusted from the form. */
export async function validatePremiumPolicy(p: PremiumPolicy): Promise<void> {
  if (!p.examId) {
    if (p.premiumProductIds.length || p.freePyqId || p.freeMockTestId || p.freeSubjectMockTestId || p.freeLiveCbtMockTestIds.length)
      throw new PolicyValidationError("Choose the exam first.");
    return;
  }
  const exam = await prisma.exam.findUnique({ where: { id: p.examId }, select: { id: true } });
  if (!exam) throw new PolicyValidationError("The selected exam does not exist.");

  if (p.premiumProductIds.length) {
    const products = await prisma.product.findMany({ where: { id: { in: p.premiumProductIds } }, select: { id: true, examId: true, accessType: true } });
    if (products.length !== p.premiumProductIds.length) throw new PolicyValidationError("A selected Premium product no longer exists.");
    if (products.some((x) => x.accessType !== "PAID" || x.examId !== p.examId))
      throw new PolicyValidationError("Premium products must be PAID products of the selected exam.");
  }
  if (p.tillExamProductIds.some((id) => !p.premiumProductIds.includes(id))) throw new PolicyValidationError("“Till Exam” plans must also be Premium products.");
  if (p.tillExamProductIds.length && !p.examDate) throw new PolicyValidationError("Set the Premium plan exam date before marking plans “Till Exam”.");

  if (p.freePyqId) {
    const paper = await prisma.previousYearPaper.findUnique({ where: { id: p.freePyqId }, select: { examId: true } });
    if (!paper || paper.examId !== p.examId) throw new PolicyValidationError("The free PYQ must be a paper of the selected exam.");
  }
  const mockIds = [p.freeMockTestId, p.freeSubjectMockTestId, ...p.freeLiveCbtMockTestIds].filter((x): x is string => Boolean(x));
  if (mockIds.length) {
    // Live CBT exceptions may be any test of the exam: a past Live CBT can have its enrollment switched off.
    const mocks = await prisma.mockTest.findMany({ where: { id: { in: mockIds } }, select: { id: true, examId: true } });
    if (mocks.length !== new Set(mockIds).size || mocks.some((m) => m.examId !== p.examId))
      throw new PolicyValidationError("Free tests must be Mock Tests of the selected exam.");
  }
}

/** What must be true before enforcement may be switched ON. Empty = ready. */
export function enforcementBlockers(p: PremiumPolicy): string[] {
  const out: string[] = [];
  if (!isPolicyComplete(p)) out.push("Choose the exam and at least one Premium product.");
  if (!p.freePyqId) out.push("Select the free PYQ.");
  if (!p.freeMockTestId) out.push("Select the free Mock Test.");
  if (!p.freeSubjectMockTestId) out.push("Select the free Subject Mock Test.");
  return out;
}

/**
 * Exam postponed → extend "Till Exam" access. Only ACTIVE (not revoked, not
 * yet expired) entitlements on the Till-Exam plans whose expiry is before the
 * end of the configured exam day are moved TO that instant. Never shortens,
 * never revives an expired or revoked entitlement, never touches other
 * products. Dry-run unless `apply`.
 */
export async function extendTillExamAccess(p: PremiumPolicy, opts: { apply: boolean; now?: Date }) {
  const target = examDayEnd(p.examDate);
  if (!target || p.tillExamProductIds.length === 0) return { target: null, count: 0, ids: [] as string[] };
  const now = opts.now ?? new Date();
  const where = {
    productId: { in: p.tillExamProductIds },
    status: EntitlementStatus.ACTIVE,
    expiresAt: { gt: now, lt: target },
  };
  const rows = await prisma.studentEntitlement.findMany({ where, select: { id: true } });
  if (opts.apply && rows.length) {
    await prisma.studentEntitlement.updateMany({ where: { id: { in: rows.map((r) => r.id) }, ...where }, data: { expiresAt: target } });
  }
  return { target, count: rows.length, ids: rows.map((r) => r.id) };
}
