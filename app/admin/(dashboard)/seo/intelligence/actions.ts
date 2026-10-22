"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { STATE_COOKIE, STATE_COOKIE_PATH, STATE_TTL_SECONDS, SeoIntelError, beginAuthorization, disconnect } from "@/lib/seo-intel/google";
import { runSync } from "@/lib/seo-intel/sync";
import { HISTORY_DAYS_MAX, HISTORY_DAYS_MIN, pruneHistory, saveIntelSettings } from "@/lib/seo-intel/history";

export interface SeoIntelActionState {
  ok?: boolean;
  message?: string;
}

/**
 * Connect / disconnect / sync the shared SEO Google connection — all
 * MASTER_ADMIN-only (SEO_INTEL_MANAGE), enforced here, not just by hiding the
 * buttons. Every admin role can read the page (SEO_INTEL_VIEW).
 */
export async function startGoogleConnectAction() {
  const session = await requirePermission(PERMISSIONS.SEO_INTEL_MANAGE);
  if (!session.user.id) throw new Error("Not signed in");
  let start: Awaited<ReturnType<typeof beginAuthorization>>;
  try {
    start = await beginAuthorization(session.user.id);
  } catch (err) {
    if (err instanceof SeoIntelError) redirect("/admin/seo/intelligence?google=error&reason=not-configured");
    throw err;
  }
  (await cookies()).set(STATE_COOKIE, start.cookieValue, {
    httpOnly: true,
    secure: start.secureCookie,
    sameSite: "lax",
    path: STATE_COOKIE_PATH,
    maxAge: STATE_TTL_SECONDS,
  });
  redirect(start.url);
}

export async function disconnectGoogleAction(_prev: SeoIntelActionState, formData: FormData): Promise<SeoIntelActionState> {
  const session = await requirePermission(PERMISSIONS.SEO_INTEL_MANAGE);
  if (formData.get("confirm") !== "DISCONNECT") return { ok: false, message: 'Type DISCONNECT to confirm.' };
  const result = await disconnect();
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "SEO_GOOGLE_DISCONNECTED",
      entityType: "Setting",
      entityId: "seo.google.oauth",
      metadata: { accountEmail: result.accountEmail, revokedAtGoogle: result.revoked },
    },
  });
  revalidatePath("/admin/seo/intelligence");
  if (!result.wasConnected) return { ok: true, message: "Google was not connected." };
  return {
    ok: true,
    message: result.revoked
      ? "Disconnected. The saved Google access was removed and revoked at Google."
      : "Disconnected. The saved Google access was removed; Google did not confirm the revoke, so also remove the app at myaccount.google.com/permissions.",
  };
}

export async function syncGoogleAction(): Promise<SeoIntelActionState> {
  const session = await requirePermission(PERMISSIONS.SEO_INTEL_MANAGE);
  const result = await runSync(session.user.id ?? null);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "SEO_GOOGLE_SYNC",
      entityType: "Setting",
      entityId: "seo.intel.snapshot",
      metadata: { source: "manual", ok: result.ok, gscError: result.gscError, ga4Error: result.ga4Error },
    },
  });
  revalidatePath("/admin/seo/intelligence");
  return { ok: result.ok, message: result.message };
}

/** Daily automatic sync switch + history retention. Saving applies the retention immediately. */
export async function saveIntelSettingsAction(_prev: SeoIntelActionState, formData: FormData): Promise<SeoIntelActionState> {
  const session = await requirePermission(PERMISSIONS.SEO_INTEL_MANAGE);
  const days = Number(formData.get("historyDays"));
  if (!Number.isInteger(days) || days < HISTORY_DAYS_MIN || days > HISTORY_DAYS_MAX) {
    return { ok: false, message: `Keep history for ${HISTORY_DAYS_MIN}–${HISTORY_DAYS_MAX} days.` };
  }
  const saved = await saveIntelSettings({ autoSyncEnabled: formData.get("autoSyncEnabled") === "on", historyDays: days });
  const pruned = await pruneHistory(saved.historyDays);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "SEO_INTEL_SETTINGS_SAVED",
      entityType: "Setting",
      entityId: "seo.intel.settings",
      metadata: { autoSyncEnabled: saved.autoSyncEnabled, historyDays: saved.historyDays, pruned },
    },
  });
  revalidatePath("/admin/seo/intelligence");
  return { ok: true, message: `Saved.${pruned ? ` Removed ${pruned} history day${pruned === 1 ? "" : "s"} older than ${saved.historyDays} days.` : ""}` };
}
