"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export type FormState = { error?: string } | undefined;

const schema = z.object({
  tag: z.string().trim().optional(),
  message: z.string().trim().min(1, "Message is required"),
  linkLabel: z.string().trim().optional(),
  linkHref: z.string().trim().optional(),
  isActive: z.coerce.boolean(),
  startsAt: z.string().trim().optional(),
  endsAt: z.string().trim().optional(),
});

function parseForm(formData: FormData) {
  return schema.safeParse({
    tag: formData.get("tag") || undefined,
    message: formData.get("message"),
    linkLabel: formData.get("linkLabel") || undefined,
    linkHref: formData.get("linkHref") || undefined,
    isActive: formData.get("isActive") === "on",
    startsAt: formData.get("startsAt") || undefined,
    endsAt: formData.get("endsAt") || undefined,
  });
}

export async function createAnnouncementAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const created = await prisma.announcement.create({
    data: {
      ...parsed.data,
      startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
    },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "Announcement",
    entityId: created.id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/announcements?success=Announcement created");
}

export async function updateAnnouncementAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await prisma.announcement.update({
    where: { id },
    data: {
      ...parsed.data,
      startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : null,
      endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
    },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "Announcement",
    entityId: id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/announcements?success=Announcement updated");
}

export async function deleteAnnouncementAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));

  await prisma.announcement.delete({ where: { id } });

  await writeAuditLog({ adminId: session.user.id, action: "delete", entity: "Announcement", entityId: id });
  updateTag("homepage");
  redirect("/admin/announcements?success=Announcement deleted");
}
