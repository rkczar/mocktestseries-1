"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { LiveTestStatus, AttemptStatus, QuestionDifficulty, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { parseIstDateTimeLocal } from "@/lib/ist-time";
import { deriveLiveTestState } from "@/lib/live-test";
import { reconcileExpiredAttempts } from "@/lib/test-attempt";
import { selectPublishedQuestions, assertValidOwnershipChain, InsufficientQuestionsError } from "@/lib/question-selection";

const blueprintLineSchema = z.object({
  subjectId: z.string().min(1),
  topicId: z.string().optional(),
  subTopicId: z.string().optional(),
  difficulty: z.array(z.nativeEnum(QuestionDifficulty)).optional(),
  count: z.number().int().min(1),
});

type BlueprintLine = z.infer<typeof blueprintLineSchema>;

const liveTestSchema = z.object({
  examId: z.string().min(1, "Select an exam."),
  title: z.string().trim().min(2, "Title is required."),
  description: z.string().trim().optional(),
  startAt: z.string().min(1, "Start time is required."),
  endAt: z.string().min(1, "End time is required."),
  studentDurationMinutes: z.coerce.number().int().min(1, "Duration must be at least 1 minute."),
  negativeMarking: z.coerce.number().min(0).max(1),
  instructions: z.string().trim().optional(),
  accessType: z.enum(["FREE", "PAID"]),
  questionCount: z.coerce.number().int().min(1, "Question count must be at least 1."),
  blueprint: z.string().min(1, "Add at least one blueprint row."),
});

export interface LiveTestFormState {
  error?: string;
  success?: boolean;
}

async function validateAndBuild(formData: FormData) {
  const parsed = liveTestSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input." } as const;

  const startAt = parseIstDateTimeLocal(parsed.data.startAt);
  const endAt = parseIstDateTimeLocal(parsed.data.endAt);
  if (!startAt || !endAt) return { error: "Invalid start/end time." } as const;
  if (endAt.getTime() <= startAt.getTime()) return { error: "Ends At must be after Starts At." } as const;

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
      startAt,
      endAt,
      studentDurationMinutes: parsed.data.studentDurationMinutes,
      negativeMarking: parsed.data.negativeMarking,
      instructions: parsed.data.instructions,
      accessType: parsed.data.accessType,
      questionCount: parsed.data.questionCount,
      blueprint: lines,
    },
  } as const;
}

export async function createLiveTestAction(_prev: LiveTestFormState, formData: FormData): Promise<LiveTestFormState> {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const result = await validateAndBuild(formData);
  if ("error" in result) return { error: result.error };
  const { data } = result;

  const liveTest = await prisma.liveTest.create({
    data: {
      examId: data.examId,
      title: data.title,
      description: data.description,
      startAt: data.startAt,
      endAt: data.endAt,
      studentDurationMinutes: data.studentDurationMinutes,
      negativeMarking: data.negativeMarking,
      instructions: data.instructions,
      accessType: data.accessType,
      questionCount: data.questionCount,
      blueprint: data.blueprint as unknown as Prisma.InputJsonValue,
      status: LiveTestStatus.DRAFT,
      createdByAdminId: session.user.id,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "LIVE_TEST_CREATED", entityType: "LiveTest", entityId: liveTest.id },
  });

  revalidatePath("/admin/tests/live");
  return { success: true };
}

export async function updateLiveTestAction(
  liveTestId: string,
  _prev: LiveTestFormState,
  formData: FormData
): Promise<LiveTestFormState> {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const existing = await prisma.liveTest.findUnique({ where: { id: liveTestId }, select: { status: true } });
  if (!existing) return { error: "Live test not found." };
  if (existing.status !== LiveTestStatus.DRAFT) {
    return { error: "Only a draft live test can be edited — lock, cancel, and result actions are the only changes allowed afterward." };
  }

  const result = await validateAndBuild(formData);
  if ("error" in result) return { error: result.error };
  const { data } = result;

  await prisma.liveTest.update({
    where: { id: liveTestId },
    data: {
      examId: data.examId,
      title: data.title,
      description: data.description,
      startAt: data.startAt,
      endAt: data.endAt,
      studentDurationMinutes: data.studentDurationMinutes,
      negativeMarking: data.negativeMarking,
      instructions: data.instructions,
      accessType: data.accessType,
      questionCount: data.questionCount,
      blueprint: data.blueprint as unknown as Prisma.InputJsonValue,
    },
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "LIVE_TEST_UPDATED", entityType: "LiveTest", entityId: liveTestId },
  });

  revalidatePath("/admin/tests/live");
  revalidatePath(`/admin/tests/live/${liveTestId}`);
  return { success: true };
}

/**
 * Resolve the blueprint into a concrete, ordered question set and freeze it
 * into LiveTestQuestion — once, for every student — then lock the test into
 * SCHEDULED. Mirrors publishGrandTestAction exactly; see that file for the
 * overlap/insufficient-pool reasoning. From here, LIVE/ENDED are derived
 * from server time (lib/live-test.ts) — nothing further needs to be
 * persisted as the window opens and closes.
 */
