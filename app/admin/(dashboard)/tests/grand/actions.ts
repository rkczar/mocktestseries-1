"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { GrandTestStatus, QuestionDifficulty, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { selectPublishedQuestions, assertValidOwnershipChain, InsufficientQuestionsError } from "@/lib/question-selection";

const blueprintLineSchema = z.object({
  subjectId: z.string().min(1),
  topicId: z.string().optional(),
  subTopicId: z.string().optional(),
  difficulty: z.array(z.nativeEnum(QuestionDifficulty)).optional(),
  count: z.number().int().min(1),
});

type BlueprintLine = z.infer<typeof blueprintLineSchema>;

const grandTestSchema = z.object({
  examId: z.string().min(1, "Select an exam."),
  title: z.string().trim().min(2, "Title is required."),
  description: z.string().trim().optional(),
  durationMinutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute."),
  negativeMarking: z.coerce.number().min(0).max(1),
  instructions: z.string().trim().optional(),
  accessType: z.enum(["FREE", "PAID"]),
  questionCount: z.coerce.number().int().min(1, "Question count must be at least 1."),
  blueprint: z.string().min(1, "Add at least one blueprint row."),
});

export interface GrandTestFormState {
  error?: string;
  success?: boolean;
}

/**
 * Parse + fully validate the submitted form, including the blueprint JSON
 * and its exam→subject→topic→sub-topic ownership chain (every line, not
 * just the top-level examId) — a Grand Test blueprint that let one exam
 * pull another exam's subjects would be exactly the cross-exam corruption
 * the question-bank foundation guards against elsewhere.
 */
