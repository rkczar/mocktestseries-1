"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/rbac";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Server actions specific to Admin -> Exams -> Syllabus. The taxonomy itself
 * (Subject/Topic/SubTopic add/delete) is NOT duplicated here — those actions
 * already exist in ../subjects/actions.ts and ../topics/actions.ts and are
 * reused directly from the syllabus page. This file only owns what's
 * genuinely syllabus-specific: the enabled flag, the three description
 * fields, and reordering.
 */

function revalidateSyllabusSurfaces(examId: string) {
  revalidatePath("/admin/exams/syllabus");
  revalidatePath("/admin/website/diagram");
  revalidatePath("/student/exams/[examId]", "page");
  void examId; // kept for signature symmetry / future per-exam revalidation (e.g. ISR tags)
}

export async function toggleSyllabusEnabledAction(examId: string, enabled: boolean) {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const exam = await prisma.exam.update({ where: { id: examId }, data: { syllabusEnabled: enabled } });

  await prisma.auditLog.create({
    data: {
      actorId: session.user.id,
      action: enabled ? "SYLLABUS_ENABLED" : "SYLLABUS_DISABLED",
      entityType: "Exam",
      entityId: exam.id,
    },
  });

  revalidateSyllabusSurfaces(examId);
}

const descriptionSchema = z.string().trim().max(20000).optional();

export interface DescriptionFormState {
  error?: string;
  success?: boolean;
}

export async function updateExamSyllabusDescriptionAction(
  _prev: DescriptionFormState,
  formData: FormData
): Promise<DescriptionFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const examId = String(formData.get("examId") ?? "");
  if (!examId) return { error: "Missing exam" };
  const parsed = descriptionSchema.safeParse(formData.get("description"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  await prisma.exam.update({ where: { id: examId }, data: { syllabusDescription: parsed.data || null } });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SYLLABUS_EXAM_DESCRIPTION_UPDATED", entityType: "Exam", entityId: examId },
  });

  revalidateSyllabusSurfaces(examId);
  return { success: true };
}

export async function updateSubjectSyllabusDescriptionAction(
  _prev: DescriptionFormState,
  formData: FormData
): Promise<DescriptionFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const subjectId = String(formData.get("subjectId") ?? "");
  if (!subjectId) return { error: "Missing subject" };
  const parsed = descriptionSchema.safeParse(formData.get("description"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const subject = await prisma.subject.update({
    where: { id: subjectId },
    data: { syllabusDescription: parsed.data || null },
  });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SYLLABUS_SUBJECT_DESCRIPTION_UPDATED", entityType: "Subject", entityId: subjectId },
  });

  revalidateSyllabusSurfaces(subject.examId);
  return { success: true };
}

export async function updateTopicSyllabusDescriptionAction(
  _prev: DescriptionFormState,
  formData: FormData
): Promise<DescriptionFormState> {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const topicId = String(formData.get("topicId") ?? "");
  if (!topicId) return { error: "Missing topic" };
  const parsed = descriptionSchema.safeParse(formData.get("description"));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const topic = await prisma.topic.update({
    where: { id: topicId },
    data: { syllabusDescription: parsed.data || null },
    include: { subject: true },
  });
  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SYLLABUS_TOPIC_DESCRIPTION_UPDATED", entityType: "Topic", entityId: topicId },
  });

  revalidateSyllabusSurfaces(topic.subject.examId);
  return { success: true };
}

/**
 * Reordering swaps two siblings' `order` after normalizing the whole list to
 * its currently-displayed 0..n-1 order — safe even though most existing rows
 * still share the schema default of `order: 0` (never reordered before).
 */
export async function moveSubjectAction(examId: string, subjectId: string, direction: "up" | "down") {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const subjects = await prisma.subject.findMany({ where: { examId }, orderBy: [{ order: "asc" }, { name: "asc" }] });
  const from = subjects.findIndex((s) => s.id === subjectId);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= subjects.length) return;

  await prisma.$transaction(subjects.map((s, i) => prisma.subject.update({ where: { id: s.id }, data: { order: i } })));
  await prisma.$transaction([
    prisma.subject.update({ where: { id: subjects[from].id }, data: { order: to } }),
    prisma.subject.update({ where: { id: subjects[to].id }, data: { order: from } }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SYLLABUS_SUBJECT_REORDERED", entityType: "Subject", entityId: subjectId },
  });
  revalidateSyllabusSurfaces(examId);
}

export async function moveTopicAction(examId: string, subjectId: string, topicId: string, direction: "up" | "down") {
  const session = await requirePermission(PERMISSIONS.EXAMS_MANAGE);
  const topics = await prisma.topic.findMany({ where: { subjectId }, orderBy: [{ order: "asc" }, { name: "asc" }] });
  const from = topics.findIndex((t) => t.id === topicId);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= topics.length) return;

  await prisma.$transaction(topics.map((t, i) => prisma.topic.update({ where: { id: t.id }, data: { order: i } })));
  await prisma.$transaction([
    prisma.topic.update({ where: { id: topics[from].id }, data: { order: to } }),
    prisma.topic.update({ where: { id: topics[to].id }, data: { order: from } }),
  ]);

  await prisma.auditLog.create({
    data: { actorId: session.user.id, action: "SYLLABUS_TOPIC_REORDERED", entityType: "Topic", entityId: topicId },
  });
  revalidateSyllabusSurfaces(examId);
}
