"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { PAGE_VISIBILITY_DEFAULTS, type PageVisibilityKey } from "@/lib/page-visibility";

/**
 * MASTER_ADMIN only (see lib/permissions.ts) — FULL_ADMIN already has
 * WEBSITE_MANAGE for everything else under Admin -> Website, but public
 * page on/off is deliberately narrower. Enforced here, server-side; the UI
 * additionally disables the switch for a non-MASTER_ADMIN viewer, but that
 * is defense in depth, not the actual gate.
 */
export async function togglePageVisibilityAction(key: PageVisibilityKey, next: boolean) {
  const session = await requirePermission(PERMISSIONS.PAGE_VISIBILITY_MANAGE);
  const def = PAGE_VISIBILITY_DEFAULTS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown page visibility key: ${key}`);

  await prisma.pageVisibility.upsert({
    where: { key },
    create: { key: def.key, label: def.label, route: def.route, isVisible: next, updatedById: session.user.id },
    update: { isVisible: next, updatedById: session.user.id },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: next ? "PAGE_VISIBILITY_ENABLED" : "PAGE_VISIBILITY_DISABLED",
      entityType: "PageVisibility",
      entityId: key,
      metadata: { route: def.route },
    },
  });

  // The toggled page itself needs a fresh render (it checks visibility on
  // every request), plus anywhere it's advertised.
  revalidatePath(def.route);
  revalidatePath("/admin/website");
  revalidatePath("/sitemap.xml");
}
