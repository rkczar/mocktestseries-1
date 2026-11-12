import "server-only";
import { z } from "zod";
import { Prisma, QuestionDifficulty, QuestionSource, QuestionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isSubjectLinked, isTopicLinked, isSubTopicLinked } from "@/lib/exam-taxonomy";
import { correctCountIssue, matchAssetKey, matchSpecIssues, parseMatchLines, QUESTION_TYPES, type MatchSpec } from "@/lib/question-types";
import { publishRefusal } from "@/lib/question-publish-policy";

/**
 * Single-question form core, shared by Admin → Question Bank
 * (app/admin/(dashboard)/questions/actions.ts) and the Teacher Portal
 * (lib/teacher/content.ts). Moved here unchanged from the admin actions file
 * so both paths validate and write a question exactly the same way.
 */

export const OPTION_LABELS = ["A", "B", "C", "D"] as const;

/**
 * Options may be text-only, image-only, or both — never neither. The
 * per-field `min(1)` requirement that used to force every option to have
 * text was dropped in favor of the cross-field check in `.superRefine`
 * below, now that QuestionOption.imageUrl is a real, user-facing field.
 */
export const questionSchema = z
  .object({
    examId: z.string().min(1, "Select an exam."),
    examYear: z.string().optional().transform(val => val ? parseInt(val, 10) : undefined),
    subjectId: z.string().min(1, "Select a subject."),
    topicId: z.string().optional(),
    subTopicId: z.string().optional(),
    previousYearPaperId: z.string().optional(),
    source: z.nativeEnum(QuestionSource).optional(),
    text: z.string().trim().min(3, "Question text is required."),
    imageUrl: z.string().trim().optional().default(""),
    difficulty: z.nativeEnum(QuestionDifficulty),
    status: z.nativeEnum(QuestionStatus),
    optionA: z.string().trim().optional().default(""),
    optionAImageUrl: z.string().trim().optional().default(""),
    optionB: z.string().trim().optional().default(""),
    optionBImageUrl: z.string().trim().optional().default(""),
    optionC: z.string().trim().optional().default(""),
    optionCImageUrl: z.string().trim().optional().default(""),
    optionD: z.string().trim().optional().default(""),
    optionDImageUrl: z.string().trim().optional().default(""),
    // NEET Phase 4. Missing = SINGLE_CORRECT, so the legacy form posts exactly as before.
    questionType: z.enum(QUESTION_TYPES).optional().default("SINGLE_CORRECT"),
    correctOption: z.enum(OPTION_LABELS).optional(),
    correctOptions: z.array(z.enum(OPTION_LABELS)).optional().default([]),
    matchListI: z.string().optional().default(""),
    matchListII: z.string().optional().default(""),
    reviewRequired: z.string().optional(),
    reviewReason: z.string().trim().max(500).optional().default(""),
    // Admin form only: "on" keeps the question out of automatically generated practice (lib/question-selection.ts).
    excludeFromPractice: z.string().optional(),
    excludeFromPracticeReason: z.string().trim().max(300).optional().default(""),
  })
  .superRefine((data, ctx) => {
    const pairs: [(typeof OPTION_LABELS)[number], string, string][] = [
      ["A", data.optionA, data.optionAImageUrl],
      ["B", data.optionB, data.optionBImageUrl],
      ["C", data.optionC, data.optionCImageUrl],
      ["D", data.optionD, data.optionDImageUrl],
    ];
    for (const [label, text, imageUrl] of pairs) {
      if (!text.trim() && !imageUrl.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Option ${label} needs text, an image, or both.`,
          path: [`option${label}`],
        });
      }
    }
    const correct = correctLabelsOf(data);
    // A WITHDRAWN question (official key withdrew it) has no correct option: saving its content never forces one.
    const issue = data.status === QuestionStatus.WITHDRAWN && correct.length === 0 ? null : correctCountIssue(data.questionType, correct.length, OPTION_LABELS.length);
    if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ["correctOption"] });
    if (data.questionType === "MULTIPLE_CORRECT" && new Set(data.correctOptions).size !== data.correctOptions.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A correct option is listed twice.", path: ["correctOptions"] });
    }
  });

export type QuestionFormData = z.infer<typeof questionSchema>;

/** The correct labels the form submitted: the radio (single / match) or the checkbox set (multiple). */
export function correctLabelsOf(data: Pick<QuestionFormData, "questionType" | "correctOption" | "correctOptions">): string[] {
  if (data.questionType === "MULTIPLE_CORRECT") return [...new Set(data.correctOptions)];
  return data.correctOption ? [data.correctOption] : [];
}

/**
 * MATCH_THE_FOLLOWING: List I / List II textareas → a validated spec. Entry
 * images (LIST_ITEM assets, added from the preview's media manager) count as
 * content, so an image-only entry is allowed once its image exists.
 */
export async function matchSpecFromForm(data: QuestionFormData, questionId: string | null): Promise<{ spec: MatchSpec | null; error?: string }> {
  if (data.questionType !== "MATCH_THE_FOLLOWING") return { spec: null };
  const listI = parseMatchLines(data.matchListI);
  const listII = parseMatchLines(data.matchListII);
  const lineIssue = listI.issues[0] ?? listII.issues[0];
  if (lineIssue) return { spec: null, error: lineIssue };
  const spec: MatchSpec = { v: 1, listI: listI.entries, listII: listII.entries };
  const images = questionId
    ? await prisma.questionAsset.findMany({ where: { questionId, role: "LIST_ITEM" }, select: { listKey: true } })
    : [];
  const issues = matchSpecIssues(spec, new Set(images.map((a) => a.listKey ?? "")));
  return issues.length ? { spec: null, error: issues[0] } : { spec };
}

/** Keeps the image check honest: every LIST_ITEM key must still name an entry. */
export async function orphanListImages(questionId: string, spec: MatchSpec | null): Promise<string[]> {
  const images = await prisma.questionAsset.findMany({ where: { questionId, role: "LIST_ITEM" }, select: { listKey: true } });
  const keys = new Set(spec ? [...spec.listI.map((e) => matchAssetKey("I", e.key)), ...spec.listII.map((e) => matchAssetKey("II", e.key))] : []);
  return images.map((a) => a.listKey ?? "").filter((k) => !keys.has(k));
}

/**
 * Legacy random code — kept only as a fallback for the no-year edge case
 * (exam and linked paper both lack a year, so a canonical code can't be
 * built). New questions with a resolvable year get canonical codes via
 * lib/question-code.ts. Remove once the Question Bank UI requires a year.
 */
export function legacyQuestionCode() {
  return `Q-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

export function parseQuestionForm(formData: FormData) {
  return questionSchema.safeParse({
    examId: formData.get("examId"),
    examYear: formData.get("examYear") || undefined,
    subjectId: formData.get("subjectId"),
    topicId: formData.get("topicId") || undefined,
    subTopicId: formData.get("subTopicId") || undefined,
    previousYearPaperId: formData.get("previousYearPaperId") || undefined,
    source: formData.get("source") || undefined,
    text: formData.get("text"),
    imageUrl: formData.get("imageUrl") || undefined,
    difficulty: formData.get("difficulty"),
    status: formData.get("status"),
    optionA: formData.get("optionA") || "",
    optionAImageUrl: formData.get("optionAImageUrl") || "",
    optionB: formData.get("optionB") || "",
    optionBImageUrl: formData.get("optionBImageUrl") || "",
    optionC: formData.get("optionC") || "",
    optionCImageUrl: formData.get("optionCImageUrl") || "",
    optionD: formData.get("optionD") || "",
    optionDImageUrl: formData.get("optionDImageUrl") || "",
    correctOption: formData.get("correctOption") || undefined,
    questionType: formData.get("questionType") || undefined,
    correctOptions: formData.getAll("correctOptions"),
    matchListI: formData.get("matchListI") || "",
    matchListII: formData.get("matchListII") || "",
    reviewRequired: formData.get("reviewRequired") || undefined,
    reviewReason: formData.get("reviewReason") || undefined,
    excludeFromPractice: formData.get("excludeFromPractice") || undefined,
    excludeFromPracticeReason: formData.get("excludeFromPracticeReason") || "",
  });
}

export type HierarchyDb = Pick<Prisma.TransactionClient, "subject" | "topic" | "subTopic" | "examSubject" | "examTopic" | "examSubTopic">;

/**
 * Server-side guard against cross-exam hierarchy corruption (e.g. a question
 * for one exam referencing a Subject/Topic/SubTopic that belongs to another
 * exam). Bulk Import already enforces this via chained lookups; this mirrors
 * that check for the single-question create/edit path, which previously
 * trusted client-side dropdown filtering only.
 */
export async function assertHierarchyConsistency(
  db: HierarchyDb,
  params: { examId: string; subjectId: string; topicId?: string | null; subTopicId?: string | null }
): Promise<string | null> {
  // Canonical taxonomy: "belongs to the exam" = linked to it (ExamSubject /
  // ExamTopic / ExamSubTopic), on top of the Subject -> Topic -> SubTopic chain.
  const subject = await db.subject.findUnique({ where: { id: params.subjectId }, select: { id: true } });
  if (!subject) return "Selected subject was not found.";
  if (!(await isSubjectLinked(db, params.examId, params.subjectId))) {
    return "Selected subject is not linked to the selected exam.";
  }

  if (params.topicId) {
    const topic = await db.topic.findUnique({ where: { id: params.topicId }, select: { subjectId: true } });
    if (!topic) return "Selected topic was not found.";
    if (topic.subjectId !== params.subjectId) return "Selected topic does not belong to the selected subject.";
    if (!(await isTopicLinked(db, params.examId, params.topicId))) {
      return "Selected topic is not linked to the selected exam.";
    }
  }

  if (params.subTopicId) {
    const subTopic = await db.subTopic.findUnique({ where: { id: params.subTopicId }, select: { topicId: true } });
    if (!subTopic) return "Selected sub-topic was not found.";
    if (!params.topicId || subTopic.topicId !== params.topicId) {
      return "Selected sub-topic does not belong to the selected topic.";
    }
    if (!(await isSubTopicLinked(db, params.examId, params.subTopicId))) {
      return "Selected sub-topic is not linked to the selected exam.";
    }
  }

  return null;
}

export async function upsertOptions(
  db: Pick<Prisma.TransactionClient, "questionOption">,
  questionId: string,
  data: QuestionFormData
) {
  const correct = correctLabelsOf(data);
  const byLabel: Record<(typeof OPTION_LABELS)[number], { text: string; imageUrl: string | null }> = {
    A: { text: data.optionA, imageUrl: data.optionAImageUrl || null },
    B: { text: data.optionB, imageUrl: data.optionBImageUrl || null },
    C: { text: data.optionC, imageUrl: data.optionCImageUrl || null },
    D: { text: data.optionD, imageUrl: data.optionDImageUrl || null },
  };

  // A bilingual question's Hindi option text is not on this form: carried over by label, never dropped by an edit.
  const keepHi = new Map((await db.questionOption.findMany({ where: { questionId }, select: { label: true, textHi: true } })).map((o) => [o.label, o.textHi]));
  await db.questionOption.deleteMany({ where: { questionId } });
  await db.questionOption.createMany({
    data: OPTION_LABELS.map((label, order) => ({
      questionId,
      label,
      text: byLabel[label].text,
      textHi: keepHi.get(label) ?? null,
      imageUrl: byLabel[label].imageUrl,
      isCorrect: correct.includes(label),
      order,
    })),
  });
}

/** True if the question text or any option's text/correctness actually changed — see updateQuestionAction's cache-staleness flag. */
export function hasMaterialQuestionChange(
  before: { text: string; questionType?: string; options: { label: string; text: string; isCorrect: boolean }[] },
  data: QuestionFormData
): boolean {
  if (before.text.trim() !== data.text.trim()) return true;
  if ((before.questionType ?? "SINGLE_CORRECT") !== data.questionType) return true;
  const correct = correctLabelsOf(data);
  const byLabel: Record<string, { text: string; isCorrect: boolean }> = {
    A: { text: data.optionA, isCorrect: correct.includes("A") },
    B: { text: data.optionB, isCorrect: correct.includes("B") },
    C: { text: data.optionC, isCorrect: correct.includes("C") },
    D: { text: data.optionD, isCorrect: correct.includes("D") },
  };
  if (before.options.length !== OPTION_LABELS.length) return true;
  return before.options.some((o) => {
    const next = byLabel[o.label];
    return !next || next.text.trim() !== o.text.trim() || next.isCorrect !== o.isCorrect;
  });
}

/**
 * Thrown inside a question-form transaction when the saved content fails the
 * publishing policy: the whole save rolls back and the admin sees why.
 */
export class PublishRefusedError extends Error {}

/**
 * Publishing from the question form uses the SAME rules as bulk Publish
 * (lib/question-publish-policy.ts): the row is written with its previous
 * status first, the policy evaluates exactly what was saved, and only then
 * is the status flipped to Published — all in the caller's transaction.
 */
export async function publishAfterSave(tx: Prisma.TransactionClient, questionId: string): Promise<void> {
  const refusal = await publishRefusal(questionId, tx, { evaluatePublished: true });
  if (refusal) throw new PublishRefusedError(refusal);
  await tx.question.update({ where: { id: questionId }, data: { status: QuestionStatus.PUBLISHED } });
}
