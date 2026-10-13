import "server-only";
import { EntitlementStatus, Prisma, type EmailTemplateKey } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getPaymentModeForStudent } from "@/lib/payments/settings";
import { isPurchasable, PRODUCT_SELECT } from "@/lib/payments/access";
import { computeProductPrice } from "@/lib/payments/pricing";
import { enqueueEmail } from "@/lib/email/queue";
import { formatIst, istStartOfDay, toIstDateString } from "@/lib/ist-time";
import { getPremiumPolicy, toPolicyRuntime, type PremiumPolicy, type ReminderKind } from "@/lib/premium-policy";

/**
 * One-time Premium Trial (Free Access & Trial policy, lib/premium-policy.ts).
 *
 * - Never starts by itself: only startPremiumTrial(), called from the
 *   student's explicit "Start 2-Day Free Trial" click, creates the row.
 * - One row per student, ever (unique studentId) → atomic + idempotent;
 *   one trial per verified mobile (unique mobile).
 * - The window is server time only: startedAt..endsAt. Logout, another
 *   browser or device never change it.
 * - Access itself is decided in lib/payments/access.ts (paid entitlements
 *   first, then the trial). This file owns state, popups, reminders and
 *   analytics.
 */

const HOUR = 3_600_000;
const ENDING_SOON_MS = 24 * HOUR;

export type TrialPhase =
  /** Enforcement OFF / FREE payment mode: no trial UI at all. */
  | "OFF"
  /** Active paid Premium: never any trial or upgrade prompt. */
  | "PAID"
  | "ELIGIBLE"
  | "INELIGIBLE"
  | "ACTIVE"
  | "ENDING"
  | "EXPIRED";

export type IneligibleReason = "TRIAL_OFF" | "MOBILE_NOT_VERIFIED" | "MOBILE_USED" | "ACCOUNT_INACTIVE";

export interface TrialStatus {
  phase: TrialPhase;
  trial: { startedAt: Date; endsAt: Date } | null;
  ineligibleReason: IneligibleReason | null;
  trialHours: number;
}

/** Active paid entitlement on any Premium product (the only thing that outranks the trial). */
export async function hasActivePremium(studentId: string, policy: PremiumPolicy, now: Date = new Date()): Promise<boolean> {
  if (policy.premiumProductIds.length === 0) return false;
  const n = await prisma.studentEntitlement.count({
    where: {
      studentId,
      productId: { in: policy.premiumProductIds },
      status: EntitlementStatus.ACTIVE,
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });
  return n > 0;
}

export async function getTrialStatus(studentId: string, now: Date = new Date()): Promise<TrialStatus> {
  const policy = await getPremiumPolicy();
  const off: TrialStatus = { phase: "OFF", trial: null, ineligibleReason: null, trialHours: policy.trialHours };
  if (!toPolicyRuntime(policy)) return off;
  if ((await getPaymentModeForStudent(studentId)) === "FREE") return off;
  if (await hasActivePremium(studentId, policy, now)) return { ...off, phase: "PAID" };

  const trial = await prisma.studentPremiumTrial.findUnique({ where: { studentId }, select: { startedAt: true, endsAt: true } });
  if (trial) {
    const left = trial.endsAt.getTime() - now.getTime();
    return { ...off, trial, phase: left <= 0 ? "EXPIRED" : left <= ENDING_SOON_MS ? "ENDING" : "ACTIVE" };
  }
  const reason = await ineligibility(studentId, policy);
  return reason ? { ...off, phase: "INELIGIBLE", ineligibleReason: reason } : { ...off, phase: "ELIGIBLE" };
}

async function ineligibility(studentId: string, policy: PremiumPolicy): Promise<IneligibleReason | null> {
  if (!policy.trialEnabled) return "TRIAL_OFF";
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { status: true, mobile: true, mobileVerifiedAt: true } });
  if (!student || student.status !== "ACTIVE") return "ACCOUNT_INACTIVE";
  const verifiedMobile = student.mobile && student.mobileVerifiedAt ? student.mobile : null;
  if (policy.requireVerifiedMobile && !verifiedMobile) return "MOBILE_NOT_VERIFIED";
  if (verifiedMobile && (await prisma.studentPremiumTrial.count({ where: { mobile: verifiedMobile, NOT: { studentId } } })) > 0) return "MOBILE_USED";
  return null;
}

