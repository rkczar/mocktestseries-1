"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import { topicSchema, createTopicChecked, bulkCreateTopics, type TopicFormState, type BulkTopicFormState } from "@/lib/topic-taxonomy";
import {
  TaxonomyInUseError,
  cleanTaxonomyName,
  findOrCreateSubTopic,
  linkSubTopicToExam,
  linkTopicToExam,
  taxonomyNameKey,
  unlinkSubTopicFromExam,
  unlinkTopicFromExam,
} from "@/lib/exam-taxonomy";

export type { TopicFormState, BulkTopicFormState };

function revalidateTopicPages() {
  revalidatePath("/admin/exams");
  revalidatePath("/admin/exams/topics");
  revalidatePath("/admin/exams/syllabus");
  revalidatePath("/admin/questions/add");
  revalidatePath("/admin/custom-modules");
  revalidatePath("/student/exams/[examId]", "page");
}

/**
 * Creates one canonical topic under a subject and, with an exam context,
 * links it to that exam. A normalized duplicate is never created — the
 * existing topic comes back as `existing` so the UI can offer "Use Existing".
 */
export async function createTopicAction(_prev: TopicFormState, formData: FormData): Promise<TopicFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = topicSchema.safeParse({ subjectId: formData.get("subjectId"), name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const examId = String(formData.get("examId") ?? "") || undefined;

  const result = await prisma.$transaction(async (tx) => {
    const r = await createTopicChecked(tx, parsed.data.subjectId, parsed.data.name);
    if ("topic" in r && examId) await linkTopicToExam(tx, examId, r.topic.id);
    return r;
  });
  if ("error" in result) return { error: result.error, existing: result.existing };

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TOPIC_CREATED", entityType: "Topic", entityId: result.topic.id, metadata: { examId: examId ?? null } },
  });

  revalidateTopicPages();
  return { success: true };
}

/** Links an existing canonical topic (and its subject) to an exam — "Use Existing". */
export async function linkTopicAction(examId: string, topicId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  await prisma.$transaction((tx) => linkTopicToExam(tx, examId, topicId));
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "EXAM_TOPIC_LINKED", entityType: "Exam", entityId: examId, metadata: { topicId } },
  });
  revalidateTopicPages();
}

/**
 * Bulk Add Topics — one topic name per line, de-duped and validated by
 * bulkCreateTopics (lib/topic-taxonomy.ts). No cap on how many topics can be
 * added. With an exam context, existing duplicates are linked, not copied.
 */
export async function bulkCreateTopicsAction(subjectId: string, namesText: string, examId?: string): Promise<BulkTopicFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const outcome = await bulkCreateTopics(subjectId, namesText, examId || undefined);

  if (outcome.result && (outcome.result.added.length > 0 || (outcome.result.linkedExisting?.length ?? 0) > 0)) {
    await prisma.auditLog.create({
      data: {
        actorId: session.user.id,
        action: "TOPIC_BULK_CREATED",
        entityType: "Subject",
        entityId: subjectId,
        metadata: { examId: examId ?? null, count: outcome.result.added.length, names: outcome.result.added, linkedExisting: outcome.result.linkedExisting ?? [] },
      },
    });
  }

  revalidateTopicPages();
  return outcome;
}

