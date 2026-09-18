"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { AnnouncementStatus, AnnouncementType, AnnouncementPriority, AnnouncementAudience } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/ist-time";
import { isSafeInternalRoute } from "@/lib/safe-route";

const announcementSchema = z.object({
  title: z.string().trim().min(2, "Title is required."),
  message: z.string().trim().min(2, "Message is required."),
  content: z.string().trim().optional(),
  type: z.nativeEnum(AnnouncementType),
  priority: z.nativeEnum(AnnouncementPriority),
  audience: z.nativeEnum(AnnouncementAudience),
  examId: z.string().optional(),
  ctaLabel: z.string().trim().optional(),
  ctaRoute: z.string().trim().optional(),
  showOnDashboard: z.enum(["on"]).optional(),
  publishAt: z.string().optional(),
  expiresAt: z.string().optional(),
  selectedStudentIds: z.string().optional(),
});

export interface AnnouncementFormState {
  error?: string;
  success?: boolean;
}

async function validateAndBuild(formData: FormData) {
  const parsed = announcementSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." } as const;
  const data = parsed.data;

  if (data.audience === "EXAM_STUDENTS" && !data.examId) {
    return { error: "Select an exam for the Exam Students audience." } as const;
  }

  if (data.ctaRoute && !isSafeInternalRoute(data.ctaRoute)) {
    return { error: "CTA Route must be an internal path starting with / (no external URLs)." } as const;
  }
  if (data.ctaLabel && !data.ctaRoute) {
    return { error: "A CTA Route is required when a CTA Label is set." } as const;
  }

  const publishAt = data.publishAt ? parseIstDateTimeLocal(data.publishAt) : null;
  const expiresAt = data.expiresAt ? parseIstDateTimeLocal(data.expiresAt) : null;
  if (data.publishAt && !publishAt) return { error: "Invalid publish time." } as const;
  if (data.expiresAt && !expiresAt) return { error: "Invalid expiry time." } as const;
  if (publishAt && expiresAt && expiresAt.getTime() <= publishAt.getTime()) {
    return { error: "Expires At must be after Publish At." } as const;
  }

  let studentIds: string[] = [];
  if (data.audience === "SELECTED_STUDENTS") {
    const codes = Array.from(
      new Set(
        (data.selectedStudentIds ?? "")
          .split(/[\s,]+/)
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      )
    );
    if (codes.length === 0) return { error: "List at least one Student ID for Selected Students." } as const;

    const students = await prisma.student.findMany({ where: { studentId: { in: codes } }, select: { id: true, studentId: true } });
    const found = new Set(students.map((s) => s.studentId));
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length > 0) return { error: `Unknown Student ID(s): ${missing.join(", ")}` } as const;
    studentIds = students.map((s) => s.id);
  }

  return {
    data: {
      title: data.title,
      message: data.message,
      content: data.content || null,
      type: data.type,
      priority: data.priority,
      audience: data.audience,
      examId: data.audience === "EXAM_STUDENTS" ? data.examId! : null,
      ctaLabel: data.ctaLabel || null,
      ctaRoute: data.ctaRoute || null,
      showOnDashboard: data.showOnDashboard === "on",
      publishAt,
      expiresAt,
      studentIds,
    },
  } as const;
}

export async function createAnnouncementAction(_prev: AnnouncementFormState, formData: FormData): Promise<AnnouncementFormState> {
  const session = await requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE);

  const result = await validateAndBuild(formData);
  if ("error" in result) return { error: result.error };
  const { data } = result;

  const announcement = await prisma.announcement.create({
    data: {
      title: data.title,
      message: data.message,
      content: data.content,
      type: data.type,
      priority: data.priority,
      audience: data.audience,
      examId: data.examId,
      ctaLabel: data.ctaLabel,
      ctaRoute: data.ctaRoute,
      showOnDashboard: data.showOnDashboard,
      publishAt: data.publishAt,
      expiresAt: data.expiresAt,
      status: AnnouncementStatus.DRAFT,
      createdByAdminId: session.user.id,
      recipients: data.studentIds.length > 0 ? { create: data.studentIds.map((studentId) => ({ studentId })) } : undefined,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "ANNOUNCEMENT_CREATED", entityType: "Announcement", entityId: announcement.id },
  });

  revalidatePath("/admin/website");
  return { success: true };
}

export async function updateAnnouncementAction(
  announcementId: string,
  _prev: AnnouncementFormState,
  formData: FormData
): Promise<AnnouncementFormState> {
  const session = await requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE);

  const existing = await prisma.announcement.findUnique({ where: { id: announcementId }, select: { status: true } });
  if (!existing) return { error: "Announcement not found." };
  if (existing.status === AnnouncementStatus.ARCHIVED) return { error: "An archived announcement can no longer be edited." };

  const result = await validateAndBuild(formData);
  if ("error" in result) return { error: result.error };
  const { data } = result;

  await prisma.$transaction([
    prisma.announcementRecipient.deleteMany({ where: { announcementId } }),
    prisma.announcement.update({
      where: { id: announcementId },
      data: {
        title: data.title,
        message: data.message,
        content: data.content,
        type: data.type,
        priority: data.priority,
        audience: data.audience,
        examId: data.examId,
        ctaLabel: data.ctaLabel,
        ctaRoute: data.ctaRoute,
        showOnDashboard: data.showOnDashboard,
        publishAt: data.publishAt,
        expiresAt: data.expiresAt,
        recipients: data.studentIds.length > 0 ? { create: data.studentIds.map((studentId) => ({ studentId })) } : undefined,
      },
    }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "ANNOUNCEMENT_UPDATED", entityType: "Announcement", entityId: announcementId },
  });

  revalidatePath("/admin/website");
  return { success: true };
}

export async function publishAnnouncementAction(announcementId: string) {
  const session = await requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE);

  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!announcement) return;
  if (announcement.status === AnnouncementStatus.ARCHIVED) return;

  await prisma.announcement.update({ where: { id: announcementId }, data: { status: AnnouncementStatus.PUBLISHED } });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "ANNOUNCEMENT_PUBLISHED", entityType: "Announcement", entityId: announcementId },
  });

  revalidatePath("/admin/website");
  revalidatePath("/student/dashboard");
}

export async function unpublishAnnouncementAction(announcementId: string) {
  const session = await requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE);

  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!announcement || announcement.status !== AnnouncementStatus.PUBLISHED) return;

  await prisma.announcement.update({ where: { id: announcementId }, data: { status: AnnouncementStatus.DRAFT } });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "ANNOUNCEMENT_UNPUBLISHED", entityType: "Announcement", entityId: announcementId },
  });

  revalidatePath("/admin/website");
  revalidatePath("/student/dashboard");
}

export async function archiveAnnouncementAction(announcementId: string) {
  const session = await requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE);

  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!announcement || announcement.status === AnnouncementStatus.ARCHIVED) return;

  await prisma.announcement.update({ where: { id: announcementId }, data: { status: AnnouncementStatus.ARCHIVED } });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "ANNOUNCEMENT_ARCHIVED", entityType: "Announcement", entityId: announcementId },
  });

  revalidatePath("/admin/website");
  revalidatePath("/student/dashboard");
}
