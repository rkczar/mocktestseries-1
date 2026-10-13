"use server";

import { revalidatePath } from "next/cache";
import { requireStudentOrLogin } from "@/lib/student-session";
import { claimTrialPopup, startPremiumTrial, type TrialPopupData } from "@/lib/premium-trial";

/**
 * Dashboard-entry popup. Called once on mount: the server decides the state
 * and claims today's slot (lib/premium-trial.ts#claimTrialPopup), so a
 * refresh or another tab gets null. `force` = the student arrived from a
 * Premium lock (?premium=locked) and should see their options right away.
 */
export async function claimTrialPopupAction(force: boolean): Promise<TrialPopupData | null> {
  const student = await requireStudentOrLogin();
  try {
    return await claimTrialPopup(student.id, { force });
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
