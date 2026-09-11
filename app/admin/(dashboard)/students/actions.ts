"use server";

import { redirect } from "next/navigation";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export async function setStudentActiveAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const isActive = formData.get("isActive") === "true";

  await prisma.student.update({ where: { id }, data: { isActive } });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "Student",
    entityId: id,
    diff: { isActive },
  });
  redirect(`/admin/students/${id}?success=${isActive ? "Student reactivated" : "Student deactivated"}`);
}