export type StartTrialResult =
  | { ok: true; started: boolean; endsAt: Date }
  | { ok: false; reason: IneligibleReason | "PAID" | "OFF" | "ALREADY_USED"; message: string };

export const INELIGIBLE_MESSAGES: Record<IneligibleReason | "PAID" | "OFF" | "ALREADY_USED", string> = {
  TRIAL_OFF: "The free trial is not available right now.",
  OFF: "The free trial is not available right now.",
  MOBILE_NOT_VERIFIED: "Please verify your mobile number to start your free trial.",
  MOBILE_USED: "This mobile number has already used its free trial.",
  ACCOUNT_INACTIVE: "Your account can't start a trial right now.",
  PAID: "You already have Premium access.",
  ALREADY_USED: "Your one-time free trial has already been used.",
};

/**
 * The ONLY place a trial is created — from the student's explicit click.
 * Idempotent: a repeated or concurrent click returns the existing window
 * (started=false). The unique keys decide every race at the database.
 */
export async function startPremiumTrial(studentId: string, now: Date = new Date()): Promise<StartTrialResult> {
  const policy = await getPremiumPolicy();
  const status = await getTrialStatus(studentId, now);
  if (status.trial) {
    return status.phase === "EXPIRED"
      ? { ok: false, reason: "ALREADY_USED", message: INELIGIBLE_MESSAGES.ALREADY_USED }
      : { ok: true, started: false, endsAt: status.trial.endsAt };
  }
  if (status.phase === "OFF" || status.phase === "PAID") return { ok: false, reason: status.phase, message: INELIGIBLE_MESSAGES[status.phase] };
  if (status.phase === "INELIGIBLE") return { ok: false, reason: status.ineligibleReason!, message: INELIGIBLE_MESSAGES[status.ineligibleReason!] };

  const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId }, select: { mobile: true, mobileVerifiedAt: true } });
  const endsAt = new Date(now.getTime() + policy.trialHours * HOUR);
  // INSERT … ON CONFLICT DO NOTHING: the unique keys (student, mobile) decide every race without an error.
  const inserted = await prisma.studentPremiumTrial.createMany({
    data: [{ studentId, examId: policy.examId!, mobile: student.mobile && student.mobileVerifiedAt ? student.mobile : null, startedAt: now, endsAt }],
    skipDuplicates: true,
  });
  const trial = await prisma.studentPremiumTrial.findUnique({ where: { studentId }, select: { id: true, endsAt: true } });
  if (!trial) return { ok: false, reason: "MOBILE_USED", message: INELIGIBLE_MESSAGES.MOBILE_USED };
  if (inserted.count !== 1) return { ok: true, started: false, endsAt: trial.endsAt };
  await queueTrialReminder(studentId, trial.id, "started", trial.endsAt, policy).catch(() => undefined);
  return { ok: true, started: true, endsAt: trial.endsAt };
}

// ---------------------------------------------------------------------------
// Dashboard popup
// ---------------------------------------------------------------------------

export type PopupState = "WELCOME" | "ACTIVE" | "ENDING" | "EXPIRED";

export interface TrialPopupData {
  state: PopupState;
  endsAt: string | null;
  serverNow: string;
  trialHours: number;
  /** Premium checkout (existing verified flow), or the plans page when no Premium plan is on sale. */
  buyHref: string;
  priceLabel: string | null;
  free: string[];
  premium: string[];
}

const POPUP_SLOT = "POPUP";

