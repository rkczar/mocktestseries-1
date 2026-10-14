"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/rbac";
import { dashboardLayoutKey, sanitizeDashboardOrder } from "@/lib/admin-dashboard-layout";

/**
 * Per-admin Admin Dashboard card order. A personal display preference of
 * the signed-in admin (any active admin, own layout only — the key is
 * derived from the server session, never from client input). It changes
 * order only; card visibility stays permission-driven at render time.
 */

export type LayoutResult = { ok: true; order: string[] } | { ok: false; error: string };

export async function saveAdminDashboardLayoutAction(order: unknown): Promise<LayoutResult> {
  const session = await getAdminSession();
  if (!session?.user?.id) return { ok: false, error: "Not signed in." };
  const clean = sanitizeDashboardOrder(order);
  if (!clean.length) return { ok: false, error: "Nothing to save." };
  const key = dashboardLayoutKey(session.user.id);
  const value = { order: clean, savedAt: new Date().toISOString() };
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  revalidatePath("/admin");
  return { ok: true, order: clean };
}

export async function resetAdminDashboardLayoutAction(): Promise<LayoutResult> {
  const session = await getAdminSession();
  if (!session?.user?.id) return { ok: false, error: "Not signed in." };
  await prisma.setting.deleteMany({ where: { key: dashboardLayoutKey(session.user.id) } });
  revalidatePath("/admin");
  return { ok: true, order: [] };
}
