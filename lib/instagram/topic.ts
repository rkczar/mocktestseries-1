import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { TOPIC_LIMITS, type SourceSnapshot } from "@/lib/instagram/types";

/**
 * TOPIC posts: a carousel about one topic (no source question). The topic is
 * entered by an admin and frozen into a SourceSnapshot of kind "topic", so the
 * editor, renderer, AI Studio, quality gate, revisions and publisher work on it
 * unchanged. Nothing here reads or writes the Question Bank except the exam /
 * subject names used for the slide header.
 */

export interface TopicInput {
  title: string;
  examId: string;
  subjectName?: string;
  notes?: string;
}

/** Collapses whitespace; the stored title is exactly what the slides show. */
export function cleanTopicTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Stable identity of a topic: exam + normalized title. Same topic typed twice → same key → the existing post opens. */
export function topicKeyFor(examId: string, title: string): string {
  const norm = cleanTopicTitle(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `${examId}:${crypto.createHash("sha256").update(norm).digest("hex").slice(0, 24)}`;
}

export function validateTopicInput(input: TopicInput): string | null {
  const title = cleanTopicTitle(input.title ?? "");
  if (title.length < 3) return "Enter the topic (at least 3 characters).";
  if (title.length > TOPIC_LIMITS.title) return `The topic is too long (${title.length}/${TOPIC_LIMITS.title} characters).`;
  if ((input.notes ?? "").length > TOPIC_LIMITS.notes) return `Source notes are too long (${(input.notes ?? "").length}/${TOPIC_LIMITS.notes} characters).`;
  if ((input.subjectName ?? "").length > 80) return "The subject name is too long.";
  if (!input.examId) return "Choose the exam this topic is for.";
  return null;
}

/** Hash of everything the post states about its topic (the topic snapshot never changes after creation). */
export function hashTopic(s: Pick<SourceSnapshot, "text" | "examName" | "subjectName" | "notes">): string {
  return crypto.createHash("sha256").update(JSON.stringify({ k: "topic", t: s.text, e: s.examName, s: s.subjectName, n: s.notes ?? "" })).digest("hex");
}

export async function buildTopicSnapshot(input: TopicInput): Promise<{ snapshot: SourceSnapshot; hash: string; topicKey: string } | null> {
  const exam = await prisma.exam.findUnique({ where: { id: input.examId }, select: { id: true, name: true, code: true } });
  if (!exam) return null;
  const title = cleanTopicTitle(input.title);
  const snapshot: SourceSnapshot = {
    kind: "topic",
    notes: (input.notes ?? "").trim(),
    questionId: "",
    code: `TOPIC`,
    text: title,
    contentFormat: "PLAIN",
    questionType: "TOPIC",
    options: [],
    examId: exam.id,
    examName: exam.name,
    examCode: exam.code,
    paperId: null,
    paperTitle: null,
    paperYear: null,
    paperCode: null,
    paperSharesYear: false,
    importPosition: null,
    subjectName: cleanTopicTitle(input.subjectName ?? "") || title,
    topicName: cleanTopicTitle(input.subjectName ?? "") ? title : null,
    hasImages: false,
    status: "PUBLISHED",
    reviewRequired: false,
    reviewReason: null,
    aiExplanation: null,
    capturedAt: new Date().toISOString(),
  };
  return { snapshot, hash: hashTopic(snapshot), topicKey: topicKeyFor(exam.id, title) };
}
