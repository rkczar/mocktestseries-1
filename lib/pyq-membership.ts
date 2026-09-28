import { QuestionStatus, type Prisma } from "@prisma/client";

/**
 * Canonical Previous Year Paper membership.
 *
 * A PYQ paper is a historical document: its question list and question
 * count come ONLY from questions explicitly assigned to it through
 * Question.previousYearPaperId. Nothing else implies membership — not a
 * matching exam, year, subject or `source = PYQ`, and not being reused in a
 * Mock Test, Subject Test, Custom Module or Test Series (those are
 * MockTestQuestion / *_Question membership rows and never touch the
 * question's own ownership fields).
 *
 * Every surface that lists or counts a paper's questions (Student Dashboard,
 * public exam pages, Admin PYQ pages, the PYQ attempt itself) uses these
 * so the count a student sees is exactly the set a PYQ attempt serves.
 */
export function paperQuestionWhere(paperId: string): Prisma.QuestionWhereInput {
  return { previousYearPaperId: paperId, status: QuestionStatus.PUBLISHED };
}

/** `_count` selector for PreviousYearPaper → its student-visible (PUBLISHED) questions. */
export const PAPER_PUBLISHED_QUESTION_COUNT = {
  questions: { where: { status: QuestionStatus.PUBLISHED } },
} as const satisfies Prisma.PreviousYearPaperCountOutputTypeSelect;
