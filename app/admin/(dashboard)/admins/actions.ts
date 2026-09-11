"use server";

import { hash } from "@node-rs/argon2";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { ForbiddenError, requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export type FormState = { error?: string } | undefined;

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  role: z.enum(["ADMIN", "SUPER_ADMIN"]),
});

export async function createAdminAction(_prevState: FormState, formData: FormData): Promise<FormState> {
  let session;
  try {
    session = await requireAdminRole("SUPER_ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Only super admins can manage admin accounts." };
    throw e;
  }

  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const existing = await prisma.adminUser.findUnique({ where: { email: parsed.data.email } });
  if (existing) return { error: "An admin with this email already exists." };

  const passwordHash = await hash(parsed.data.password);
  const created = await prisma.adminUser.create({
    data: { name: parsed.data.name, email: parsed.data.email, passwordHash, role: parsed.data.role },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "AdminUser",
    entityId: created.id,
    diff: { name: parsed.data.name, email: parsed.data.email, role: parsed.data.role },
  });
  redirect("/admin/admins?success=Admin account created");
}

const updateSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  role: z.enum(["ADMIN", "SUPER_ADMIN"]),
  isActive: z.coerce.boolean(),
});

export async function updateAdminAction(_prevState: FormState, formData: FormData): Promise<FormState> {
  let session;
  try {
    session = await requireAdminRole("SUPER_ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Only super admins can manage admin accounts." };
    throw e;
  }

  const id = String(formData.get("id"));
  const parsed = updateSchema.safeParse({
    name: formData.get("name"),
    role: formData.get("role"),
    isActive: formData.get("isActive") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  if (id === session.user.id && (parsed.data.role !== "SUPER_ADMIN" || !parsed.data.isActive)) {
    return { error: "You can't demote or deactivate your own account." };
  }

  await prisma.adminUser.update({ where: { id }, data: parsed.data });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "AdminUser",
    entityId: id,
    diff: parsed.data,
  });
  redirect("/admin/admins?success=Admin account updated");
}

const resetPasswordSchema = z.object({ password: z.string().min(8, "Password must be at least 8 characters") });

export async function resetAdminPasswordAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  let session;
  try {
    session = await requireAdminRole("SUPER_ADMIN");
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Only super admins can manage admin accounts." };
    throw e;
  }

  const id = String(formData.get("id"));
  const parsed = resetPasswordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const passwordHash = await hash(parsed.data.password);
  await prisma.adminUser.update({ where: { id }, data: { passwordHash } });

  await writeAuditLog({ adminId: session.user.id, action: "update", entity: "AdminUser", entityId: id, diff: { passwordReset: true } });
  redirect(`/admin/admins/${id}/edit?success=Password reset`);
}
