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
      await tx.adminUser.update({ where: { id: userId }, data: { isActive, ...(isActive ? {} : { sessionsValidAfter: new Date() }) } });
      await tx.auditLog.create({
        data: { actorId: session.user.id, action: isActive ? "ADMIN_USER_ACTIVATED" : "ADMIN_USER_DEACTIVATED", entityType: "AdminUser", entityId: userId },
      });
    },
    { isolationLevel: "Serializable" }
  );
  revalidatePath("/admin/users/admins");
}

// ---------------------------------------------------------------------------
// Edit admin user + password reset (Admin → Users & Access → Admins → Edit).
//
// USERS_MANAGE (MASTER_ADMIN only) on every call. Changes to email, role,
// account state or password are SENSITIVE: they need the acting admin's own
// current password (re-authentication, throttled), are audit-logged with the
// changed fields only (never a password or hash), and a role change,
// deactivation or password reset signs the target out everywhere
// (sessionsValidAfter — lib/rbac.ts rejects older admin JWTs). Nobody can
// change their own role or deactivate themselves, only a Master Admin can
// grant Master Admin, and the last active Master Admin can never be demoted
// or deactivated (checked inside one serializable transaction).
// ---------------------------------------------------------------------------

export type AdminEditResult = { ok: true; message: string } | { ok: false; error: string };

const REAUTH_WINDOW_MS = 15 * 60 * 1000;
const REAUTH_MAX_FAILURES = 5;

class AdminEditError extends Error {}

/** Re-authenticates the acting admin with their own current password. Failures are audit-logged and throttled. */
async function reauthenticate(actorId: string, password: string): Promise<string | null> {
  const failures = await prisma.auditLog.count({
    where: { actorId, action: "ADMIN_REAUTH_FAILED", createdAt: { gte: new Date(Date.now() - REAUTH_WINDOW_MS) } },
  });
  if (failures >= REAUTH_MAX_FAILURES) return "Too many incorrect password attempts. Wait 15 minutes and try again.";
  const actor = await prisma.adminUser.findUnique({ where: { id: actorId }, select: { passwordHash: true, isActive: true } });
  const ok = Boolean(actor?.isActive && password && (await argon2.verify(actor.passwordHash, password).catch(() => false)));
  if (ok) return null;
  await prisma.auditLog.create({ data: { actorId, action: "ADMIN_REAUTH_FAILED", entityType: "AdminUser", entityId: actorId } });
  return "Your current password is incorrect.";
}

const editSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(120),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => v === "" || z.string().email().safeParse(v).success, "Enter a valid email address"),
  roleId: z.string().min(1, "Select a role"),
  isActive: z.boolean(),
  actorPassword: z.string().max(200).optional(),
});

