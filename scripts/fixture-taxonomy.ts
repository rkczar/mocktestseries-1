/**
 * Disposable-fixture helpers for the canonical taxonomy (see
 * lib/exam-taxonomy.ts). Verify scripts used to create a Subject "under" a
 * throwaway exam and rely on the exam's cascade to delete it; subjects are
 * now shared masters linked through ExamSubject/ExamTopic/ExamSubTopic and
 * deleting an exam deliberately never deletes them.
 *
 * So fixtures: (1) create each subject with a fixture-scoped nameKey
 * ("fixture:<examId>:<name>") — it can never collide with, or be mistaken
 * for, a real master subject such as "Anatomy" — and link it to its exam;
 * (2) call deleteFixtureTaxonomy(examIds) BEFORE deleting the exams, which
 * removes only subjects whose origin exam is one of those fixture exams.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { taxonomyNameKey } from "../lib/exam-taxonomy";

type Db = PrismaClient | Prisma.TransactionClient;

export async function createFixtureSubject(
  db: Db,
  data: { examId: string; name: string; order?: number; syllabusDescription?: string | null }
) {
  const { examId, ...rest } = data;
  return db.subject.create({
    data: {
      ...rest,
      originExamId: examId,
      nameKey: `fixture:${examId}:${taxonomyNameKey(data.name)}`,
      examLinks: { create: { examId, displayOrder: data.order ?? 0 } },
    },
  });
}

/** Topic under a fixture subject, linked to the subject's (fixture) origin exam. */
export async function createFixtureTopic(db: Db, data: { subjectId: string; name: string; order?: number; syllabusDescription?: string | null }) {
  const subject = await db.subject.findUniqueOrThrow({ where: { id: data.subjectId }, select: { originExamId: true } });
  return db.topic.create({
    data: {
      ...data,
      nameKey: taxonomyNameKey(data.name),
      ...(subject.originExamId ? { examLinks: { create: { examId: subject.originExamId, displayOrder: data.order ?? 0 } } } : {}),
    },
  });
}

/** Sub-topic under a fixture topic, linked to the fixture exam. */
export async function createFixtureSubTopic(db: Db, data: { topicId: string; name: string; order?: number }) {
  const topic = await db.topic.findUniqueOrThrow({ where: { id: data.topicId }, select: { subject: { select: { originExamId: true } } } });
  const examId = topic.subject.originExamId;
  return db.subTopic.create({
    data: {
      ...data,
      nameKey: taxonomyNameKey(data.name),
      ...(examId ? { examLinks: { create: { examId, displayOrder: data.order ?? 0 } } } : {}),
    },
  });
}

/** Deletes the fixture subjects created under these fixture exams (topics/sub-topics/links cascade). Call before deleting the exams. */
export async function deleteFixtureTaxonomy(db: Db, examIds: string[]) {
  await db.subject.deleteMany({ where: { originExamId: { in: examIds }, nameKey: { startsWith: "fixture:" } } });
}
