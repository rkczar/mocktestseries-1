import { QuestionStatus, type Prisma } from "@prisma/client";

/**
 * The ONE rule for which questions may reach a student inside a test
 * (Phase 1 question safety, docs/QUESTION-RETIREMENT.md).
 *
 * A question is servable when it is PUBLISHED and not retired. ARCHIVED and
 * DRAFT questions are never served, whatever test, module or paper still
 * links to them: a membership row (MockTestQuestion, CustomModuleQuestion,
 * GrandTestQuestion, LiveTestQuestion, Question.previousYearPaperId) is never
 * a reason to serve a question on its own.
 *
 * Every start path filters with this, and createAttemptFromQuestions re-checks
 * the final set inside its transaction (assertServableInTransaction), so a
 * question retired while a start is in flight can never be frozen into a new
 * attempt.
 */
export const SERVABLE_QUESTION_WHERE = {
  status: QuestionStatus.PUBLISHED,
  retiredAt: null,
} satisfies Prisma.QuestionWhereInput;

/** For a membership row's `question` relation filter. */
export const SERVABLE_MEMBERSHIP_WHERE = { question: SERVABLE_QUESTION_WHERE } satisfies {
  question: Prisma.QuestionWhereInput;
};

export function isServable(q: { status: QuestionStatus | string; retiredAt?: Date | null }): boolean {
  return q.status === QuestionStatus.PUBLISHED && !q.retiredAt;
}
