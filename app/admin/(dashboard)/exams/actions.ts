"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const examSchema = z.object({
  name: z.string().min(2).max(200),
  code: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[A-Z0-9-]+$/, "Use uppercase letters, numbers, and hyphens only"),
  year: z.coerce.number().int().min(2000).max(2100).optional().or(z.literal("").transform(() => undefined)),
  description: z.string().max(2000).optional(),
});

export interface ExamFormState {
  error?: string;
  success?: boolean;
}

export async function createExamAction(_prev: ExamFormState, formData: FormData): Promise<ExamFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const parsed = examSchema.safeParse({
    name: formData.get("name"),
    code: formData.get("code")?.toString().toUpperCase(),
    year: formData.get("year"),
    description: formData.get("description"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const existing = await prisma.exam.findUnique({ where: { code: parsed.data.code } });
  if (existing) return { error: "An exam with this code already exists." };

  const exam = await prisma.exam.create({ data: parsed.data });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "EXAM_CREATED",
      entityType: "Exam",
      entityId: exam.id,
      metadata: { name: exam.name, code: exam.code },
    },
  });

  revalidatePath("/admin/exams");
  revalidatePath("/admin");
  return { success: true };
}

export async function toggleExamActiveAction(examId: string, isActive: boolean) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const exam = await prisma.exam.update({ where: { id: examId }, data: { isActive } });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: isActive ? "EXAM_ACTIVATED" : "EXAM_DEACTIVATED",
      entityType: "Exam",
      entityId: exam.id,
    },
  });

  revalidatePath("/admin/exams");
  revalidatePath("/");
}
