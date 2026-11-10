import "server-only";
import { Prisma, type QuestionDifficulty, type QuestionType } from "@prisma/client";
import { OPTION_LABELS, type QuestionFormData, correctLabelsOf } from "@/lib/question-form-core";
import type { MatchSpec } from "@/lib/question-types";

/**
 * The editable content of a question — exactly the fields the question form
 * writes (taxonomy, stem, image, difficulty, type, match lists, options and
 * answer key). Used by the Teacher Portal for revision snapshots, staleness
 * checks (Phase A, docs/TEACHER-PORTAL.md) and the approval before/after view.
 * Status, source, PYQ link and review flags are deliberately NOT content: a
 * teacher never changes them.
 */
export interface QuestionContent {
  examId: string;
  examYear: number | null;
  subjectId: string;
  topicId: string | null;
  subTopicId: string | null;
  text: string;
  imageUrl: string | null;
  difficulty: QuestionDifficulty;
  questionType: QuestionType;
  matchSpec: MatchSpec | null;
  options: { label: string; text: string; imageUrl: string | null; isCorrect: boolean }[];
}

export const CONTENT_SELECT = {
  examId: true,
  examYear: true,
  subjectId: true,
  topicId: true,
  subTopicId: true,
  text: true,
  imageUrl: true,
  difficulty: true,
  questionType: true,
  matchSpec: true,
  options: { select: { label: true, text: true, imageUrl: true, isCorrect: true } },
} satisfies Prisma.QuestionSelect;

type ContentRow = Prisma.QuestionGetPayload<{ select: typeof CONTENT_SELECT }>;

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);

export function contentOf(q: ContentRow): QuestionContent {
  return {
    examId: q.examId,
    examYear: q.examYear,
    subjectId: q.subjectId,
    topicId: q.topicId,
    subTopicId: q.subTopicId,
    text: q.text,
    imageUrl: q.imageUrl,
    difficulty: q.difficulty,
    questionType: q.questionType,
    matchSpec: (q.matchSpec as MatchSpec | null) ?? null,
    options: [...q.options].sort(byLabel).map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl, isCorrect: o.isCorrect })),
  };
}

/** Same shape the admin form would write for `data` (lib/question-form-core.ts upsertOptions). */
export function contentFromForm(data: QuestionFormData, matchSpec: MatchSpec | null, examYear: number | null): QuestionContent {
  const correct = correctLabelsOf(data);
  const text = { A: data.optionA, B: data.optionB, C: data.optionC, D: data.optionD };
  const image = { A: data.optionAImageUrl, B: data.optionBImageUrl, C: data.optionCImageUrl, D: data.optionDImageUrl };
  return {
    examId: data.examId,
    examYear,
    subjectId: data.subjectId,
    topicId: data.topicId || null,
    subTopicId: data.subTopicId || null,
    text: data.text,
    imageUrl: data.imageUrl || null,
    difficulty: data.difficulty,
    questionType: data.questionType,
    matchSpec,
    options: OPTION_LABELS.map((label) => ({ label, text: text[label], imageUrl: image[label] || null, isCorrect: correct.includes(label) })),
  };
}

/** Key-order-independent JSON, so equal content always compares equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function sameContent(a: QuestionContent, b: QuestionContent): boolean {
  return stable(a) === stable(b);
}

export interface ContentChange {
  field: string;
  before: string;
  after: string;
}

/** Field-level before/after for the approval queue (ids are resolved to names by the caller via `names`). */
export function diffContent(before: QuestionContent | null, after: QuestionContent, names: (id: string | null) => string = (id) => id ?? "—"): ContentChange[] {
  const out: ContentChange[] = [];
  const push = (field: string, b: string, a: string) => {
    if (b !== a) out.push({ field, before: b, after: a });
  };
  const o = (c: QuestionContent | null, label: string) => c?.options.find((x) => x.label === label);
  push("Exam", before ? names(before.examId) : "", names(after.examId));
  push("Exam year", before?.examYear?.toString() ?? "", after.examYear?.toString() ?? "");
  push("Subject", before ? names(before.subjectId) : "", names(after.subjectId));
  push("Topic", before ? names(before.topicId) : "", names(after.topicId));
  push("Sub-topic", before ? names(before.subTopicId) : "", names(after.subTopicId));
  push("Question type", before?.questionType ?? "", after.questionType);
  push("Difficulty", before?.difficulty ?? "", after.difficulty);
  push("Question text", before?.text ?? "", after.text);
  push("Question image", before?.imageUrl ?? "", after.imageUrl ?? "");
  push("Match lists", before?.matchSpec ? stable(before.matchSpec) : "", after.matchSpec ? stable(after.matchSpec) : "");
  for (const label of OPTION_LABELS) {
    push(`Option ${label}`, o(before, label)?.text ?? "", o(after, label)?.text ?? "");
    push(`Option ${label} image`, o(before, label)?.imageUrl ?? "", o(after, label)?.imageUrl ?? "");
  }
  const key = (c: QuestionContent | null) => (c ? c.options.filter((x) => x.isCorrect).map((x) => x.label).join(", ") : "");
  push("Correct answer", key(before), key(after));
  return out;
}

/** Writes `content` onto an existing question (fields + options), inside the caller's transaction. */
export async function writeContent(tx: Prisma.TransactionClient, questionId: string, content: QuestionContent): Promise<void> {
  await tx.question.update({
    where: { id: questionId },
    data: {
      examId: content.examId,
      examYear: content.examYear,
      subjectId: content.subjectId,
      topicId: content.topicId,
      subTopicId: content.subTopicId,
      text: content.text,
      imageUrl: content.imageUrl,
      difficulty: content.difficulty,
      questionType: content.questionType,
      matchSpec: content.matchSpec ? (content.matchSpec as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    },
  });
  // The Hindi option text (bilingual exams) is not part of the content snapshot: carried over by label, never dropped.
  const keepHi = new Map((await tx.questionOption.findMany({ where: { questionId }, select: { label: true, textHi: true } })).map((o) => [o.label, o.textHi]));
  await tx.questionOption.deleteMany({ where: { questionId } });
  await tx.questionOption.createMany({
    data: content.options.map((op, order) => ({ questionId, label: op.label, text: op.text, textHi: keepHi.get(op.label) ?? null, imageUrl: op.imageUrl, isCorrect: op.isCorrect, order })),
  });
}

export function asJson(content: QuestionContent): Prisma.InputJsonValue {
  return content as unknown as Prisma.InputJsonValue;
}

export function readContent(json: Prisma.JsonValue): QuestionContent {
  return json as unknown as QuestionContent;
}
