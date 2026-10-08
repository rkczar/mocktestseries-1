import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { deriveAvailabilityMode, deriveMockTestAvailability } from "@/lib/mock-test-schedule";

/**
 * Safe permanent deletion of admin-created test definitions (Mock Test —
 * which also covers Subject / Scheduled / Fixed Window / Live CBT — and
 * admin Custom Modules).
 *
 * Policy: a test is deleted only when nothing but its own configuration
 * points at it. Several references are ON DELETE SET NULL in the database
 * (TestAttempt, Product, Announcement, TestResource), so a plain delete would
 * silently detach student attempts, payment products or Paper PDFs — every
 * one of those is therefore a BLOCKER, never something we clean up. What a
 * delete may remove is only what the test exclusively owns: its question
 * links (MockTestQuestion / CustomModuleQuestion — the Question rows
 * themselves are never touched) and its TestRankingConfig. BulkImportRun
 * history keeps its row (mockTestId → NULL).
 *
 * Race safety: the delete runs in one transaction that first takes
 * SELECT … FOR UPDATE on the test row. Any concurrent INSERT that references
 * the test (attempt start, enrollment, product) needs a KEY SHARE lock on the
 * same row, so it either committed before the lock (and the in-transaction
 * recheck sees it) or waits and then fails its FK check once the row is gone.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export interface TestDeleteCheck {
  kind: "mock" | "custom";
  id: string;
  title: string;
  typeLabel: string;
  status: string;
  questions: number;
  attempts: number;
  /** Live CBT enrollments (Mock Tests only; null for Custom Modules). */
  enrollments: number | null;
  /** Human-readable reasons permanent deletion is refused; empty = deletable. */
  reasons: string[];
  canDelete: boolean;
  /** Archive (hide from students, keep all history) is offered instead. */
  canArchive: boolean;
}

export type TestDeleteResult = { ok: true; title: string } | { ok: false; reason: string; check?: TestDeleteCheck };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function mockTestTypeLabel(m: {
  coverageType: string;
  enrollmentEnabled: boolean;
  availableFrom: Date | null;
  availableUntil: Date | null;
}): string {
  const mode = deriveAvailabilityMode(m);
  if (mode === "FIXED_WINDOW") return m.enrollmentEnabled ? "Live CBT (Fixed Window Mock Test)" : "Fixed Window Mock Test";
  const base = m.coverageType === "SUBJECT_WISE" ? "Subject Mock Test" : "Mock Test";
  return mode === "SCHEDULED_RELEASE" ? `${base} · Scheduled Release` : base;
}

export async function checkMockTestDeletion(db: Db, mockTestId: string, now: Date = new Date()): Promise<TestDeleteCheck | null> {
  const m = await db.mockTest.findUnique({
    where: { id: mockTestId },
    select: {
      id: true,
      title: true,
      status: true,
      coverageType: true,
      enrollmentEnabled: true,
      availableFrom: true,
      availableUntil: true,
      _count: { select: { questions: true, testAttempts: true, enrollments: true, products: true, announcements: true, resources: true } },
    },
  });
  if (!m) return null;

  const c = m._count;
  // Payment dependencies reach a test only through a Product row naming it;
  // count the orders/entitlements behind those products for the message.
  const [orders, entitlements] =
    c.products > 0
      ? await Promise.all([
          db.paymentOrder.count({ where: { product: { mockTestId } } }),
          db.studentEntitlement.count({ where: { product: { mockTestId } } }),
        ])
      : [0, 0];
  const liveNow = m.status === "PUBLISHED" && deriveMockTestAvailability(m, now) === "LIVE_NOW";

  const reasons: string[] = [];
  if (liveNow) reasons.push("This Live CBT / Fixed Window test is running right now.");
  if (c.testAttempts > 0) reasons.push(`${plural(c.testAttempts, "student attempt")} recorded — results and attempt history must be kept.`);
  if (c.enrollments > 0) reasons.push(`${plural(c.enrollments, "student enrollment")} for this Live CBT.`);
  if (c.products > 0) {
    reasons.push(
      `Linked to ${plural(c.products, "payment product")}` +
        (orders + entitlements > 0 ? ` (${plural(orders, "order")}, ${plural(entitlements, "entitlement")})` : "") +
        " — remove the test from Payments → Products first."
    );
  }
  if (c.announcements > 0) reasons.push(`Referenced by ${plural(c.announcements, "announcement")} — unlink or archive them first.`);
  if (c.resources > 0) reasons.push(`Has ${plural(c.resources, "test resource")} (Paper / Solution PDF or OMR) — remove them first.`);

  return {
    kind: "mock",
    id: m.id,
    title: m.title,
    typeLabel: mockTestTypeLabel(m),
    status: m.status,
    questions: c.questions,
    attempts: c.testAttempts,
    enrollments: c.enrollments,
    reasons,
    canDelete: reasons.length === 0,
    // Archiving a test mid-window would cut off candidates who are sitting it.
    canArchive: reasons.length > 0 && !liveNow && m.status !== "ARCHIVED",
  };
}