const editTopicSchema = z.object({
  id: z.string().min(1),
  examId: z.string().optional(),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
  order: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

export interface EditTopicFormState {
  error?: string;
  success?: boolean;
}

/** Renames the canonical topic (every linking exam sees it) and, with an exam context, sets that exam's display order. */
export async function editTopicAction(_prev: EditTopicFormState, formData: FormData): Promise<EditTopicFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = editTopicSchema.safeParse({
    id: formData.get("id"),
    examId: formData.get("examId") || undefined,
    name: formData.get("name"),
    order: formData.get("order"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, examId, name, order } = parsed.data;

  const current = await prisma.topic.findUnique({ where: { id }, select: { subjectId: true } });
  if (!current) return { error: "Topic not found." };
  const nameKey = taxonomyNameKey(name);
  const clash = await prisma.topic.findFirst({ where: { subjectId: current.subjectId, nameKey, id: { not: id } }, select: { name: true } });
  if (clash) return { error: `"${clash.name}" already exists under this subject — rename refused (no automatic merge).` };

  await prisma.$transaction(async (tx) => {
    await tx.topic.update({ where: { id }, data: { name: cleanTaxonomyName(name), nameKey } });
    if (examId) await tx.examTopic.updateMany({ where: { examId, topicId: id }, data: { displayOrder: order } });
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TOPIC_UPDATED", entityType: "Topic", entityId: id },
  });

  revalidateTopicPages();
  return { success: true };
}

/** Deletes a MASTER topic — refused while any exam links it or anything is classified under it. */
export async function deleteTopicAction(topicId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const [links, subTopicCount, questionCount] = await Promise.all([
    prisma.examTopic.count({ where: { topicId } }),
    prisma.subTopic.count({ where: { topicId } }),
    prisma.question.count({ where: { topicId } }),
  ]);
  if (links > 0) {
    throw new Error(`This master topic is still linked to ${links} exam${links === 1 ? "" : "s"}. Use "Remove from Exam" on each first.`);
  }
  if (subTopicCount > 0 || questionCount > 0) {
    throw new Error("Cannot delete a topic that has sub-topics or questions. Remove those first.");
  }

  await prisma.topic.delete({ where: { id: topicId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "TOPIC_DELETED", entityType: "Topic", entityId: topicId },
  });

  revalidateTopicPages();
}

/** "Remove from Exam" for a topic (and its sub-topic links) — the master topic stays. */
export async function unlinkTopicAction(examId: string, topicId: string): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  try {
    await prisma.$transaction((tx) => unlinkTopicFromExam(tx, examId, topicId));
  } catch (err) {
    if (err instanceof TaxonomyInUseError) return { error: err.message };
    throw err;
  }
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "EXAM_TOPIC_UNLINKED", entityType: "Exam", entityId: examId, metadata: { topicId } },
  });
  revalidateTopicPages();
  return {};
}

const subTopicSchema = z.object({
  topicId: z.string().min(1),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
});

/**
 * Adds a sub-topic: an existing canonical sub-topic with the same normalized
 * name under this topic is reused (`existed: true`), never duplicated. With
 * an exam context the (new or existing) sub-topic is linked to that exam.
 */
export async function createSubTopicAction(topicId: string, name: string, examId?: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = subTopicSchema.safeParse({ topicId, name });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");

  const outcome = await prisma.$transaction(async (tx) => {
    const r = await findOrCreateSubTopic(tx, parsed.data.topicId, parsed.data.name);
    if (examId) await linkSubTopicToExam(tx, examId, r.record.id);
    return r;
  });
  if (outcome.created) {
    await prisma.auditLog.create({
      data: { actorId: session.user.id, action: "SUBTOPIC_CREATED", entityType: "SubTopic", entityId: outcome.record.id, metadata: { examId: examId ?? null } },
    });
  }

  revalidateTopicPages();
  return { ...outcome.record, existed: !outcome.created };
}

/** Links an existing canonical sub-topic to an exam (Use Existing). */
export async function linkSubTopicAction(examId: string, subTopicId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  await prisma.$transaction((tx) => linkSubTopicToExam(tx, examId, subTopicId));
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "EXAM_SUBTOPIC_LINKED", entityType: "Exam", entityId: examId, metadata: { subTopicId } },
  });
  revalidateTopicPages();
}

/** "Remove from Exam" for a sub-topic — the master stays. */
export async function unlinkSubTopicAction(examId: string, subTopicId: string): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  try {
    await prisma.$transaction((tx) => unlinkSubTopicFromExam(tx, examId, subTopicId));
  } catch (err) {
    if (err instanceof TaxonomyInUseError) return { error: err.message };
    throw err;
  }
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "EXAM_SUBTOPIC_UNLINKED", entityType: "Exam", entityId: examId, metadata: { subTopicId } },
  });
  revalidateTopicPages();
  return {};
}

/** Deletes a MASTER sub-topic — refused while any exam links it or any question uses it. */
export async function deleteSubTopicAction(subTopicId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const [links, questionCount] = await Promise.all([
    prisma.examSubTopic.count({ where: { subTopicId } }),
    prisma.question.count({ where: { subTopicId } }),
  ]);
  if (links > 0) {
    throw new Error(`This master sub-topic is still linked to ${links} exam${links === 1 ? "" : "s"}. Remove it from each exam first.`);
  }
  if (questionCount > 0) {
    throw new Error("Cannot delete a sub-topic that has questions. Remove those first.");
  }

  await prisma.subTopic.delete({ where: { id: subTopicId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBTOPIC_DELETED", entityType: "SubTopic", entityId: subTopicId },
  });

  revalidateTopicPages();
}
