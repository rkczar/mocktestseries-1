"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

const topicSchema = z.object({
  subjectId: z.string().min(1, "Select a subject"),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
});

export interface TopicFormState {
  error?: string;
  success?: boolean;
}

function revalidateTopicPages() {
  revalidatePath("/admin/exams/topics");
  revalidatePath("/admin/questions/add");
  revalidatePath("/admin/custom-modules");
}

export async function createTopicAction(_prev: TopicFormState, formData: FormData): Promise<TopicFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = topicSchema.safeParse({ subjectId: formData.get("subjectId"), name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const topic = await prisma.topic.create({ data: parsed.data });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TOPIC_CREATED", entityType: "Topic", entityId: topic.id },
  });

  revalidateTopicPages();
  return { success: true };
}

export async function deleteTopicAction(topicId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const [subTopicCount, questionCount] = await Promise.all([
    prisma.subTopic.count({ where: { topicId } }),
    prisma.question.count({ where: { topicId } }),
  ]);
  if (subTopicCount > 0 || questionCount > 0) {
    throw new Error("Cannot delete a topic that has sub-topics or questions. Remove those first.");
  }

  await prisma.topic.delete({ where: { id: topicId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TOPIC_DELETED", entityType: "Topic", entityId: topicId },
  });

  revalidateTopicPages();
}

const subTopicSchema = z.object({
  topicId: z.string().min(1),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
});

export async function createSubTopicAction(topicId: string, name: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = subTopicSchema.safeParse({ topicId, name });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const subTopic = await prisma.subTopic.create({ data: parsed.data });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBTOPIC_CREATED", entityType: "SubTopic", entityId: subTopic.id },
  });

  revalidateTopicPages();
  return subTopic;
}

export async function deleteSubTopicAction(subTopicId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const questionCount = await prisma.question.count({ where: { subTopicId } });
  if (questionCount > 0) {
    throw new Error("Cannot delete a sub-topic that has questions. Remove those first.");
  }

  await prisma.subTopic.delete({ where: { id: subTopicId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBTOPIC_DELETED", entityType: "SubTopic", entityId: subTopicId },
  });

  revalidateTopicPages();
}