export async function checkCustomModuleDeletion(db: Db, moduleId: string): Promise<TestDeleteCheck | null> {
  const m = await db.customModule.findUnique({
    where: { id: moduleId },
    select: { id: true, title: true, status: true, isStudentOwned: true, _count: { select: { questions: true, testAttempts: true } } },
  });
  if (!m) return null;
  // ReportedQuestion.customModuleId is a plain column (no FK) — check it explicitly.
  const reports = await db.reportedQuestion.count({ where: { customModuleId: moduleId } });

  const reasons: string[] = [];
  if (m.isStudentOwned) reasons.push("This module was built by a student and belongs to their account.");
  if (m._count.testAttempts > 0) reasons.push(`${plural(m._count.testAttempts, "student attempt")} recorded — results and attempt history must be kept.`);
  if (reports > 0) reasons.push(`${plural(reports, "question report")} filed from this module.`);

  return {
    kind: "custom",
    id: m.id,
    title: m.title,
    typeLabel: m.isStudentOwned ? "Custom Module (student-built)" : "Custom Module",
    status: m.status,
    questions: m._count.questions,
    attempts: m._count.testAttempts,
    enrollments: null,
    reasons,
    canDelete: reasons.length === 0,
    canArchive: reasons.length > 0 && !m.isStudentOwned && m.status !== "ARCHIVED",
  };
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export async function deleteMockTestSafely(db: PrismaClient, mockTestId: string): Promise<TestDeleteResult> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "MockTest" WHERE id = ${mockTestId} FOR UPDATE`;
    if (locked.length === 0) return { ok: false, reason: "This test no longer exists — it may already have been deleted." };
    const check = await checkMockTestDeletion(tx, mockTestId);
    if (!check) return { ok: false, reason: "This test no longer exists — it may already have been deleted." };
    if (!check.canDelete) return { ok: false, reason: check.reasons.join(" "), check };
    // Cascades only to MockTestQuestion links and TestRankingConfig; every
    // SET NULL reference was verified empty above (except BulkImportRun history).
    await tx.mockTest.delete({ where: { id: mockTestId } });
    return { ok: true, title: check.title };
  }, TX_OPTIONS);
}

export async function deleteCustomModuleSafely(db: PrismaClient, moduleId: string): Promise<TestDeleteResult> {
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "CustomModule" WHERE id = ${moduleId} FOR UPDATE`;
    if (locked.length === 0) return { ok: false, reason: "This module no longer exists — it may already have been deleted." };
    const check = await checkCustomModuleDeletion(tx, moduleId);
    if (!check) return { ok: false, reason: "This module no longer exists — it may already have been deleted." };
    if (!check.canDelete) return { ok: false, reason: check.reasons.join(" "), check };
    // Cascades only to CustomModuleQuestion links; Question rows are untouched.
    await tx.customModule.delete({ where: { id: moduleId } });
    return { ok: true, title: check.title };
  }, TX_OPTIONS);
}
