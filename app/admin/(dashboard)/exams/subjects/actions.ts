"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const schema = z.object({
  examId: z.string().min(1, "Select an exam"),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
});

export interface SubjectFormState {
  error?: string;
  success?: boolean;
}

export async function createSubjectAction(_prev: SubjectFormState, formData: FormData): Promise<SubjectFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = schema.safeParse({ examId: formData.get("examId"), name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const subject = await prisma.subject.create({ data: parsed.data });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBJECT_CREATED", entityType: "Subject", entityId: subject.id },
  });

  revalidatePath("/admin/exams/subjects");
  revalidatePath("/admin/exams/topics");
  revalidatePath("/admin/exams/syllabus");
  revalidatePath("/admin/questions/add");
  revalidatePath("/student/exams/[examId]", "page");
  return { success: true };
}

const editSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
  order: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

export async function editSubjectAction(_prev: SubjectFormState, formData: FormData): Promise<SubjectFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = editSchema.safeParse({
    id: formData.get("id"),
    name: formData.get("name"),
    order: formData.get("order"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const subject = await prisma.subject.update({
    where: { id: parsed.data.id },
    data: { name: parsed.data.name, order: parsed.data.order },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBJECT_UPDATED", entityType: "Subject", entityId: subject.id },
  });

  revalidatePath("/admin/exams/subjects");
  revalidatePath("/admin/exams/topics");
  revalidatePath("/admin/exams/syllabus");
  revalidatePath("/student/exams/[examId]", "page");
  return { success: true };
}

export async function deleteSubjectAction(subjectId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const [topicCount, questionCount] = await Promise.all([
    prisma.topic.count({ where: { subjectId } }),
    prisma.question.count({ where: { subjectId } }),
  ]);
  if (topicCount > 0 || questionCount > 0) {
    throw new Error("Cannot delete a subject that has topics or questions. Remove those first.");
  }

  await prisma.subject.delete({ where: { id: subjectId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBJECT_DELETED", entityType: "Subject", entityId: subjectId },
  });

  revalidatePath("/admin/exams/subjects");
  revalidatePath("/admin/exams/syllabus");
  revalidatePath("/student/exams/[examId]", "page");
}
