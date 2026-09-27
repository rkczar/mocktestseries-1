import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Canonical, reusable Subject -> Topic -> SubTopic taxonomy.
 *
 * Each Subject/Topic/SubTopic exists once (unique normalized `nameKey` per
 * parent) and an Exam *uses* it through ExamSubject / ExamTopic /
 * ExamSubTopic link rows. Everything that needs "the taxonomy of exam X"
 * goes through the helpers here, so every consumer (Exam management,
 * Question Bank, Bulk Import, Custom Module, Subject Test, student filters)
 * cascades the same way: Exam -> linked Subject -> linked Topic -> linked
 * SubTopic.
 *
 * Linking never copies a record and unlinking never deletes one. Shared
 * taxonomy is NOT shared questions — questions keep their own examId.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** Duplicate-detection key: trimmed, whitespace-collapsed, lower-cased. Mirrors the SQL backfill in the canonical-taxonomy migration. */
export function taxonomyNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Display form of a new name: trimmed with inner whitespace collapsed. Casing is the admin's own. */
export function cleanTaxonomyName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export const examSubjectWhere = (examId: string): Prisma.SubjectWhereInput => ({ examLinks: { some: { examId, isActive: true } } });
export const examTopicWhere = (examId: string): Prisma.TopicWhereInput => ({ examLinks: { some: { examId, isActive: true } } });
export const examSubTopicWhere = (examId: string): Prisma.SubTopicWhereInput => ({ examLinks: { some: { examId, isActive: true } } });

export interface ExamTaxonomySubTopic {
  id: string;
  name: string;
  topicId: string;
}
export interface ExamTaxonomyTopic {
  id: string;
  name: string;
  subjectId: string;
  syllabusDescription: string | null;
  subTopics: ExamTaxonomySubTopic[];
}
export interface ExamTaxonomySubject {
  id: string;
  name: string;
  syllabusDescription: string | null;
  topics: ExamTaxonomyTopic[];
}

/** Subjects linked to an exam, in the exam's display order. */
export async function getExamSubjects(db: Db, examId: string): Promise<{ id: string; name: string }[]> {
  const links = await db.examSubject.findMany({
    where: { examId, isActive: true },
    orderBy: [{ displayOrder: "asc" }, { subject: { name: "asc" } }],
    select: { subject: { select: { id: true, name: true } } },
  });
  return links.map((l) => l.subject);
}

/** Full linked tree for one exam (Subject -> Topic -> SubTopic), each level in the exam's display order. */
export async function getExamTaxonomy(db: Db, examId: string): Promise<ExamTaxonomySubject[]> {
  const [subjectLinks, topicLinks, subTopicLinks] = await Promise.all([
    db.examSubject.findMany({
      where: { examId, isActive: true },
      orderBy: [{ displayOrder: "asc" }, { subject: { name: "asc" } }],
      select: { subject: { select: { id: true, name: true, syllabusDescription: true } } },
    }),
    db.examTopic.findMany({
      where: { examId, isActive: true },
      orderBy: [{ displayOrder: "asc" }, { topic: { name: "asc" } }],
      select: { topic: { select: { id: true, name: true, subjectId: true, syllabusDescription: true } } },
    }),
    db.examSubTopic.findMany({
      where: { examId, isActive: true },
      orderBy: [{ displayOrder: "asc" }, { subTopic: { name: "asc" } }],
      select: { subTopic: { select: { id: true, name: true, topicId: true } } },
    }),
  ]);

  const subTopicsByTopic = new Map<string, ExamTaxonomySubTopic[]>();
  for (const { subTopic } of subTopicLinks) {
    const list = subTopicsByTopic.get(subTopic.topicId) ?? [];
    list.push(subTopic);
    subTopicsByTopic.set(subTopic.topicId, list);
  }
  const topicsBySubject = new Map<string, ExamTaxonomyTopic[]>();
  for (const { topic } of topicLinks) {
    const list = topicsBySubject.get(topic.subjectId) ?? [];
    list.push({ ...topic, subTopics: subTopicsByTopic.get(topic.id) ?? [] });
    topicsBySubject.set(topic.subjectId, list);
  }
  return subjectLinks.map(({ subject }) => ({ ...subject, topics: topicsBySubject.get(subject.id) ?? [] }));
}

/**
 * Attaches each exam's linked taxonomy as `subjects` — the same shape the
 * old `include: { subjects: { include: { topics: { include: { subTopics } } } } }`
 * produced, so admin pickers that switch exam client-side keep working.
 */
export async function withExamTaxonomy<T extends { id: string }>(db: Db, exams: T[]): Promise<(T & { subjects: ExamTaxonomySubject[] })[]> {
  return Promise.all(exams.map(async (exam) => ({ ...exam, subjects: await getExamTaxonomy(db, exam.id) })));
}

