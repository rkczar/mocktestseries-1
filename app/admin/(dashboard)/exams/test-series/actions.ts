"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const schema = z.object({
  examId: z.string().min(1, "Select an exam"),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  testCount: z.coerce.number().int().min(0).max(1000).default(0),
});

export interface TestSeriesFormState {
  error?: string;
  success?: boolean;
}

export async function createTestSeriesAction(
  _prev: TestSeriesFormState,
  formData: FormData
): Promise<TestSeriesFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = schema.safeParse({
    examId: formData.get("examId"),
    name: formData.get("name"),
    description: formData.get("description"),
    testCount: formData.get("testCount"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const series = await prisma.testSeries.create({ data: parsed.data });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TEST_SERIES_CREATED", entityType: "TestSeries", entityId: series.id },
  });

  revalidatePath("/admin/exams/test-series");
  return { success: true };
}

export async function toggleTestSeriesActiveAction(id: string, isActive: boolean) {
  await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  await prisma.testSeries.update({ where: { id }, data: { isActive } });
  revalidatePath("/admin/exams/test-series");
  revalidatePath("/");
}