export async function lockLiveTestAction(liveTestId: string, _prev: LiveTestFormState, _formData: FormData): Promise<LiveTestFormState> {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const liveTest = await prisma.liveTest.findUnique({ where: { id: liveTestId } });
  if (!liveTest) return { error: "Live test not found." };
  if (liveTest.status !== LiveTestStatus.DRAFT) return { error: "Only a draft live test can be locked." };
  if (liveTest.endAt.getTime() <= Date.now()) {
    return { error: "This test's Ends At is already in the past — edit the schedule before locking." };
  }

  const lines = (liveTest.blueprint ?? []) as unknown as BlueprintLine[];
  if (lines.length === 0) return { error: "This live test has no blueprint to resolve." };

  const resolvedQuestionIds: string[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      const { questions } = await selectPublishedQuestions({
        examId: liveTest.examId,
        subjectId: line.subjectId,
        topicId: line.topicId || undefined,
        subTopicId: line.subTopicId || undefined,
        difficulty: line.difficulty && line.difficulty.length > 0 ? line.difficulty : undefined,
        count: line.count,
      });
      resolvedQuestionIds.push(...questions.map((q) => q.id));
    } catch (error) {
      if (error instanceof InsufficientQuestionsError) return { error: `Blueprint row ${index + 1}: ${error.message}` };
      return { error: error instanceof Error ? error.message : "Failed to resolve blueprint." };
    }
  }

  const uniqueQuestionIds = Array.from(new Set(resolvedQuestionIds));
  if (uniqueQuestionIds.length !== resolvedQuestionIds.length) {
    return {
      error:
        "Blueprint rows overlap and selected the same question more than once. Narrow the topic/sub-topic filters on each row so their pools don't overlap, then lock again.",
    };
  }

  await prisma.$transaction([
    prisma.liveTestQuestion.deleteMany({ where: { liveTestId } }),
    prisma.liveTestQuestion.createMany({
      data: uniqueQuestionIds.map((questionId, order) => ({ liveTestId, questionId, order })),
    }),
    prisma.liveTest.update({ where: { id: liveTestId }, data: { status: LiveTestStatus.SCHEDULED, publishedAt: new Date() } }),
  ]);

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: "LIVE_TEST_LOCKED",
      entityType: "LiveTest",
      entityId: liveTestId,
      metadata: { questionCount: uniqueQuestionIds.length },
    },
  });

  revalidatePath("/admin/tests/live");
  revalidatePath(`/admin/tests/live/${liveTestId}`);
  revalidatePath("/student/live-tests");
  return { success: true };
}

/** Cancels a locked-but-not-yet-ended live test. Every in-progress attempt is abandoned so it can never be edited further. */
export async function cancelLiveTestAction(liveTestId: string) {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const liveTest = await prisma.liveTest.findUnique({ where: { id: liveTestId } });
  if (!liveTest) return;
  if (liveTest.status !== LiveTestStatus.SCHEDULED) return;

  await prisma.$transaction([
    prisma.testAttempt.updateMany({
      where: { liveTestId, status: AttemptStatus.IN_PROGRESS },
      data: { status: AttemptStatus.ABANDONED },
    }),
    prisma.liveTest.update({ where: { id: liveTestId }, data: { status: LiveTestStatus.CANCELLED } }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "LIVE_TEST_CANCELLED", entityType: "LiveTest", entityId: liveTestId },
  });

  revalidatePath("/admin/tests/live");
  revalidatePath(`/admin/tests/live/${liveTestId}`);
  revalidatePath("/student/live-tests");
}

/** Ends a currently-LIVE test early by pulling its global endAt forward to now — a hard cutoff for everyone. */
export async function endLiveTestAction(liveTestId: string) {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const liveTest = await prisma.liveTest.findUnique({ where: { id: liveTestId } });
  if (!liveTest) return;
  const state = deriveLiveTestState(liveTest, new Date());
  if (state !== "LIVE") return;

  await prisma.liveTest.update({ where: { id: liveTestId }, data: { endAt: new Date() } });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "LIVE_TEST_ENDED_EARLY", entityType: "LiveTest", entityId: liveTestId },
  });

  revalidatePath("/admin/tests/live");
  revalidatePath(`/admin/tests/live/${liveTestId}`);
  revalidatePath("/student/live-tests");
}

/** Publishes results — only once the test has genuinely ended by server time, so a review/answer key can never leak early. */
export async function publishLiveTestResultAction(liveTestId: string) {
  const session = await requirePermission(PERMISSIONS.TESTS_MANAGE);

  const liveTest = await prisma.liveTest.findUnique({ where: { id: liveTestId } });
  if (!liveTest) return;
  const state = deriveLiveTestState(liveTest, new Date());
  if (state !== "ENDED") return;

  // Settle every still-dangling attempt before publishing, so the result set is final and consistent.
  await reconcileExpiredAttempts({ liveTestId });
  await prisma.liveTest.update({ where: { id: liveTestId }, data: { status: LiveTestStatus.RESULT_PUBLISHED } });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "LIVE_TEST_RESULT_PUBLISHED", entityType: "LiveTest", entityId: liveTestId },
  });

  revalidatePath("/admin/tests/live");
  revalidatePath(`/admin/tests/live/${liveTestId}`);
  revalidatePath("/student/live-tests");
}

/** Manual "safe scheduled reconciliation" trigger — sweeps this test's dangling IN_PROGRESS attempts now, instead of waiting for the next read. */
export async function reconcileLiveTestAction(liveTestId: string): Promise<{ finalized: number }> {
  await requirePermission(PERMISSIONS.TESTS_MANAGE);
  const finalized = await reconcileExpiredAttempts({ liveTestId });
  revalidatePath(`/admin/tests/live/${liveTestId}`);
  return { finalized };
}
