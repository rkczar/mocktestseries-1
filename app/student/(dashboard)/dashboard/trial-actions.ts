"use server";

import { revalidatePath } from "next/cache";
import { requireStudentOrLogin } from "@/lib/student-session";
import { claimTrialPopup, getTrialStatus, startPremiumTrial, type TrialPopupData } from "@/lib/premium-trial";
import { PLANS_AND_PRICING_PATH } from "@/lib/plans-path";

/**
 * Dashboard-entry popup. Called once on mount: the server decides the state
 * and claims today's slot (lib/premium-trial.ts#claimTrialPopup), so a
 * refresh or another tab gets null. `force` = the student arrived from a
 * Premium lock (?premium=locked) and should see their options right away.
 */
export async function claimTrialPopupAction(force: boolean): Promise<TrialPopupData | { redirect: string } | null> {
  const student = await requireStudentOrLogin();
  try {
    const data = await claimTrialPopup(student.id, { force });
    // Arrived from a Premium lock but no trial can be offered (e.g. the mobile
    // already used one): send them to the plans rather than leave the Unlock
    // click doing nothing. Paid / enforcement-OFF students stay put.
    if (!data && force && (await getTrialStatus(student.id)).phase === "INELIGIBLE") return { redirect: PLANS_AND_PRICING_PATH };
    return data;
  } catch (error) {
    // The popup is optional: never let it break the dashboard.
    console.error("[trial] popup claim failed", error instanceof Error ? error.name : typeof error);
    return null;
  }
}

/** "Start 2-Day Free Trial" — the only way a trial starts (explicit click; all rules re-checked on the server). */
export async function startTrialAction(): Promise<{ ok: true; endsAt: string; started: boolean } | { ok: false; message: string }> {
  const student = await requireStudentOrLogin();
  const result = await startPremiumTrial(student.id);
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath("/student", "layout");
  return { ok: true, endsAt: result.endsAt.toISOString(), started: result.started };
}
