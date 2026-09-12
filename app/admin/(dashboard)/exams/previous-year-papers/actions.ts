"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const schema = z.object({
  examId: z.string().min(1, "Select an exam"),
  year: z.coerce.number().int().min(1990).max(2100),
  title: z.string().min(2).max(200),
});

export interface PaperFormState {
  error?: string;
  success?: boolean;
}

export async function createPaperAction(_prev: PaperFormState, formData: FormData): Promise<PaperFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = schema.safeParse({
    examId: formData.get("examId"),
    year: formData.get("year"),
    title: formData.get("title"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const paper = await prisma.previousYearPaper.create({ data: parsed.data });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "PYP_CREATED", entityType: "PreviousYearPaper", entityId: paper.id },
  });

  revalidatePath("/admin/exams/previous-year-papers");
  return { success: true };
}

export async function togglePaperActiveAction(paperId: string, isActive: boolean) {
  await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  await prisma.previousYearPaper.update({ where: { id: paperId }, data: { isActive } });
  revalidatePath("/admin/exams/previous-year-papers");
  revalidatePath("/");
}