/** Cheap "is this record linked to (usable by) exam Y" checks. */
export async function isSubjectLinked(db: Pick<Db, "examSubject">, examId: string, subjectId: string): Promise<boolean> {
  const link = await db.examSubject.findUnique({ where: { examId_subjectId: { examId, subjectId } }, select: { isActive: true } });
  return Boolean(link?.isActive);
}
export async function isTopicLinked(db: Pick<Db, "examTopic">, examId: string, topicId: string): Promise<boolean> {
  const link = await db.examTopic.findUnique({ where: { examId_topicId: { examId, topicId } }, select: { isActive: true } });
  return Boolean(link?.isActive);
}
export async function isSubTopicLinked(db: Pick<Db, "examSubTopic">, examId: string, subTopicId: string): Promise<boolean> {
  const link = await db.examSubTopic.findUnique({ where: { examId_subTopicId: { examId, subTopicId } }, select: { isActive: true } });
  return Boolean(link?.isActive);
}

// ---------------------------------------------------------------------------
// Linking (idempotent upserts — never creates master records)
// ---------------------------------------------------------------------------

export async function linkSubjectToExam(db: Db, examId: string, subjectId: string): Promise<boolean> {
  const existing = await db.examSubject.findUnique({ where: { examId_subjectId: { examId, subjectId } } });
  if (existing) {
    if (!existing.isActive) await db.examSubject.update({ where: { id: existing.id }, data: { isActive: true } });
    return !existing.isActive;
  }
  const last = await db.examSubject.aggregate({ where: { examId }, _max: { displayOrder: true } });
  await db.examSubject.create({ data: { examId, subjectId, displayOrder: (last._max.displayOrder ?? -1) + 1 } });
  return true;
}

/** Links a topic (and, if needed, its subject) to the exam. */
export async function linkTopicToExam(db: Db, examId: string, topicId: string): Promise<boolean> {
  const topic = await db.topic.findUnique({ where: { id: topicId }, select: { subjectId: true } });
  if (!topic) throw new Error("Topic not found");
  await linkSubjectToExam(db, examId, topic.subjectId);
  const existing = await db.examTopic.findUnique({ where: { examId_topicId: { examId, topicId } } });
  if (existing) {
    if (!existing.isActive) await db.examTopic.update({ where: { id: existing.id }, data: { isActive: true } });
    return !existing.isActive;
  }
  const last = await db.examTopic.aggregate({ where: { examId, topic: { subjectId: topic.subjectId } }, _max: { displayOrder: true } });
  await db.examTopic.create({ data: { examId, topicId, displayOrder: (last._max.displayOrder ?? -1) + 1 } });
  return true;
}

/** Links a sub-topic (and, if needed, its topic and subject) to the exam. */
export async function linkSubTopicToExam(db: Db, examId: string, subTopicId: string): Promise<boolean> {
  const subTopic = await db.subTopic.findUnique({ where: { id: subTopicId }, select: { topicId: true } });
  if (!subTopic) throw new Error("Sub-topic not found");
  await linkTopicToExam(db, examId, subTopic.topicId);
  const existing = await db.examSubTopic.findUnique({ where: { examId_subTopicId: { examId, subTopicId } } });
  if (existing) {
    if (!existing.isActive) await db.examSubTopic.update({ where: { id: existing.id }, data: { isActive: true } });
    return !existing.isActive;
  }
  const last = await db.examSubTopic.aggregate({ where: { examId, subTopic: { topicId: subTopic.topicId } }, _max: { displayOrder: true } });
  await db.examSubTopic.create({ data: { examId, subTopicId, displayOrder: (last._max.displayOrder ?? -1) + 1 } });
  return true;
}

// ---------------------------------------------------------------------------
// Unlinking ("Remove from Exam") — deletes link rows only, never masters.
// Refused while the exam still has questions classified under the item, so
// no question of that exam is left pointing at taxonomy its exam no longer
// shows.
// ---------------------------------------------------------------------------

export class TaxonomyInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxonomyInUseError";
  }
}

export async function unlinkSubjectFromExam(db: Db, examId: string, subjectId: string): Promise<void> {
  const inUse = await db.question.count({ where: { examId, subjectId } });
  if (inUse > 0) {
    throw new TaxonomyInUseError(`${inUse} question${inUse === 1 ? "" : "s"} of this exam use this subject — reclassify or remove them first.`);
  }
  await db.examSubTopic.deleteMany({ where: { examId, subTopic: { topic: { subjectId } } } });
  await db.examTopic.deleteMany({ where: { examId, topic: { subjectId } } });
  await db.examSubject.deleteMany({ where: { examId, subjectId } });
}

