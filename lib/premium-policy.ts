import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Free Access & Trial policy — Admin → Payments → Free Access & Trial,
 * stored in the existing `Setting` table under `access.premium_policy` so it
 * changes without a deploy. No row = enforcement OFF = today's access rules
 * exactly (lib/payments/access.ts falls through to the legacy product rules).
 *
 * When enforcement is ON (and the policy is complete: an exam and at least
 * one Premium product), content of the policy exam is decided ONLY by:
 *   1. the admin-selected free offerings (one PYQ, one Mock Test, one fixed
 *      Subject Mock Test, optional free Live CBT tests) → open to every
 *      signed-in student;
 *   2. an active paid entitlement on a Premium product (it unlocks every
 *      test of the exam) or on a product that covers the item itself (e.g.
 *      an individual Mock Test purchase);
 *   3. an active one-time Premium Trial (lib/premium-trial.ts).
 * Everything else is locked. Legacy per-test FREE flags and FREE products
 * are ignored for that exam while enforcement is ON — switching it OFF
 * restores them untouched (nothing here writes to tests or products).
 */

export const PREMIUM_POLICY_KEY = "access.premium_policy";
const CACHE_TTL_MS = 5_000;

export type ReminderKind = "started" | "h24" | "h6" | "h1" | "expired";
export const REMINDER_KINDS: ReminderKind[] = ["started", "h24", "h6", "h1", "expired"];

export interface PremiumPolicy {
  enforcementEnabled: boolean;
  /** ISO instant enforcement was last switched ON. Attempts started earlier may finish (grace rules). */
  enforcedSince: string | null;
  examId: string | null;
  /** Products whose active entitlement counts as Premium (unlocks every test of the exam). */
  premiumProductIds: string[];
  freePyqId: string | null;
  freeMockTestId: string | null;
  freeSubjectMockTestId: string | null;
  /** Extra Live CBT tests (enrollment-enabled mocks) that stay free; every other Live CBT is Premium. */
  freeLiveCbtMockTestIds: string[];
  trialEnabled: boolean;
  trialHours: number;
  /** Only students with a verified mobile may start a trial (one trial per number). */
  requireVerifiedMobile: boolean;
  /** Untimed attempts started before a cut-off (trial end / enforcement start) may continue this long after it. */
  attemptGraceMinutes: number;
  popups: { welcome: boolean; activeDaily: boolean; expired: boolean; expiredEveryDays: number };
  reminders: Record<ReminderKind, boolean>;
  /** "YYYY-MM-DD" (IST). Premium plans listed in tillExamProductIds run until the end of this day. Null = not configured. */
  examDate: string | null;
  tillExamProductIds: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_PREMIUM_POLICY: PremiumPolicy = {
  enforcementEnabled: false,
  enforcedSince: null,
  examId: null,
  premiumProductIds: [],
  freePyqId: null,
  freeMockTestId: null,
  freeSubjectMockTestId: null,
  freeLiveCbtMockTestIds: [],
  trialEnabled: false,
  trialHours: 48,
  requireVerifiedMobile: true,
  attemptGraceMinutes: 60,
  popups: { welcome: true, activeDaily: true, expired: true, expiredEveryDays: 1 },
  reminders: { started: true, h24: true, h6: true, h1: true, expired: true },
  examDate: null,
  tillExamProductIds: [],
  updatedAt: null,
  updatedBy: null,
};

export const TRIAL_HOURS_MIN = 1;
export const TRIAL_HOURS_MAX = 168;
export const GRACE_MINUTES_MAX = 24 * 60;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : null);
const strList = (v: unknown, max = 20) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().slice(0, 64)))].slice(0, max) : [];
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const int = (v: unknown, d: number, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d;

/** Tolerant parse: any missing/invalid field falls back to its default, so a bad row can never crash access checks. */
export function parsePremiumPolicy(raw: unknown): PremiumPolicy {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PREMIUM_POLICY;
  const popups = (r.popups && typeof r.popups === "object" ? r.popups : {}) as Record<string, unknown>;
  const reminders = (r.reminders && typeof r.reminders === "object" ? r.reminders : {}) as Record<string, unknown>;
  const enforcedSince = strOrNull(r.enforcedSince);
  const examDate = typeof r.examDate === "string" && DATE_RE.test(r.examDate) ? r.examDate : null;
  return {
    enforcementEnabled: r.enforcementEnabled === true,
    enforcedSince: enforcedSince && !Number.isNaN(Date.parse(enforcedSince)) ? enforcedSince : null,
    examId: strOrNull(r.examId),
    premiumProductIds: strList(r.premiumProductIds),
    freePyqId: strOrNull(r.freePyqId),
    freeMockTestId: strOrNull(r.freeMockTestId),
    freeSubjectMockTestId: strOrNull(r.freeSubjectMockTestId),
    freeLiveCbtMockTestIds: strList(r.freeLiveCbtMockTestIds),
    trialEnabled: r.trialEnabled === true,
    trialHours: int(r.trialHours, d.trialHours, TRIAL_HOURS_MIN, TRIAL_HOURS_MAX),
    requireVerifiedMobile: bool(r.requireVerifiedMobile, d.requireVerifiedMobile),
    attemptGraceMinutes: int(r.attemptGraceMinutes, d.attemptGraceMinutes, 0, GRACE_MINUTES_MAX),
    popups: {
      welcome: bool(popups.welcome, d.popups.welcome),
      activeDaily: bool(popups.activeDaily, d.popups.activeDaily),
      expired: bool(popups.expired, d.popups.expired),
      expiredEveryDays: int(popups.expiredEveryDays, d.popups.expiredEveryDays, 1, 30),
    },
    reminders: Object.fromEntries(REMINDER_KINDS.map((k) => [k, bool(reminders[k], d.reminders[k])])) as Record<ReminderKind, boolean>,
    examDate,
    tillExamProductIds: strList(r.tillExamProductIds),
    updatedAt: strOrNull(r.updatedAt),
    updatedBy: strOrNull(r.updatedBy),
  };
}

/** The slice of the policy the access engine needs, with the "is it really in force" decision made once. */
export interface PremiumPolicyRuntime {
  active: boolean;
  examId: string;
  premiumProductIds: ReadonlySet<string>;
  freePyqId: string | null;
  freeMockTestIds: ReadonlySet<string>;
  enforcedSince: Date | null;
  attemptGraceMinutes: number;
  trialEnabled: boolean;
}

/** Enforcement is in force only when switched ON AND complete — a half-configured policy never locks anything. */
export function isPolicyComplete(p: PremiumPolicy): boolean {
  return Boolean(p.examId) && p.premiumProductIds.length > 0;
}

export function toPolicyRuntime(p: PremiumPolicy): PremiumPolicyRuntime | null {
  if (!p.enforcementEnabled || !isPolicyComplete(p)) return null;
  const free = [p.freeMockTestId, p.freeSubjectMockTestId, ...p.freeLiveCbtMockTestIds].filter((x): x is string => Boolean(x));
  return {
    active: true,
    examId: p.examId!,
    premiumProductIds: new Set(p.premiumProductIds),
    freePyqId: p.freePyqId,
    freeMockTestIds: new Set(free),
    enforcedSince: p.enforcedSince ? new Date(p.enforcedSince) : null,
    attemptGraceMinutes: p.attemptGraceMinutes,
    trialEnabled: p.trialEnabled,
  };
}

let cache: { at: number; value: PremiumPolicy } | null = null;

export function bumpPremiumPolicyCache() {
  cache = null;
}

/** Cached 5s per worker, like payments.mode — both PM2 workers converge within that window after a change. */
export async function getPremiumPolicy(): Promise<PremiumPolicy> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: PREMIUM_POLICY_KEY } });
  const value = parsePremiumPolicy(row?.value ?? null);
  cache = { at: Date.now(), value };
  return value;
}

