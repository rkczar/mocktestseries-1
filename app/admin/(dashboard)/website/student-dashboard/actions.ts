"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import {
  STUDENT_DASHBOARD_LAYOUT_KEY,
  parseSubmittedLayout,
  resetStudentDashboardLayout,
  saveStudentDashboardLayout,
} from "@/lib/student-dashboard-layout";
import { DEFAULT_STUDENT_DASHBOARD_LAYOUT, type StudentDashboardLayout } from "@/lib/student-dashboard-blocks";

export type DashboardLayoutResult = { ok: true; layout: StudentDashboardLayout } | { ok: false; error: string };

/**
 * Gated behind WEBSITE_MANAGE, which only MASTER_ADMIN holds — FULL_ADMIN is
 * global read-only (lib/permissions.ts) and is refused here server-side.
 */
export async function saveStudentDashboardLayoutAction(raw: unknown): Promise<DashboardLayoutResult> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  const layout = parseSubmittedLayout(raw);
  if (!layout) return { ok: false, error: "Invalid layout — reload the page and try again." };

  await saveStudentDashboardLayout(layout);
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "STUDENT_DASHBOARD_LAYOUT_SAVED",
      entityType: "Setting",
      entityId: STUDENT_DASHBOARD_LAYOUT_KEY,
      metadata: { order: layout.map((b) => b.id), hidden: layout.filter((b) => !b.visible).map((b) => b.id) },
    },
  });
  revalidatePath("/student/dashboard");
  return { ok: true, layout };
}

export async function restoreDefaultStudentDashboardLayoutAction(): Promise<DashboardLayoutResult> {
  const session = await requirePermission(PERMISSIONS.WEBSITE_MANAGE);
  await resetStudentDashboardLayout();
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "STUDENT_DASHBOARD_LAYOUT_RESET",
      entityType: "Setting",
      entityId: STUDENT_DASHBOARD_LAYOUT_KEY,
      metadata: {},
    },
  });
  revalidatePath("/student/dashboard");
  return { ok: true, layout: DEFAULT_STUDENT_DASHBOARD_LAYOUT };
}
