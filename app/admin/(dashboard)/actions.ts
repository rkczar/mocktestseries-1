"use server";

import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function logoutAction() {
  // Admin sessions are stateless JWTs: clearing the cookie alone would leave
  // any copy of it valid until expiry. Stamping sessionsValidAfter makes
  // lib/rbac.ts#getAdminSession reject every session signed in before now.
  const session = await auth();
  const adminId = session?.user?.id;
  if (adminId) {
    try {
      await prisma.adminUser.update({ where: { id: adminId }, data: { sessionsValidAfter: new Date() } });
      await prisma.auditLog.create({
        data: { actorId: adminId, action: "ADMIN_LOGOUT", entityType: "AdminUser", entityId: adminId },
      });
    } catch {
      // Never block sign-out; the cookie is cleared regardless.
    }
  }
  await signOut({ redirectTo: "/admin/login" });
}