export async function updateAdminUserAction(input: z.input<typeof editSchema>): Promise<AdminEditResult> {
  const session = await requirePermission(PERMISSIONS.USERS_MANAGE);
  const actorId = session.user.id;
  if (!actorId) return { ok: false, error: "Not signed in." };
  const parsed = editSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;
  const email = d.email === "" ? null : d.email;

  const [target, role] = await Promise.all([
    prisma.adminUser.findUnique({ where: { id: d.id }, select: { id: true, name: true, email: true, isActive: true, roleId: true, role: { select: { name: true } } } }),
    prisma.role.findUnique({ where: { id: d.roleId }, select: { id: true, name: true } }),
  ]);
  if (!target) return { ok: false, error: "Admin user not found." };
  if (!role) return { ok: false, error: "Unknown role." };

  const isSelf = target.id === actorId;
  const roleChanged = role.id !== target.roleId;
  const emailChanged = (email ?? null) !== (target.email ?? null);
  const activeChanged = d.isActive !== target.isActive;
  const nameChanged = d.name !== target.name;
  if (!roleChanged && !emailChanged && !activeChanged && !nameChanged) return { ok: true, message: "No changes to save." };

  if (isSelf && roleChanged) return { ok: false, error: "You cannot change your own role. Ask another Master Admin." };
  if (isSelf && activeChanged && !d.isActive) return { ok: false, error: "You cannot deactivate your own account." };
  if (roleChanged && role.name === "MASTER_ADMIN" && session.user.role !== "MASTER_ADMIN") return { ok: false, error: "Only a Master Admin can grant the Master Admin role." };

  const sensitive = roleChanged || emailChanged || activeChanged;
  if (sensitive) {
    const err = await reauthenticate(actorId, d.actorPassword ?? "");
    if (err) return { ok: false, error: err };
  }
  if (emailChanged && email) {
    const clash = await prisma.adminUser.findFirst({ where: { email, NOT: { id: target.id } }, select: { id: true } });
    if (clash) return { ok: false, error: "Another admin already uses that email." };
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const losesMaster = target.role.name === "MASTER_ADMIN" && target.isActive && ((roleChanged && role.name !== "MASTER_ADMIN") || (activeChanged && !d.isActive));
        if (losesMaster) {
          const activeOwners = await tx.adminUser.count({ where: { isActive: true, role: { name: "MASTER_ADMIN" } } });
          if (activeOwners <= 1) throw new AdminEditError("You cannot demote or deactivate the last active Master Admin.");
        }
        await tx.adminUser.update({
          where: { id: target.id },
          data: {
            name: d.name,
            email,
            roleId: role.id,
            isActive: d.isActive,
            // Role change or deactivation: every existing session of this admin ends now.
            ...(roleChanged || (activeChanged && !d.isActive) ? { sessionsValidAfter: new Date() } : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            actorId,
            action: roleChanged ? "ADMIN_ROLE_CHANGED" : "ADMIN_USER_UPDATED",
            entityType: "AdminUser",
            entityId: target.id,
            metadata: {
              changed: [nameChanged && "name", emailChanged && "email", roleChanged && "role", activeChanged && "isActive"].filter(Boolean),
              ...(roleChanged ? { roleFrom: target.role.name, roleTo: role.name } : {}),
              ...(activeChanged ? { activeFrom: target.isActive, activeTo: d.isActive } : {}),
              reauthenticated: sensitive,
              sessionsInvalidated: roleChanged || (activeChanged && !d.isActive),
            },
          },
        });
      },
      { isolationLevel: "Serializable" }
    );
  } catch (e) {
    if (e instanceof AdminEditError) return { ok: false, error: e.message };
    throw e;
  }
  revalidatePath("/admin/users");
  revalidatePath("/admin/users/admins");
  return { ok: true, message: roleChanged || (activeChanged && !d.isActive) ? "Saved. This admin has been signed out of all sessions." : "Saved." };
}

const resetSchema = z
  .object({
    id: z.string().min(1),
    newPassword: z.string().min(10, "Password must be at least 10 characters").max(200),
    confirmPassword: z.string(),
    actorPassword: z.string().max(200),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { message: "The two new passwords do not match.", path: ["confirmPassword"] });

/** Sets a new password for an admin (argon2, never stored or logged in plaintext) and signs them out everywhere. */
export async function resetAdminPasswordAction(input: z.input<typeof resetSchema>): Promise<AdminEditResult> {
  const session = await requirePermission(PERMISSIONS.USERS_MANAGE);
  const actorId = session.user.id;
  if (!actorId) return { ok: false, error: "Not signed in." };
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const target = await prisma.adminUser.findUnique({ where: { id: parsed.data.id }, select: { id: true } });
  if (!target) return { ok: false, error: "Admin user not found." };
  const err = await reauthenticate(actorId, parsed.data.actorPassword);
  if (err) return { ok: false, error: err };

  const passwordHash = await argon2.hash(parsed.data.newPassword);
  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: target.id }, data: { passwordHash, sessionsValidAfter: new Date() } }),
    prisma.auditLog.create({
      data: { actorId, action: "ADMIN_PASSWORD_RESET", entityType: "AdminUser", entityId: target.id, metadata: { self: target.id === actorId, sessionsInvalidated: true } },
    }),
  ]);
  revalidatePath("/admin/users/admins");
  return {
    ok: true,
    message:
      target.id === actorId
        ? "Your password was changed and all your sessions were signed out. Sign in again with the new password."
        : "Password reset. The admin was signed out everywhere — share the new password through a secure channel and ask them to keep it private.",
  };
}
