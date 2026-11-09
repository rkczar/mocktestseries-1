import type { Prisma } from "@prisma/client";

/** Fields the full preview needs (add to any question select). */
export const QUESTION_PREVIEW_SELECT = {
  code: true,
  text: true,
  imageUrl: true,
  contentFormat: true,
  explanation: true,
  questionType: true,
  matchSpec: true,
  options: { orderBy: { order: "asc" }, select: { label: true, text: true, imageUrl: true, isCorrect: true } },
  assets: {
    orderBy: [{ role: "asc" }, { optionLabel: "asc" }, { order: "asc" }],
    select: { id: true, role: true, optionLabel: true, listKey: true, order: true, storageKey: true, alt: true, caption: true, width: true, height: true, bytes: true, sha256: true, darkBacking: true },
  },
} satisfies Prisma.QuestionSelect;

export type PreviewQuestion = Prisma.QuestionGetPayload<{ select: typeof QUESTION_PREVIEW_SELECT }>;

