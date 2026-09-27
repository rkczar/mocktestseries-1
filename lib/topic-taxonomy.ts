import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanTaxonomyName, linkTopicToExam, taxonomyNameKey } from "@/lib/exam-taxonomy";

// 500 is a generous, DB-safe ceiling (Topic.name is a Postgres TEXT column
// with no inherent length limit) — it exists only to reject pathological
// input, never to block a real topic name (Section: Admin -> Exams ->
// Topics fix). Do not lower this back toward anything that could clip an
// ordinary medical/scientific topic title.
export const TOPIC_NAME_MAX_LENGTH = 500;

export const topicNameSchema = z.string().trim().min(1, "Topic name cannot be empty.").max(TOPIC_NAME_MAX_LENGTH);

export const topicSchema = z.object({
  subjectId: z.string().min(1, "Select a subject"),
  name: topicNameSchema,
});

export interface TopicFormState {
  error?: string;
  success?: boolean;
  /** Canonical topic that already exists under the subject (normalized name) — offered as "Use Existing". */
  existing?: { id: string; name: string };
}

export interface BulkTopicResult {
  added: string[];
  duplicates: string[];
  /** Already-existing canonical topics that were (re)linked to the exam instead of duplicated. */
  linkedExisting?: string[];
  failed: { name: string; reason: string }[];
}

export interface BulkTopicFormState {
  error?: string;
  result?: BulkTopicResult;
}

type Db = Pick<Prisma.TransactionClient, "topic">;

/**
 * Creates one canonical topic under a subject, rejecting a normalized
 * (trim / whitespace / case-insensitive) duplicate for that same subject —
 * the existing record is returned so the caller can offer "Use Existing".
 */
export async function createTopicChecked(
  db: Db,
  subjectId: string,
  name: string
): Promise<{ error: string; existing?: { id: string; name: string } } | { topic: { id: string; name: string } }> {
  const nameKey = taxonomyNameKey(name);
  const existing = await db.topic.findUnique({ where: { subjectId_nameKey: { subjectId, nameKey } }, select: { id: true, name: true } });
  if (existing) return { error: `"${existing.name}" already exists under this subject.`, existing };
  const topic = await db.topic.create({ data: { subjectId, name: cleanTaxonomyName(name), nameKey }, select: { id: true, name: true } });
  return { topic };
}

/**
 * Bulk Add Topics — one topic name per line. Skips blank lines, de-dupes
 * by normalized name both within the pasted batch and against the
 * subject's existing canonical topics, and creates the rest in a single
 * transaction. With an exam context, new topics are linked to that exam and
 * existing duplicates are linked (never copied). No cap on how many topics
 * can be added — only the per-name length guard above applies.
 */
export async function bulkCreateTopics(subjectId: string, namesText: string, examId?: string): Promise<BulkTopicFormState> {
  if (!subjectId) return { error: "Select a subject" };

  const rawLines = namesText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) return { error: "Paste at least one topic name." };

  const existingTopics = await prisma.topic.findMany({ where: { subjectId }, select: { id: true, name: true, nameKey: true } });
  const existingByKey = new Map(existingTopics.map((t) => [t.nameKey, t]));

  const seenInBatch = new Set<string>();
  const toCreate: string[] = [];
  const duplicates: string[] = [];
  const toLink: { id: string; name: string }[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const name of rawLines) {
    const parsed = topicNameSchema.safeParse(name);
    if (!parsed.success) {
      failed.push({ name, reason: parsed.error.issues[0]?.message ?? "Invalid name" });
      continue;
    }
    const key = taxonomyNameKey(parsed.data);
    if (seenInBatch.has(key)) {
      duplicates.push(parsed.data);
      continue;
    }
    seenInBatch.add(key);
    const existing = existingByKey.get(key);
    if (existing) {
      duplicates.push(parsed.data);
      if (examId) toLink.push(existing);
      continue;
    }
    toCreate.push(cleanTaxonomyName(parsed.data));
  }

  const linkedExisting: string[] = [];
  await prisma.$transaction(async (tx) => {
    for (const name of toCreate) {
      const topic = await tx.topic.create({ data: { subjectId, name, nameKey: taxonomyNameKey(name) } });
      if (examId) await linkTopicToExam(tx, examId, topic.id);
    }
    if (examId) {
      for (const t of toLink) if (await linkTopicToExam(tx, examId, t.id)) linkedExisting.push(t.name);
    }
  }, { timeout: 60_000 });

  return { result: { added: toCreate, duplicates, linkedExisting, failed } };
}
