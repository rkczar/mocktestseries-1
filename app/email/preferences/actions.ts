"use server";

import { setPromotionalOptOut, verifyPreferencesToken } from "@/lib/email/preferences";

export async function updateEmailPreferenceAction(token: string, promotionalOptOut: boolean): Promise<{ ok: boolean; error?: string }> {
  const studentId = verifyPreferencesToken(token);
  if (!studentId) return { ok: false, error: "This link is invalid. Please use the link from a recent email." };
  await setPromotionalOptOut(studentId, promotionalOptOut, "preferences-page");
  return { ok: true };
}
