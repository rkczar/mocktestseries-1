"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Broken-connection check (Section 19). Conservative: only ever escalates a
 * CONNECTED entry to WARNING/ORPHAN when it finds a real problem, and only
 * de-escalates back to CONNECTED once the problem is gone. DRAFT entries
 * (not built yet) are left alone — they're not "broken", just unbuilt.
 */
export async function runDiagramCheckAction() {
  await requirePermission(PERMISSIONS.WEBSITE_MANAGE);

  const entries = await prisma.routeRegistryEntry.findMany();
  const routeSet = new Set(entries.map((e) => e.route));

  for (const entry of entries) {
    if (entry.status === "DRAFT") continue;

    let nextStatus: typeof entry.status = "CONNECTED";
    if (entry.parentRoute && !routeSet.has(entry.parentRoute)) {
      nextStatus = "ORPHAN";
    } else if (entry.authRequired && entry.userType === "PUBLIC") {
      nextStatus = "WARNING";
    }

    if (nextStatus !== entry.status) {
      await prisma.routeRegistryEntry.update({ where: { id: entry.id }, data: { status: nextStatus } });
    }
  }

  revalidatePath("/admin/website/diagram");
}
