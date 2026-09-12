"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { CustomModuleStatus, QuestionDifficulty, QuestionStatus, SelectionMode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const customModuleSchema = z.object({
  examId: z.string().min(1, "Select an exam."),
  title: z.string().trim().min(2, "Title is required."),
  description: z.string().trim().optional(),
  selectionMode: z.nativeEnum(SelectionMode),
  durationMinutes: z.coerce.number().int().min(1).optional().or(z.literal("").transform(() => undefined)),
  negativeMarking: z.coerce.number().min(0).max(1),
  instructions: z.string().trim().optional(),
  accessType: z.enum(["FREE", "PAID"]),
  ruleSubjectId: z.string().optional(),
  ruleTopicId: z.string().optional(),
  ruleDifficulty: z.string().optional(),
  ruleCount: z.coerce.number().int().min(1).optional().or(z.literal("").transform(() => undefined)),
});

export interface CustomModuleFormState {
  error?: string;
  success?: boolean;
}

export async function createCustomModuleAction(
  _prev: CustomModuleFormState,
  formData: FormData
): Promise<CustomModuleFormState> {
  const session = await requirePermission(PERMISSIONS.CUSTOM_MODULES_MANAGE);
  const parsed = customModuleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." };

  const { examId, title, description, selectionMode, durationMinutes, negativeMarking, instructions, accessType } =
    parsed.data;

  const ruleConfig =
    selectionMode === SelectionMode.RULE_BASED
      ? {
          subjectId: parsed.data.ruleSubjectId || undefined,
          topicId: parsed.data.ruleTopicId || undefined,
          difficulty: parsed.data.ruleDifficulty || undefined,
          count: parsed.data.ruleCount ?? 20,
        }
      : undefined;

  const customModule = await prisma.customModule.create({
    data: {
      examId,
      title,
      description,
      selectionMode,
      ruleConfig,
      durationMinutes,
      negativeMarking,
      instructions,
      accessType,
      createdByAdminId: session.user.id,
    },
  });

  if (selectionMode === SelectionMode.RULE_BASED) {
    await resolveRuleForModule(customModule.id);
  }

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "CUSTOM_MODULE_CREATED", entityType: "CustomModule", entityId: customModule.id },
  });

  revalidatePath("/admin/custom-modules");
  return { success: true };
}

export async function setCustomModuleStatusAction(moduleId: string, status: CustomModuleStatus) {
  const session = await requirePermission(PERMISSIONS.CUSTOM_MODULES_MANAGE);
  await prisma.customModule.update({ where: { id: moduleId }, data: { status } });
  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "CUSTOM_MODULE_STATUS_CHANGED",
      entityType: "CustomModule",
      entityId: moduleId,
      metadata: { status },
    },
  });
  revalidatePath("/admin/custom-modules");
  revalidatePath("/student/custom-module");
}

export async function syncCustomModuleQuestionsAction(moduleId: string, formData: FormData) {
  const session = await requirePermission(PERMISSIONS.CUSTOM_MODULES_MANAGE);
  const questionIds = formData.getAll("questionIds").map(String);

  await prisma.$transaction([
    prisma.customModuleQuestion.deleteMany({ where: { customModuleId: moduleId } }),
    prisma.customModuleQuestion.createMany({
      data: questionIds.map((questionId, order) => ({ customModuleId: moduleId, questionId, order })),
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "CUSTOM_MODULE_QUESTIONS_UPDATED",
      entityType: "CustomModule",
      entityId: moduleId,
      metadata: { count: questionIds.length },
    },
  });

  revalidatePath(`/admin/custom-modules/${moduleId}`);
  revalidatePath("/admin/custom-modules");
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function resolveRuleForModule(moduleId: string) {
  const customModule = await prisma.customModule.findUniqueOrThrow({ where: { id: moduleId } });
  const rule = (customModule.ruleConfig ?? {}) as {
    subjectId?: string;
    topicId?: string;
    difficulty?: QuestionDifficulty;
    count?: number;
  };

  const eligible = await prisma.question.findMany({
    where: {
      examId: customModule.examId,
      status: QuestionStatus.PUBLISHED,
      subjectId: rule.subjectId || undefined,
      topicId: rule.topicId || undefined,
      difficulty: rule.difficulty || undefined,
    },
    select: { id: true },
  });

  const selected = shuffle(eligible).slice(0, rule.count ?? 20);

  await prisma.$transaction([
    prisma.customModuleQuestion.deleteMany({ where: { customModuleId: moduleId } }),
    prisma.customModuleQuestion.createMany({
      data: selected.map((q, order) => ({ customModuleId: moduleId, questionId: q.id, order })),
    }),
  ]);
}

export async function regenerateFromRuleAction(moduleId: string) {
  const session = await requirePermission(PERMISSIONS.CUSTOM_MODULES_MANAGE);
  await resolveRuleForModule(moduleId);
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "CUSTOM_MODULE_RULE_REGENERATED", entityType: "CustomModule", entityId: moduleId },
  });
  revalidatePath(`/admin/custom-modules/${moduleId}`);
}