async function validateAndBuild(formData: FormData) {
  const parsed = grandTestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." } as const;

  let rawBlueprint: unknown;
  try {
    rawBlueprint = JSON.parse(parsed.data.blueprint);
  } catch {
    return { error: "Blueprint could not be read — please rebuild it." } as const;
  }

  const blueprintResult = z.array(blueprintLineSchema).min(1, "Add at least one blueprint row.").safeParse(rawBlueprint);
  if (!blueprintResult.success) {
    return { error: blueprintResult.error.issues[0]?.message ?? "Invalid blueprint." } as const;
  }
  const lines = blueprintResult.data;

  const total = lines.reduce((sum, l) => sum + l.count, 0);
  if (total !== parsed.data.questionCount) {
    return { error: `Blueprint totals ${total} questions but Question Count is ${parsed.data.questionCount}.` } as const;
  }

  try {
    for (const line of lines) {
      await assertValidOwnershipChain({
        examId: parsed.data.examId,
        subjectId: line.subjectId,
        topicId: line.topicId || null,
        subTopicId: line.subTopicId || null,
      });
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Invalid blueprint hierarchy." } as const;
  }

  return {
    data: {
      examId: parsed.data.examId,
      title: parsed.data.title,
      description: parsed.data.description,
      durationMinutes: parsed.data.durationMinutes,
      negativeMarking: parsed.data.negativeMarking,
      instructions: parsed.data.instructions,
      accessType: parsed.data.accessType,
      questionCount: parsed.data.questionCount,
      blueprint: lines,
    },
  } as const;
}

export async function createGrandTestAction(
  _prev: GrandTestFormState,
  formData: FormData
): Promise<GrandTestFormState> {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const result = await validateAndBuild(formData);
  if ("error" in result) return { error: result.error };
  const { data } = result;

  const grandTest = await prisma.grandTest.create({
    data: {
      examId: data.examId,
      title: data.title,
      description: data.description,
      durationMinutes: data.durationMinutes,
      negativeMarking: data.negativeMarking,
      instructions: data.instructions,
      accessType: data.accessType,
      questionCount: data.questionCount,
      blueprint: data.blueprint as unknown as Prisma.InputJsonValue,
      status: GrandTestStatus.DRAFT,
      createdByAdminId: session.user.id,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "GRAND_TEST_CREATED", entityType: "GrandTest", entityId: grandTest.id },
  });

  revalidatePath("/admin/tests/grand");
  return { success: true };
}

export async function updateGrandTestAction(
  grandTestId: string,
  _prev: GrandTestFormState,
  formData: FormData
): Promise<GrandTestFormState> {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const existing = await prisma.grandTest.findUnique({ where: { id: grandTestId }, select: { status: true } });
  if (!existing) return { error: "Grand test not found." };
  if (existing.status !== GrandTestStatus.DRAFT) {
    return { error: "Published or archived grand tests cannot be edited — archive is the only state change allowed." };
  }

  const result = await validateAndBuild(formData);
  if ("error" in result) return { error: result.error };
  const { data } = result;

  await prisma.grandTest.update({
    where: { id: grandTestId },
    data: {
      examId: data.examId,
      title: data.title,
      description: data.description,
      durationMinutes: data.durationMinutes,
      negativeMarking: data.negativeMarking,
      instructions: data.instructions,
      accessType: data.accessType,
      questionCount: data.questionCount,
      blueprint: data.blueprint as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "GRAND_TEST_UPDATED", entityType: "GrandTest", entityId: grandTestId },
  });

  revalidatePath("/admin/tests/grand");
  revalidatePath(`/admin/tests/grand/${grandTestId}`);
  return { success: true };
}

/**
 * Resolve the blueprint into a concrete, ordered question set and freeze it
 * into GrandTestQuestion — once, for every student. Never re-run per
 * attempt; startGrandTestAttempt only ever reads what's persisted here.
 */
export async function publishGrandTestAction(
  grandTestId: string,
  _prev: GrandTestFormState,
  _formData: FormData
): Promise<GrandTestFormState> {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const grandTest = await prisma.grandTest.findUnique({ where: { id: grandTestId } });
  if (!grandTest) return { error: "Grand test not found." };
  if (grandTest.status !== GrandTestStatus.DRAFT) {
    return { error: "Only a draft grand test can be published." };
  }

  const lines = (grandTest.blueprint ?? []) as unknown as BlueprintLine[];
  if (lines.length === 0) return { error: "This grand test has no blueprint to resolve." };

  const resolvedQuestionIds: string[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const { questions } = await selectPublishedQuestions({
        examId: grandTest.examId,
        subjectId: line.subjectId,
        topicId: line.topicId || undefined,
        subTopicId: line.subTopicId || undefined,
        difficulty: line.difficulty && line.difficulty.length > 0 ? line.difficulty : undefined,
        count: line.count,
      });
      resolvedQuestionIds.push(...questions.map((q) => q.id));
    } catch (error) {
      if (error instanceof InsufficientQuestionsError) {
        return { error: `Blueprint row ${index + 1}: ${error.message}` };
      }
      return { error: error instanceof Error ? error.message : "Failed to resolve blueprint." };
    }
  }

  // Blueprint rows are resolved independently, so overlapping filters (e.g. a
  // subject-only row and a topic-scoped row under the same subject) can draw
  // the same question twice. Fail loudly rather than silently under-filling
  // the test or hitting the GrandTestQuestion unique constraint mid-transaction.
  const uniqueQuestionIds = Array.from(new Set(resolvedQuestionIds));
  if (uniqueQuestionIds.length !== resolvedQuestionIds.length) {
    return {
      error:
        "Blueprint rows overlap and selected the same question more than once. Narrow the topic/sub-topic filters on each row so their pools don't overlap, then publish again.",
    };
  }

  await prisma.$transaction([
    prisma.grandTestQuestion.deleteMany({ where: { grandTestId } }),
    prisma.grandTestQuestion.createMany({
      data: uniqueQuestionIds.map((questionId, order) => ({ grandTestId, questionId, order })),
    }),
    prisma.grandTest.update({
      where: { id: grandTestId },
      data: { status: GrandTestStatus.PUBLISHED, publishedAt: new Date() },
    }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "GRAND_TEST_PUBLISHED",
      entityType: "GrandTest",
      entityId: grandTestId,
      metadata: { questionCount: uniqueQuestionIds.length },
    },
  });

  revalidatePath("/admin/tests/grand");
  revalidatePath(`/admin/tests/grand/${grandTestId}`);
  revalidatePath("/student/exams");
  return { success: true };
}

/** Hides a published Grand Test from students without deleting any data. */
export async function archiveGrandTestAction(grandTestId: string) {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const existing = await prisma.grandTest.findUnique({ where: { id: grandTestId }, select: { status: true } });
  if (!existing || existing.status !== GrandTestStatus.PUBLISHED) return;

  await prisma.grandTest.update({ where: { id: grandTestId }, data: { status: GrandTestStatus.ARCHIVED } });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "GRAND_TEST_ARCHIVED", entityType: "GrandTest", entityId: grandTestId },
  });

  revalidatePath("/admin/tests/grand");
  revalidatePath(`/admin/tests/grand/${grandTestId}`);
  revalidatePath("/student/exams");
}
