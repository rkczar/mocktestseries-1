"use server";

import { revalidatePath } from "next/cache";
import type { CommunicationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

export async function setCommunicationStatusAction(id: string, status: CommunicationStatus) {
  const session = await requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE);
  await prisma.communication.update({
    where: { id },
    data: {
      status,
      readAt: status === "READ" || status === "IN_PROGRESS" || status === "RESOLVED" ? new Date() : undefined,
      resolvedAt: status === "RESOLVED" ? new Date() : status === "NEW" || status === "IN_PROGRESS" ? null : undefined,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "COMMUNICATION_STATUS_CHANGED",
      entityType: "Communication",
      entityId: id,
      metadata: { status },
    },
  });
  revalidatePath("/admin/communications");
  revalidatePath(`/admin/communications/${id}`);
}

export async function updateInternalNoteAction(id: string, internalNote: string) {
  const session = await requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE);
  await prisma.communication.update({ where: { id }, data: { internalNote: internalNote.slice(0, 2000) } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "COMMUNICATION_NOTE_UPDATED", entityType: "Communication", entityId: id },
  });
  revalidatePath(`/admin/communications/${id}`);
}

export async function assignToMeAction(id: string) {
  const session = await requirePermission(PERMISSIONS.COMMUNICATIONS_MANAGE);
  await prisma.communication.update({ where: { id }, data: { assignedAdminId: session.user.id } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "COMMUNICATION_ASSIGNED", entityType: "Communication", entityId: id },
  });
  revalidatePath("/admin/communications");
  revalidatePath(`/admin/communications/${id}`);
}
