"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { AttemptPolicy, MockTestStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/ist-time";

// Mock Test Builder mutations are gated by TEST_SERIES_MANAGE (MASTER_ADMIN
// only), not TESTS_MANAGE — Mock Tests are now part of the Test Series
// Control Center, which is spec'd as MASTER_ADMIN-mutate / FULL_ADMIN-read-
// only. Live Test keeps using TESTS_MANAGE unchanged; it's a separate
// feature (see lib/permissions.ts).
const mockTestSchema = z.object({
  examId: z.string().min(1, "Select an exam."),
  testSeriesId: z.string().optional(),
  title: z.string().trim().min(2, "Title is required."),
  description: z.string().trim().optional(),
  durationMinutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute."),
  negativeMarking: z.coerce.number().min(0).max(1),
  instructions: z.string().trim().optional(),
  accessType: z.enum(["FREE", "PAID"]),
  availableFrom: z.string().optional(),
  attemptPolicy: z.enum(["SINGLE_ATTEMPT", "MULTIPLE_PRACTICE"]).default("MULTIPLE_PRACTICE"),
});

export interface MockTestFormState {
  error?: string;
  success?: boolean;
}

export async function createMockTestAction(
  _prev: MockTestFormState,
  formData: FormData
): Promise<MockTestFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const parsed = mockTestSchema.safeParse({
    examId: formData.get("examId"),
    testSeriesId: formData.get("testSeriesId") || undefined,
    title: formData.get("title"),
    description: formData.get("description") || undefined,
    durationMinutes: formData.get("durationMinutes"),
    negativeMarking: formData.get("negativeMarking"),
    instructions: formData.get("instructions") || undefined,
    accessType: formData.get("accessType"),
    availableFrom: formData.get("availableFrom") || undefined,
    attemptPolicy: formData.get("attemptPolicy") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { testSeriesId, availableFrom, ...rest } = parsed.data;
  const mockTest = await prisma.mockTest.create({
    data: {
      ...rest,
      testSeriesId: testSeriesId || null,
      availableFrom: availableFrom ? parseIstDateTimeLocal(availableFrom) : null,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "MOCK_TEST_CREATED", entityType: "MockTest", entityId: mockTest.id },
  });

  revalidatePath("/admin/tests/mock");
  return { success: true };
}

export async function setMockTestStatusAction(mockTestId: string, status: MockTestStatus) {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
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

export interface ScheduleFormState {
  error?: string;
  success?: boolean;
}

/** Edits a Mock Test's release schedule + attempt policy from the detail page (Schedule & Policy card). */
export async function updateMockTestScheduleAction(
  mockTestId: string,
  _prev: ScheduleFormState,
  formData: FormData
): Promise<ScheduleFormState> {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
  const availableFromRaw = (formData.get("availableFrom") as string | null) || "";
  const attemptPolicy = formData.get("attemptPolicy") as AttemptPolicy;
  if (attemptPolicy !== "SINGLE_ATTEMPT" && attemptPolicy !== "MULTIPLE_PRACTICE") {
    return { error: "Invalid attempt policy." };
  }
  const availableFrom = availableFromRaw ? parseIstDateTimeLocal(availableFromRaw) : null;
  if (availableFromRaw && !availableFrom) return { error: "Invalid available-from date/time." };

  await prisma.mockTest.update({ where: { id: mockTestId }, data: { availableFrom, attemptPolicy } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "MOCK_TEST_SCHEDULE_UPDATED",
      entityType: "MockTest",
      entityId: mockTestId,
      metadata: { availableFrom, attemptPolicy },
    },
  });

  revalidatePath(`/admin/tests/mock/${mockTestId}`);
  revalidatePath("/admin/tests/mock");
  revalidatePath("/admin/tests/scheduled");
  revalidatePath("/student/test-series");
  revalidatePath("/student/dashboard");
  return { success: true };
}

export async function syncMockTestQuestionsAction(mockTestId: string, formData: FormData) {
  const session = await requirePermission(PERMISSIONS.TEST_SERIES_MANAGE);
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