export async function getPremiumPolicyRuntime(): Promise<PremiumPolicyRuntime | null> {
  return toPolicyRuntime(await getPremiumPolicy());
}

export async function savePremiumPolicy(next: PremiumPolicy, actorId: string | undefined): Promise<PremiumPolicy> {
  const value = { ...next, updatedAt: new Date().toISOString(), updatedBy: actorId ?? null };
  const json = JSON.parse(JSON.stringify(value)) as object;
  await prisma.setting.upsert({ where: { key: PREMIUM_POLICY_KEY }, update: { value: json }, create: { key: PREMIUM_POLICY_KEY, value: json } });
  bumpPremiumPolicyCache();
  return value;
}

/**
 * End of the configured exam day in IST (23:59:59.999 IST) as a UTC instant,
 * or null when no exam date is configured. "Till Exam" access runs until
 * this instant — the whole exam day is included.
 */
export function examDayEnd(examDate: string | null): Date | null {
  if (!examDate || !DATE_RE.test(examDate)) return null;
  const d = new Date(`${examDate}T23:59:59.999+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Is `productId` sold as "Till Exam" right now (listed AND an exam date is configured)? */
export function isTillExamProduct(policy: PremiumPolicy, productId: string): boolean {
  return policy.tillExamProductIds.includes(productId) && examDayEnd(policy.examDate) !== null;
}

export const TILL_EXAM_LABEL = "Till Exam";
export const TILL_EXAM_SUPPORT_TEXT = "Full Premium Access Until RUHS MO 2026 Exam";
