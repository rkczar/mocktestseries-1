import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
}

export interface BulkTopicResult {
  added: string[];
  duplicates: string[];
  failed: { name: string; reason: string }[];
}

export interface BulkTopicFormState {
  error?: string;
  result?: BulkTopicResult;
}

type Db = Pick<Prisma.TransactionClient, "topic">;

/** Creates one topic under a subject, rejecting an exact (case-insensitive) duplicate for that same subject. */
export async function createTopicChecked(db: Db, subjectId: string, name: string): Promise<{ error: string } | { topic: { id: string; name: string } }> {
  const existing = await db.topic.findFirst({ where: { subjectId, name: { equals: name, mode: "insensitive" } } });
  if (existing) return { error: `"${name}" already exists under this subject.` };
  const topic = await db.topic.create({ data: { subjectId, name } });
  return { topic };
}

/**
 * Bulk Add Topics — one topic name per line. Skips blank lines, de-dupes
 * case-insensitively both within the pasted batch and against topics that
 * already exist under this subject, and creates the rest in a single
 * transaction. No cap on how many topics can be added — only the per-name
 * length guard above applies.
 */
export async function bulkCreateTopics(subjectId: string, namesText: string): Promise<BulkTopicFormState> {
  if (!subjectId) return { error: "Select a subject" };

  const rawLines = namesText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) return { error: "Paste at least one topic name." };

  const existingTopics = await prisma.topic.findMany({ where: { subjectId }, select: { name: true } });
  const existingNamesLower = new Set(existingTopics.map((t) => t.name.toLowerCase()));

  const seenInBatch = new Set<string>();
  const toCreate: string[] = [];
  const duplicates: string[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const name of rawLines) {
    const parsed = topicNameSchema.safeParse(name);
    if (!parsed.success) {
      failed.push({ name, reason: parsed.error.issues[0]?.message ?? "Invalid name" });
      continue;
    }
    const key = parsed.data.toLowerCase();
    if (existingNamesLower.has(key) || seenInBatch.has(key)) {
      duplicates.push(parsed.data);
      continue;
    }
    seenInBatch.add(key);
    toCreate.push(parsed.data);
  }

  if (toCreate.length > 0) {
    await prisma.$transaction(toCreate.map((name) => prisma.topic.create({ data: { subjectId, name } })));
  }

  return { result: { added: toCreate, duplicates, failed } };
}