function popupStateFor(phase: TrialPhase, policy: PremiumPolicy): PopupState | null {
  if (phase === "ELIGIBLE") return policy.popups.welcome ? "WELCOME" : null;
  if (phase === "ACTIVE") return policy.popups.activeDaily ? "ACTIVE" : null;
  if (phase === "ENDING") return policy.popups.activeDaily ? "ENDING" : null;
  if (phase === "EXPIRED") return policy.popups.expired ? "EXPIRED" : null;
  return null;
}

/**
 * The dashboard-entry popup, at most once per IST calendar day per student
 * (expired-trial prompts: at most every `expiredEveryDays`). The claim is a
 * unique-key insert, so refreshes, navigation, other tabs/devices and both
 * PM2 workers can never show it twice in a day. `force` (the student came
 * from a Premium lock) shows the current state without using up the slot.
 */
export async function claimTrialPopup(studentId: string, opts: { force?: boolean } = {}, now: Date = new Date()): Promise<TrialPopupData | null> {
  const policy = await getPremiumPolicy();
  const status = await getTrialStatus(studentId, now);
  const state = opts.force ? forcedState(status.phase) : popupStateFor(status.phase, policy);
  if (!state) return null;

  if (!opts.force) {
    const today = toIstDateString(now);
    if (state === "EXPIRED" && policy.popups.expiredEveryDays > 1) {
      const last = await prisma.studentTrialNotice.findFirst({ where: { studentId, kind: "POPUP_EXPIRED" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      if (last && istStartOfDay(now).getTime() - istStartOfDay(last.createdAt).getTime() < policy.popups.expiredEveryDays * 24 * HOUR) return null;
    }
    const claimed = await prisma.studentTrialNotice.createMany({ data: [{ studentId, kind: POPUP_SLOT, bucket: today }], skipDuplicates: true });
    if (claimed.count !== 1) return null;
    await prisma.studentTrialNotice.createMany({ data: [{ studentId, kind: `POPUP_${state}`, bucket: today }], skipDuplicates: true });
  }

  const [offer, labels] = await Promise.all([getPremiumOffer(policy, now), getFreeOfferingLabels(policy)]);
  return {
    state,
    endsAt: status.trial?.endsAt.toISOString() ?? null,
    serverNow: now.toISOString(),
    trialHours: policy.trialHours,
    buyHref: offer?.href ?? "/plans-and-pricing",
    priceLabel: offer?.priceLabel ?? null,
    free: labels,
    premium: ["All Previous Year Papers", "All Mock Tests", "All Subject Tests", "Custom Modules", "Premium Live CBT"],
  };
}

function forcedState(phase: TrialPhase): PopupState | null {
  if (phase === "ELIGIBLE") return "WELCOME";
  if (phase === "ACTIVE" || phase === "ENDING" || phase === "EXPIRED") return phase;
  return null;
}

/** The Premium plan to sell: first configured Premium product that is purchasable right now. */
export async function getPremiumOffer(policy: PremiumPolicy, now: Date = new Date()): Promise<{ code: string; href: string; priceLabel: string } | null> {
  if (policy.premiumProductIds.length === 0) return null;
  const products = await prisma.product.findMany({
    where: { id: { in: policy.premiumProductIds }, isActive: true },
    select: { ...PRODUCT_SELECT, mrpPaise: true, sellingPricePaise: true, saleEnabled: true, saleDiscountType: true, saleDiscountValue: true, saleStartAt: true, saleEndAt: true, currency: true },
  });
  const ordered = policy.premiumProductIds.map((id) => products.find((p) => p.id === id)).filter((p): p is (typeof products)[number] => Boolean(p));
  const p = ordered.find((x) => isPurchasable(x, now));
  if (!p) return null;
  const price = computeProductPrice(p, now);
  return { code: p.code, href: `/student/checkout/${encodeURIComponent(p.code)}`, priceLabel: `₹${(price.pricePaise / 100).toLocaleString("en-IN")}` };
}

/** Human labels for the free-forever offerings (titles from the DB; nothing invented). */
export async function getFreeOfferingLabels(policy: PremiumPolicy): Promise<string[]> {
  const mockIds = [policy.freeMockTestId, policy.freeSubjectMockTestId].filter((x): x is string => Boolean(x));
  const [paper, mocks] = await Promise.all([
    policy.freePyqId ? prisma.previousYearPaper.findUnique({ where: { id: policy.freePyqId }, select: { title: true } }) : null,
    mockIds.length ? prisma.mockTest.findMany({ where: { id: { in: mockIds } }, select: { id: true, title: true } }) : [],
  ]);
  const title = (id: string | null) => (id ? mocks.find((m) => m.id === id)?.title?.trim() : undefined);
  const out: string[] = [];
  if (paper) out.push(`PYQ: ${paper.title.trim()}`);
  const mock = title(policy.freeMockTestId);
  if (mock) out.push(`Mock Test: ${mock}`);
  const subject = title(policy.freeSubjectMockTestId);
  if (subject) out.push(`Subject Test: ${subject}`);
  out.push("Student Analytics & Performance Tracking", "Attempt History & Previous Results");
  return out;
}

// ---------------------------------------------------------------------------
// Reminders (scripts/trial-reminders.ts, every 5 minutes)
// ---------------------------------------------------------------------------

const REMINDER_TEMPLATE: Record<ReminderKind, EmailTemplateKey> = {
  started: "TRIAL_STARTED",
  h24: "TRIAL_ENDS_24H",
  h6: "TRIAL_ENDS_6H",
  h1: "TRIAL_ENDS_1H",
  expired: "TRIAL_EXPIRED",
};
/** Countdown reminders, largest first: [kind, hours before endsAt]. */
const COUNTDOWN: [ReminderKind, number][] = [
  ["h24", 24],
  ["h6", 6],
  ["h1", 1],
];
/** An "ended" reminder is only worth sending soon after the end. */
const EXPIRED_REMINDER_WINDOW_MS = 12 * HOUR;

/**
 * Records + queues one reminder exactly once (ledger key student+kind+trial,
 * email idempotency key trial:kind:trialId). Disabled kinds are still
 * recorded (without an email) so re-enabling never sends stale reminders.
 */
async function queueTrialReminder(studentId: string, trialId: string, kind: ReminderKind, endsAt: Date, policy: PremiumPolicy): Promise<boolean> {
  const claimed = await prisma.studentTrialNotice.createMany({ data: [{ studentId, kind: `REMINDER_${kind}`, bucket: trialId }], skipDuplicates: true });
  if (claimed.count !== 1 || !policy.reminders[kind]) return false;
  return enqueueEmail({
    idempotencyKey: `trial:${kind}:${trialId}`,
    templateKey: REMINDER_TEMPLATE[kind],
    studentId,
    variables: { trialEndsAt: formatIst(endsAt) },
  });
}

export interface ReminderRunResult {
  skipped: string | null;
  checked: number;
  queued: number;
  paidSkipped: number;
}

/**
 * Idempotent reminder sweep. Paid subscribers never get one. When the job
 * was late and several thresholds have passed, only the nearest is sent
 * (the larger ones are recorded silently) — no reminder floods.
 */
export async function runTrialReminders(now: Date = new Date()): Promise<ReminderRunResult> {
  const policy = await getPremiumPolicy();
  if (!toPolicyRuntime(policy)) return { skipped: "Premium Access Enforcement is OFF", checked: 0, queued: 0, paidSkipped: 0 };

  const trials = await prisma.studentPremiumTrial.findMany({
    where: { endsAt: { gt: new Date(now.getTime() - EXPIRED_REMINDER_WINDOW_MS) } },
    select: { id: true, studentId: true, startedAt: true, endsAt: true },
  });
  let queued = 0;
  let paidSkipped = 0;
  for (const t of trials) {
    if (await hasActivePremium(t.studentId, policy, now)) {
      paidSkipped++;
      continue;
    }
    const left = t.endsAt.getTime() - now.getTime();
    if (left <= 0) {
      if (await queueTrialReminder(t.studentId, t.id, "expired", t.endsAt, policy)) queued++;
      continue;
    }
    if (await queueTrialReminder(t.studentId, t.id, "started", t.endsAt, policy)) queued++;
    const total = t.endsAt.getTime() - t.startedAt.getTime();
    // Thresholds already passed (and meaningful for this trial's length); send the nearest only.
    const due = COUNTDOWN.filter(([, h]) => left <= h * HOUR && total > h * HOUR);
    for (let i = 0; i < due.length; i++) {
      const [kind] = due[i];
      const isNearest = i === due.length - 1;
      if (isNearest) {
        if (await queueTrialReminder(t.studentId, t.id, kind, t.endsAt, policy)) queued++;
      } else {
        await prisma.studentTrialNotice.createMany({ data: [{ studentId: t.studentId, kind: `REMINDER_${kind}`, bucket: t.id }], skipDuplicates: true });
      }
    }
  }
  return { skipped: null, checked: trials.length, queued, paidSkipped };
}

// ---------------------------------------------------------------------------
// Admin analytics (real rows only)
// ---------------------------------------------------------------------------

export interface TrialAnalytics {
  eligibleStudents: number;
  trialsStarted: number;
  activeTrials: number;
  expiringToday: number;
  expiredTrials: number;
  conversions: number;
  activePremium: number;
  /** Verified LIVE captured payments (net of refunds) on Premium orders paid after the student's trial started. */
  conversionRevenuePaise: number;
}

export async function getTrialAnalytics(now: Date = new Date()): Promise<TrialAnalytics> {
  const policy = await getPremiumPolicy();
  const premiumIds = policy.premiumProductIds;
  const endOfToday = new Date(istStartOfDay(now).getTime() + 24 * HOUR);
  const activePremiumWhere = {
    productId: { in: premiumIds },
    status: EntitlementStatus.ACTIVE,
    startsAt: { lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
  };

  const [trialsStarted, activeTrials, expiringToday, expiredTrials, activePremiumRows, eligibleStudents, conv] = await Promise.all([
    prisma.studentPremiumTrial.count(),
    prisma.studentPremiumTrial.count({ where: { endsAt: { gt: now } } }),
    prisma.studentPremiumTrial.count({ where: { endsAt: { gt: now, lte: endOfToday } } }),
    prisma.studentPremiumTrial.count({ where: { endsAt: { lte: now } } }),
    premiumIds.length ? prisma.studentEntitlement.findMany({ where: activePremiumWhere, select: { studentId: true }, distinct: ["studentId"] }) : [],
    prisma.student.count({
      where: {
        status: "ACTIVE",
        premiumTrial: null,
        ...(policy.requireVerifiedMobile ? { mobileVerifiedAt: { not: null } } : {}),
        ...(premiumIds.length ? { entitlements: { none: activePremiumWhere } } : {}),
      },
    }),
    premiumIds.length
      ? prisma.$queryRaw<{ students: bigint; revenue: bigint | null }[]>`
          SELECT COUNT(DISTINCT o."studentId") AS students,
                 COALESCE(SUM(p."amountPaise" - p."refundedPaise"), 0) AS revenue
          FROM "PaymentOrder" o
          JOIN "StudentPremiumTrial" t ON t."studentId" = o."studentId"
          JOIN "Payment" p ON p."orderId" = o.id AND p.status IN ('CAPTURED', 'PARTIALLY_REFUNDED') AND p.environment = 'LIVE'
          WHERE o."productId" IN (${Prisma.join(premiumIds)})
            AND o.environment = 'LIVE'
            AND o.status IN ('PAID', 'PARTIALLY_REFUNDED')
            AND o."paidAt" >= t."startedAt"`
      : [{ students: BigInt(0), revenue: BigInt(0) }],
  ]);
  return {
    eligibleStudents,
    trialsStarted,
    activeTrials,
    expiringToday,
    expiredTrials,
    conversions: Number(conv[0]?.students ?? 0),
    activePremium: activePremiumRows.length,
    conversionRevenuePaise: Number(conv[0]?.revenue ?? 0),
  };
}
