"use server";

import { updateTag } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { writeAuditLog } from "@/lib/audit";
import { requireAdminRole } from "@/lib/auth/requireAdmin";
import { prisma } from "@/lib/db";

export type FormState = { error?: string } | undefined;

const schema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  subtitle: z.string().trim().optional(),
  examDate: z.string().trim().optional(),
  dateLabel: z.string().trim().optional(),
  region: z.string().trim().optional(),
  status: z.string().trim().min(1, "Status text is required"),
  statusTone: z.enum(["success", "accent", "neutral"]),
  actionLabel: z.string().trim().optional(),
  actionHref: z.string().trim().optional(),
  examId: z.string().trim().optional(),
  order: z.coerce.number().int().default(0),
  isVisible: z.coerce.boolean(),
});

function parseForm(formData: FormData) {
  return schema.safeParse({
    title: formData.get("title"),
    subtitle: formData.get("subtitle") || undefined,
    examDate: formData.get("examDate") || undefined,
    dateLabel: formData.get("dateLabel") || undefined,
    region: formData.get("region") || undefined,
    status: formData.get("status"),
    statusTone: formData.get("statusTone"),
    actionLabel: formData.get("actionLabel") || undefined,
    actionHref: formData.get("actionHref") || undefined,
    examId: formData.get("examId") || undefined,
    order: formData.get("order") || 0,
    isVisible: formData.get("isVisible") === "on",
  });
}

export async function createUpcomingExamAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  const created = await prisma.upcomingExam.create({
    data: { ...parsed.data, examDate: parsed.data.examDate ? new Date(parsed.data.examDate) : null },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "create",
    entity: "UpcomingExam",
    entityId: created.id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/upcoming-exams?success=Upcoming exam created");
}

export async function updateUpcomingExamAction(
  _prevState: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };

  await prisma.upcomingExam.update({
    where: { id },
    data: { ...parsed.data, examDate: parsed.data.examDate ? new Date(parsed.data.examDate) : null },
  });

  await writeAuditLog({
    adminId: session.user.id,
    action: "update",
    entity: "UpcomingExam",
    entityId: id,
    diff: parsed.data,
  });
  updateTag("homepage");
  redirect("/admin/upcoming-exams?success=Upcoming exam updated");
}

export async function deleteUpcomingExamAction(formData: FormData): Promise<void> {
  const session = await requireAdminRole();
  const id = String(formData.get("id"));

  await prisma.upcomingExam.delete({ where: { id } });

  await writeAuditLog({ adminId: session.user.id, action: "delete", entity: "UpcomingExam", entityId: id });
  updateTag("homepage");
  redirect("/admin/upcoming-exams?success=Upcoming exam deleted");
}
