"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";
import {
  TaxonomyInUseError,
  cleanTaxonomyName,
  linkSubTopicToExam,
  linkSubjectToExam,
  linkTopicToExam,
  taxonomyNameKey,
  unlinkSubjectFromExam,
} from "@/lib/exam-taxonomy";

const schema = z.object({
  examId: z.string().optional(),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
});

export interface SubjectFormState {
  error?: string;
  success?: boolean;
  /** Set when a canonical Subject with the same normalized name already exists — the UI offers "Use Existing" instead of a copy. */
  existing?: { id: string; name: string };
}

function revalidateTaxonomyPages() {
  revalidatePath("/admin/exams");
  revalidatePath("/admin/exams/subjects");
  revalidatePath("/admin/exams/topics");
  revalidatePath("/admin/exams/syllabus");
  revalidatePath("/admin/questions/add");
  revalidatePath("/admin/custom-modules");
  revalidatePath("/student/exams/[examId]", "page");
}

/**
 * Creates a canonical Subject (and links it to the exam, when given). Never
 * creates a second record for a name that already exists after
 * normalization (trim / whitespace / case) — returns it as `existing`.
 */
export async function createSubjectAction(_prev: SubjectFormState, formData: FormData): Promise<SubjectFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = schema.safeParse({ examId: formData.get("examId") || undefined, name: formData.get("name") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { examId, name } = parsed.data;

  const nameKey = taxonomyNameKey(name);
  const existing = await prisma.subject.findUnique({ where: { nameKey }, select: { id: true, name: true } });
  if (existing) {
    return { error: `"${existing.name}" already exists in the master taxonomy.`, existing };
  }

  const subject = await prisma.$transaction(async (tx) => {
    const created = await tx.subject.create({ data: { name: cleanTaxonomyName(name), nameKey, originExamId: examId ?? null } });
    if (examId) await linkSubjectToExam(tx, examId, created.id);
    return created;
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBJECT_CREATED", entityType: "Subject", entityId: subject.id, metadata: { examId: examId ?? null } },
  });

  revalidateTaxonomyPages();
  return { success: true };
}

const editSchema = z.object({
  id: z.string().min(1),
  examId: z.string().optional(),
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(120),
  order: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

/**
 * Renames the canonical Subject (visible in every exam that links it) and,
 * with an exam context, sets its display order for that exam only.
 */
export async function editSubjectAction(_prev: SubjectFormState, formData: FormData): Promise<SubjectFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = editSchema.safeParse({
    id: formData.get("id"),
    examId: formData.get("examId") || undefined,
    name: formData.get("name"),
    order: formData.get("order"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, examId, name, order } = parsed.data;

  const nameKey = taxonomyNameKey(name);
  const clash = await prisma.subject.findFirst({ where: { nameKey, id: { not: id } }, select: { id: true, name: true } });
  if (clash) return { error: `"${clash.name}" already exists in the master taxonomy — rename refused (no automatic merge).` };

  await prisma.$transaction(async (tx) => {
    await tx.subject.update({ where: { id }, data: { name: cleanTaxonomyName(name), nameKey } });
    if (examId) await tx.examSubject.updateMany({ where: { examId, subjectId: id }, data: { displayOrder: order } });
  });

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBJECT_UPDATED", entityType: "Subject", entityId: id },
  });

  revalidateTaxonomyPages();
  return { success: true };
}

/**
 * Deletes a MASTER Subject. Refused while anything references it — any
 * exam link, topic, question or attempt — so shared taxonomy can never be
 * deleted out from under another exam. "Remove from Exam" is the normal
 * per-exam action (unlinkSubjectAction).
 */
export async function deleteSubjectAction(subjectId: string) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);

  const [links, topicCount, questionCount, attemptCount] = await Promise.all([
    prisma.examSubject.count({ where: { subjectId } }),
    prisma.topic.count({ where: { subjectId } }),
    prisma.question.count({ where: { subjectId } }),
    prisma.testAttempt.count({ where: { subjectId } }),
  ]);
  if (links > 0) {
    throw new Error(`This master subject is still linked to ${links} exam${links === 1 ? "" : "s"}. Use "Remove from Exam" on each first.`);
  }
  if (topicCount > 0 || questionCount > 0 || attemptCount > 0) {
    throw new Error("Cannot delete a master subject that has topics, questions or test attempts.");
  }

  await prisma.subject.delete({ where: { id: subjectId } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SUBJECT_DELETED", entityType: "Subject", entityId: subjectId },
  });

  revalidateTaxonomyPages();
}

/** "Remove from Exam": deletes the exam's links to this subject (and its topics/sub-topics) — never the master. */
export async function unlinkSubjectAction(examId: string, subjectId: string): Promise<{ error?: string }> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  try {
    await prisma.$transaction((tx) => unlinkSubjectFromExam(tx, examId, subjectId));
  } catch (err) {
    if (err instanceof TaxonomyInUseError) return { error: err.message };
    throw err;
  }
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "EXAM_SUBJECT_UNLINKED", entityType: "Exam", entityId: examId, metadata: { subjectId } },
  });
  revalidateTaxonomyPages();
  return {};
}

const linkSchema = z.object({
  examId: z.string().min(1),
  subjectIds: z.array(z.string().min(1)).max(5000).default([]),
  topicIds: z.array(z.string().min(1)).max(20000).default([]),
  subTopicIds: z.array(z.string().min(1)).max(50000).default([]),
});

export interface LinkTaxonomyResult {
  error?: string;
  linked?: { subjects: number; topics: number; subTopics: number };
}

/**
 * Add Existing Subject / Use Taxonomy From Existing Exam / Use Existing:
 * creates LINK rows only (idempotent), cascading upward so a linked topic's
 * subject is always linked too. Never creates or copies a master record.
 */
export async function linkTaxonomyAction(input: {
  examId: string;
  subjectIds?: string[];
  topicIds?: string[];
  subTopicIds?: string[];
  sourceExamId?: string;
}): Promise<LinkTaxonomyResult> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const parsed = linkSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid selection" };
  const { examId, subjectIds, topicIds, subTopicIds } = parsed.data;

  const exam = await prisma.exam.findUnique({ where: { id: examId }, select: { id: true } });
  if (!exam) return { error: "Exam not found." };

  const linked = { subjects: 0, topics: 0, subTopics: 0 };
  await prisma.$transaction(
    async (tx) => {
      for (const id of subjectIds) if (await linkSubjectToExam(tx, examId, id)) linked.subjects++;
      for (const id of topicIds) if (await linkTopicToExam(tx, examId, id)) linked.topics++;
      for (const id of subTopicIds) if (await linkSubTopicToExam(tx, examId, id)) linked.subTopics++;
    },
    { timeout: 120_000 }
  );

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: input.sourceExamId ? "EXAM_TAXONOMY_REUSED" : "EXAM_TAXONOMY_LINKED",
      entityType: "Exam",
      entityId: examId,
      metadata: { sourceExamId: input.sourceExamId ?? null, requested: { subjects: subjectIds.length, topics: topicIds.length, subTopics: subTopicIds.length }, linked },
    },
  });

  revalidateTaxonomyPages();
  return { linked };
}
