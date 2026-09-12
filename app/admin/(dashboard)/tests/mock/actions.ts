"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { MockTestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const mockTestSchema = z.object({
  examId: z.string().min(1, "Select an exam."),
  testSeriesId: z.string().optional(),
  title: z.string().trim().min(2, "Title is required."),
  description: z.string().trim().optional(),
  durationMinutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute."),
  negativeMarking: z.coerce.number().min(0).max(1),
  instructions: z.string().trim().optional(),
  accessType: z.enum(["FREE", "PAID"]),
});

export interface MockTestFormState {
  error?: string;
  success?: boolean;
}

export async function createMockTestAction(
  _prev: MockTestFormState,
  formData: FormData
): Promise<MockTestFormState> {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);
  const parsed = mockTestSchema.safeParse({
    examId: formData.get("examId"),
    testSeriesId: formData.get("testSeriesId") || undefined,
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    durationMinutes: formData.get("durationMinutes"),
    negativeMarking: formData.get("negativeMarking"),
    instructions: formData.get("instructions") || undefined,
    accessType: formData.get("accessType"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { testSeriesId, ...rest } = parsed.data;
  const mockTest = await prisma.mockTest.create({
    data: { ...rest, testSeriesId: testSeriesId || null },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "MOCK_TEST_CREATED", entityType: "MockTest", entityId: mockTest.id },
  });

  revalidatePath("/admin/tests/mock");
  return { success: true };
}

export async function setMockTestStatusAction(mockTestId: string, status: MockTestStatus) {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);
  await prisma.mockTest.update({ where: { id: mockTestId }, data: { status } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_STATUS_CHANGED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { status },
    },
  });
  revalidatePath("/admin/tests/mock");
  revalidatePath("/student/test-series");
}

export async function syncMockTestQuestionsAction(mockTestId: string, formData: FormData) {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);
  const questionIds = formData.getAll("questionIds").map(String);

  await prisma.$transaction([
    prisma.mockTestQuestion.deleteMany({ where: { mockTestId } }),
    prisma.mockTestQuestion.createMany({
      data: questionIds.map((questionId, order) => ({ mockTestId, questionId, order })),
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_QUESTIONS_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { count: questionIds.length },
    },
  });

  revalidatePath(`/admin/tests/mock/${mockTestId}`);
  revalidatePath("/admin/tests/mock");
}
