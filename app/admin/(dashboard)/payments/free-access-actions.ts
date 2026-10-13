"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, UnauthorizedError } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { logPaymentAudit } from "@/lib/payments/audit";
import { revalidateMockSeriesSurfaces } from "@/lib/mock-series-revalidate";
import {
  GRACE_MINUTES_MAX,
  getPremiumPolicy,
  REMINDER_KINDS,
  savePremiumPolicy,
  TRIAL_HOURS_MAX,
  TRIAL_HOURS_MIN,
  type PremiumPolicy,
} from "@/lib/premium-policy";
import { enforcementBlockers, extendTillExamAccess, PolicyValidationError, validatePremiumPolicy } from "@/lib/premium-admin";
import type { FormState } from "./actions";

/**
 * Admin → Payments → Free Access & Trial. Every mutation requires
 * PAYMENTS_MANAGE (MASTER_ADMIN only) and is audit-logged with before/after.
 * Nothing here touches tests, attempts, results, products or payments —
 * except the explicit "extend Till Exam access" action, which only ever
 * moves ACTIVE entitlement expiries later.
 */

async function manage() {
  return requirePermission(PERMISSIONS.PAYMENTS_MANAGE);
}

function fail(e: unknown): FormState {
  if (e instanceof UnauthorizedError) return { error: "Forbidden — only Master Admin can change payment settings." };
  if (e instanceof PolicyValidationError) return { error: e.message };
  return { error: "Something went wrong. Nothing was changed." };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const optId = (fd: FormData, k: string) => str(fd, k).slice(0, 64) || null;
const ids = (fd: FormData, k: string) => [...new Set(fd.getAll(k).map((v) => String(v).trim().slice(0, 64)).filter(Boolean))].slice(0, 20);
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
function int(fd: FormData, k: string, label: string, min: number, max: number): number {
  const n = Number(str(fd, k));
  if (!Number.isInteger(n) || n < min || n > max) throw new PolicyValidationError(`${label} must be a whole number between ${min} and ${max}.`);
  return n;
}

function revalidateAccessSurfaces() {
  revalidatePath("/admin/payments", "layout");
  revalidatePath("/plans-and-pricing");
  revalidatePath("/student", "layout");
  revalidateMockSeriesSurfaces();
}

/** Everything except the enforcement switch (that has its own confirmed action). */
export async function savePremiumPolicyAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const before = await getPremiumPolicy();
    const examDate = str(fd, "examDate");
    if (examDate && !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) throw new PolicyValidationError("Exam date must be a date.");
    const next: PremiumPolicy = {
      ...before,
      examId: optId(fd, "examId"),
      premiumProductIds: ids(fd, "premiumProductIds"),
      freePyqId: optId(fd, "freePyqId"),
      freeMockTestId: optId(fd, "freeMockTestId"),
      freeSubjectMockTestId: optId(fd, "freeSubjectMockTestId"),
      freeLiveCbtMockTestIds: ids(fd, "freeLiveCbtMockTestIds"),
      trialEnabled: bool(fd, "trialEnabled"),
      trialHours: int(fd, "trialHours", "Trial duration (hours)", TRIAL_HOURS_MIN, TRIAL_HOURS_MAX),
      requireVerifiedMobile: bool(fd, "requireVerifiedMobile"),
      attemptGraceMinutes: int(fd, "attemptGraceMinutes", "Grace for untimed attempts (minutes)", 0, GRACE_MINUTES_MAX),
      popups: {
        welcome: bool(fd, "popupWelcome"),
        activeDaily: bool(fd, "popupActiveDaily"),
        expired: bool(fd, "popupExpired"),
        expiredEveryDays: int(fd, "expiredEveryDays", "Expired-trial popup frequency (days)", 1, 30),
      },
      reminders: Object.fromEntries(REMINDER_KINDS.map((k) => [k, bool(fd, `reminder_${k}`)])) as PremiumPolicy["reminders"],
      examDate: examDate || null,
      tillExamProductIds: ids(fd, "tillExamProductIds"),
    };
    await validatePremiumPolicy(next);
    if (before.enforcementEnabled && enforcementBlockers(next).length)
      throw new PolicyValidationError(`Enforcement is ON, so this would leave the policy incomplete: ${enforcementBlockers(next).join(" ")}`);
    const saved = await savePremiumPolicy(next, session.user.id);
    await logPaymentAudit(session.user.id, "PREMIUM_POLICY_UPDATED", "PaymentSettings", "access.premium_policy", { before, after: saved });
    revalidateAccessSurfaces();
    return { success: "Free Access & Trial settings saved." };
  } catch (e) {
    return fail(e);
  }
}

/** Premium Access Enforcement ON/OFF — effective immediately (both workers within ~5s). Typed confirmation required. */
export async function setPremiumEnforcementAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    const enable = str(fd, "enforcement") === "ON";
    const confirm = str(fd, "confirm").toUpperCase();
    if (confirm !== (enable ? "ENABLE" : "DISABLE")) return { error: `Type ${enable ? "ENABLE" : "DISABLE"} to confirm.` };
    const before = await getPremiumPolicy();
    if (enable) {
      const blockers = enforcementBlockers(before);
      if (blockers.length) return { error: `Not ready: ${blockers.join(" ")}` };
      await validatePremiumPolicy(before);
    }
    if (before.enforcementEnabled === enable) return { success: `Premium Access Enforcement is already ${enable ? "ON" : "OFF"}.` };
    const saved = await savePremiumPolicy(
      { ...before, enforcementEnabled: enable, enforcedSince: enable ? new Date().toISOString() : before.enforcedSince },
      session.user.id
    );
    await logPaymentAudit(session.user.id, "PREMIUM_ENFORCEMENT_CHANGED", "PaymentSettings", "access.premium_policy", {
      before: { enforcementEnabled: before.enforcementEnabled, enforcedSince: before.enforcedSince },
      after: { enforcementEnabled: saved.enforcementEnabled, enforcedSince: saved.enforcedSince },
    });
    revalidateAccessSurfaces();
    return {
      success: enable
        ? "Premium Access Enforcement is ON. The new access policy applies from now on."
        : "Premium Access Enforcement is OFF. The previous access rules apply again.",
    };
  } catch (e) {
    return fail(e);
  }
}

/** Exam postponed: move ACTIVE "Till Exam" expiries up to the end of the configured exam day. Typed confirmation required. */
export async function extendTillExamAccessAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const session = await manage();
    if (str(fd, "confirm").toUpperCase() !== "EXTEND") return { error: "Type EXTEND to confirm." };
    const policy = await getPremiumPolicy();
    const result = await extendTillExamAccess(policy, { apply: true });
    if (!result.target) return { error: "Set the exam date and the “Till Exam” plans first." };
    await logPaymentAudit(session.user.id, "TILL_EXAM_ACCESS_EXTENDED", "StudentEntitlement", null, {
      examDate: policy.examDate,
      newExpiresAt: result.target.toISOString(),
      count: result.count,
      entitlementIds: result.ids,
    });
    revalidateAccessSurfaces();
    return { success: result.count ? `Extended ${result.count} active subscription(s) to the end of ${policy.examDate} (IST).` : "No active subscription needed an extension." };
  } catch (e) {
    return fail(e);
  }
}