export async function unlinkTopicFromExam(db: Db, examId: string, topicId: string): Promise<void> {
  const inUse = await db.question.count({ where: { examId, topicId } });
  if (inUse > 0) {
    throw new TaxonomyInUseError(`${inUse} question${inUse === 1 ? "" : "s"} of this exam use this topic — reclassify or remove them first.`);
  }
  await db.examSubTopic.deleteMany({ where: { examId, subTopic: { topicId } } });
  await db.examTopic.deleteMany({ where: { examId, topicId } });
}

export async function unlinkSubTopicFromExam(db: Db, examId: string, subTopicId: string): Promise<void> {
  const inUse = await db.question.count({ where: { examId, subTopicId } });
  if (inUse > 0) {
    throw new TaxonomyInUseError(`${inUse} question${inUse === 1 ? "" : "s"} of this exam use this sub-topic — reclassify or remove them first.`);
  }
  await db.examSubTopic.deleteMany({ where: { examId, subTopicId } });
}

// ---------------------------------------------------------------------------
// Create-or-reuse with duplicate protection. `created: false` means a
// canonical record with the same normalized name already existed and was
// returned instead — callers surface it as "Use Existing", never a copy.
// ---------------------------------------------------------------------------

export type CreateOutcome<T> = { created: true; record: T } | { created: false; record: T };

export async function findOrCreateSubject(
  db: Db,
  name: string,
  originExamId: string | null
): Promise<CreateOutcome<{ id: string; name: string }>> {
  const clean = cleanTaxonomyName(name);
  const nameKey = taxonomyNameKey(clean);
  const existing = await db.subject.findUnique({ where: { nameKey }, select: { id: true, name: true } });
  if (existing) return { created: false, record: existing };
  const record = await db.subject.create({ data: { name: clean, nameKey, originExamId }, select: { id: true, name: true } });
  return { created: true, record };
}

export async function findOrCreateTopic(db: Db, subjectId: string, name: string): Promise<CreateOutcome<{ id: string; name: string }>> {
  const clean = cleanTaxonomyName(name);
  const nameKey = taxonomyNameKey(clean);
  const existing = await db.topic.findUnique({ where: { subjectId_nameKey: { subjectId, nameKey } }, select: { id: true, name: true } });
  if (existing) return { created: false, record: existing };
  const record = await db.topic.create({ data: { subjectId, name: clean, nameKey }, select: { id: true, name: true } });
  return { created: true, record };
}

export async function findOrCreateSubTopic(db: Db, topicId: string, name: string): Promise<CreateOutcome<{ id: string; name: string }>> {
  const clean = cleanTaxonomyName(name);
  const nameKey = taxonomyNameKey(clean);
  const existing = await db.subTopic.findUnique({ where: { topicId_nameKey: { topicId, nameKey } }, select: { id: true, name: true } });
  if (existing) return { created: false, record: existing };
  const record = await db.subTopic.create({ data: { topicId, name: clean, nameKey }, select: { id: true, name: true } });
  return { created: true, record };
}

/** Per-exam question counts keyed by subject / topic id (master `_count` would count every exam's questions). */
export async function examQuestionCounts(db: Db, examId: string) {
  const [bySubject, byTopic, bySubTopic] = await Promise.all([
    db.question.groupBy({ by: ["subjectId"], where: { examId }, _count: { _all: true } }),
    db.question.groupBy({ by: ["topicId"], where: { examId, topicId: { not: null } }, _count: { _all: true } }),
    db.question.groupBy({ by: ["subTopicId"], where: { examId, subTopicId: { not: null } }, _count: { _all: true } }),
  ]);
  return {
    subject: new Map(bySubject.map((r) => [r.subjectId, r._count._all])),
    topic: new Map(byTopic.map((r) => [r.topicId!, r._count._all])),
    subTopic: new Map(bySubTopic.map((r) => [r.subTopicId!, r._count._all])),
  };
}

/** Whole canonical tree with, per record, the exams that link it — backs "Add Existing" / "Use Taxonomy From Existing Exam". */
export async function getMasterTaxonomy(db: Db) {
  const linkIds = { where: { isActive: true }, select: { examId: true } } as const;
  const subjects = await db.subject.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      examLinks: linkIds,
      topics: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          examLinks: linkIds,
          subTopics: { orderBy: { name: "asc" }, select: { id: true, name: true, examLinks: linkIds } },
        },
      },
    },
  });
  const ids = (links: { examId: string }[]) => links.map((l) => l.examId);
  return subjects.map((s) => ({
    id: s.id,
    name: s.name,
    examIds: ids(s.examLinks),
    topics: s.topics.map((t) => ({
      id: t.id,
      name: t.name,
      examIds: ids(t.examLinks),
      subTopics: t.subTopics.map((st) => ({ id: st.id, name: st.name, examIds: ids(st.examLinks) })),
    })),
  }));
}
