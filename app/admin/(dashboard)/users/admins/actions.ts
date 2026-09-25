"use server";

import { z } from "zod";
import argon2 from "argon2";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const schema = z.object({
  name: z.string().min(2).max(120),
  username: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9._-]+$/, "Lowercase letters, numbers, dot, underscore, hyphen only"),
  email: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  password: z.string().min(10, "Password must be at least 10 characters"),
  roleId: z.string().min(1, "Select a role"),
});

export interface AdminUserFormState {
  error?: string;
  success?: boolean;
}

export async function createAdminUserAction(
  _prev: AdminUserFormState,
  formData: FormData
): Promise<AdminUserFormState> {
  const session = await requirePermission(PERMISSIONS.USERS_MANAGE);

  const parsed = schema.safeParse({
    name: formData.get("name"),
    username: formData.get("username")?.toString().toLowerCase(),
    email: formData.get("email"),
    password: formData.get("password"),
    roleId: formData.get("roleId"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const existing = await prisma.adminUser.findUnique({ where: { username: parsed.data.username } });
  if (existing) return { error: "That username is already taken." };

  const passwordHash = await argon2.hash(parsed.data.password);

  const newUser = await prisma.adminUser.create({
    data: {
      name: parsed.data.name,
      username: parsed.data.username,
      email: parsed.data.email,
      passwordHash,
      roleId: parsed.data.roleId,
    },
  });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "ADMIN_USER_CREATED",
      entityType: "AdminUser",
      entityId: newUser.id,
      metadata: { username: newUser.username },
    },
  });

  revalidatePath("/admin/users/admins");
  return { success: true };
}

export async function toggleAdminUserActiveAction(userId: string, isActive: boolean) {
  const session = await requirePermission(PERMISSIONS.USERS_MANAGE);
  if (session.user.id === userId && !isActive) {
    throw new Error("You cannot deactivate your own account.");
  }
  // Never leave the platform without an active owner. Checked and applied in
  // one serializable transaction so two concurrent deactivations of the last
  // two MASTER_ADMINs can't both pass.
  await prisma.$transaction(
    async (tx) => {
      if (!isActive) {
        const target = await tx.adminUser.findUnique({ where: { id: userId }, select: { isActive: true, role: { select: { name: true } } } });
        if (target?.isActive && target.role.name === "MASTER_ADMIN") {
          const activeOwners = await tx.adminUser.count({ where: { isActive: true, role: { name: "MASTER_ADMIN" } } });
          if (activeOwners <= 1) throw new Error("You cannot deactivate the last active Master Admin.");
        }
      }
      await tx.adminUser.update({ where: { id: userId }, data: { isActive } });
    },
    { isolationLevel: "Serializable" }
  );
  revalidatePath("/admin/users/admins");
}
