import {
  QuestionDifficulty,
  QuestionSource,
  QuestionStatus,
  type QuestionOption,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Shared, server-side question-selection service.
 *
 * The ONE place that turns a test definition's filter (exam / year / subject
 * / topic / sub-topic / source / difficulty / count) into a concrete, fixed
 * question set. Every test type — Mock Test, PYQ, Subject Test, Custom
 * Module rule mode, and later Grand/Live — resolves its questions through
 * here so the selection rules never diverge. The returned set is then
 * persisted once (TestAttemptQuestion / *_Question) and never reshuffled.
 *
 * Ownership discipline: the client never hands us question ids to select —
 * only filter values. Every filter is validated against the database (e.g. a
 * `subjectId` must actually belong to `examId`, a `topicId` to the subject)
 * and every question is verified PUBLISHED and scoped to `examId` at query
 * time, so a tampered request can only ever produce an empty/smaller pool,
 * never another exam's questions. See scripts/verify-test-engine.ts.
 */

export interface QuestionWithOptions {
  id: string;
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: QuestionDifficulty;
  examYear: number | null;
  options: QuestionOption[];
}

/**
 * A student-history-scoped narrowing on top of the ordinary filters — used by
 * Custom Module V2 ("Incorrect", "Unattempted", "Saved"). Requires
 * `studentId` on the filter set; ignored otherwise.
 */
export type AttemptFilterMode = "INCORRECT" | "UNATTEMPTED" | "SAVED";

/** Filters that identify which questions are eligible for selection. */
export interface QuestionSelectionFilters {
  examId: string;
  year?: number | null;
  subjectId?: string | null;
  topicId?: string | null;
  subTopicId?: string | null;
  source?: QuestionSource | null;
  difficulty?: QuestionDifficulty[] | null;
  studentId?: string | null;
  attemptFilter?: AttemptFilterMode | null;
}

/** A selection request: eligible pool constrained by filters, then `count` drawn. */
export interface QuestionSelectionRequest extends QuestionSelectionFilters {
  count: number;
  /**
   * Student-built practice (Subject Test / Test on the Go): when the pool is
   * smaller than `count`, draw the whole pool instead of failing — the
   * effective size is min(count, available), derived here from the real
   * pool, never from a client-supplied number. An empty pool still throws
   * (NoQuestionsAvailableError) so no empty attempt is ever created.
   * Admin-defined tests (Mock/Grand/etc.) leave this off and keep the strict
   * InsufficientQuestionsError contract.
   */
  allowFewer?: boolean;
}

export class InsufficientQuestionsError extends Error {
  readonly requested: number;
  readonly available: number;

  constructor(requested: number, available: number) {
    super(
      `Only ${available} question${available === 1 ? "" : "s"} available for the selection you made. ` +
        `Please lower the question count or widen the filters.`
    );
    this.name = "InsufficientQuestionsError";
    this.requested = requested;
    this.available = available;
  }
}

export class NoQuestionsAvailableError extends Error {
  constructor() {
    super("No questions are currently available for this subject.");
    this.name = "NoQuestionsAvailableError";
  }
}

/** In-place Fisher–Yates shuffle — returns the same array (destructive). */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Count PUBLISHED questions that match the filters (no sampling). Used by the
 * selection screen to tell students how many candidates exist, and internally
 * to fail fast with InsufficientQuestionsError.
 */
export async function countPublishedQuestions(filters: QuestionSelectionFilters): Promise<number> {
  return prisma.question.count({ where: await buildQuestionWhere(filters) });
}

/** True if the count needed is more than what is PUBLISHED and in scope. */
export async function hasEnoughQuestions(request: QuestionSelectionRequest): Promise<boolean> {
  return (await countPublishedQuestions(request)) >= request.count;
}

function toQuestionWhere(filters: QuestionSelectionFilters) {
  return {
    examId: filters.examId,
    status: QuestionStatus.PUBLISHED,
    examYear: filters.year ?? undefined,
    subjectId: filters.subjectId ?? undefined,
    topicId: filters.topicId ?? undefined,
    subTopicId: filters.subTopicId ?? undefined,
    source: filters.source ?? undefined,
    difficulty:
      filters.difficulty && filters.difficulty.length > 0 ? { in: filters.difficulty } : undefined,
  };
}

/**
 * Question has no Prisma relation to Answer (deliberate, snapshot-only
 * design — see lib/test-attempt.ts), so "Incorrect" / "Unattempted" can't be
 * expressed as a nested Prisma filter. Resolve the id set with one small,
 * student-scoped query first, then narrow the ordinary where by `id`. Bounded
 * by one student's own history, never the whole bank.
 */
async function applyAttemptFilter(where: ReturnType<typeof toQuestionWhere>, filters: QuestionSelectionFilters) {
  if (!filters.studentId || !filters.attemptFilter) return where;

  if (filters.attemptFilter === "SAVED") {
    const rows = await prisma.savedQuestion.findMany({ where: { studentId: filters.studentId }, select: { questionId: true } });
    return { ...where, id: { in: rows.map((r) => r.questionId) } };
  }
  if (filters.attemptFilter === "INCORRECT") {
    const rows = await prisma.answer.findMany({
      where: { studentId: filters.studentId, isCorrect: false },
      select: { questionId: true },
      distinct: ["questionId"],
    });
    return { ...where, id: { in: rows.map((r) => r.questionId) } };
  }
  // UNATTEMPTED: exclude every question the student has ever answered/marked (any non-UNANSWERED status).
  const rows = await prisma.answer.findMany({
    where: { studentId: filters.studentId, status: { not: "UNANSWERED" } },
    select: { questionId: true },
    distinct: ["questionId"],
  });
  return { ...where, id: { notIn: rows.map((r) => r.questionId) } };
}

async function buildQuestionWhere(filters: QuestionSelectionFilters) {
  return applyAttemptFilter(toQuestionWhere(filters), filters);
}

/**
 * Validate the ownership chain exam → subject → topic → sub-topic.
 * Throws if any linkage does not resolve to the exam the caller claims.
 * Exported so callers that must validate a filter set before it reaches
 * selectPublishedQuestions (e.g. Grand Test blueprint lines, validated at
 * create/update time as well as at publish-time resolution) can reuse the
 * exact same check rather than re-implementing it.
 */
export async function assertValidOwnershipChain(filters: QuestionSelectionFilters) {
  if (filters.subjectId) {
    const subject = await prisma.subject.findUnique({ where: { id: filters.subjectId }, select: { examId: true } });
    if (!subject || subject.examId !== filters.examId) {
      throw new Error("The selected subject does not belong to this exam.");
    }
  }
  if (filters.topicId) {
    const topic = await prisma.topic.findUnique({
      where: { id: filters.topicId },
      select: { subjectId: true, subject: { select: { examId: true } } },
    });
    if (!topic || (filters.subjectId && topic.subjectId !== filters.subjectId)) {
      throw new Error("The selected topic does not belong to the selected subject.");
    }
    // A topic id implies its subject — if none was given, trust the topic's own exam scope.
    if (!filters.subjectId && topic.subject.examId !== filters.examId) {
      throw new Error("The selected topic does not belong to this exam.");
    }
    if (filters.subTopicId) {
      const subTopic = await prisma.subTopic.findUnique({
        where: { id: filters.subTopicId },
        select: { topicId: true },
      });
      if (!subTopic || subTopic.topicId !== filters.topicId) {
        throw new Error("The selected sub-topic does not belong to the selected topic.");
      }
    }
  } else if (filters.subTopicId) {
    throw new Error("A sub-topic can only be selected together with its topic.");
  }
}

/**
 * Select `count` PUBLISHED questions in scope for the given filters.
 *
 * The pool is fully query-scoped by exam + filter (not post-filtered in JS),
 * so exam isolation holds by construction. The draw is random and the set is
 * returned in its selection order — callers persist it verbatim and must
 * never reshuffle. Throws InsufficientQuestionsError when the PUBLISHED pool
 * is smaller than `count` (unless `allowFewer`, which draws the whole pool).
 * Ids are distinct by construction (a slice of the shuffled unique pool), so
 * a small pool never produces repeated questions.
 */
export async function selectPublishedQuestions(
  request: QuestionSelectionRequest
): Promise<{ questions: QuestionWithOptions[]; available: number }> {
  if (request.count < 1) throw new Error("Question count must be at least 1.");
  await assertValidOwnershipChain(request);

  const where = await buildQuestionWhere(request);
  const available = await prisma.question.count({ where });
  if (request.allowFewer) {
    if (available === 0) throw new NoQuestionsAvailableError();
  } else if (available < request.count) {
    throw new InsufficientQuestionsError(request.count, available);
  }
  const effectiveCount = Math.min(request.count, available);

  const pool = await prisma.question.findMany({
    where,
    orderBy: { id: "asc" }, // stable base order — randomness comes from the shuffle below
    select: { id: true },
  });

  const shuffled = shuffle(pool);
  const picked = shuffled.slice(0, effectiveCount).map((q) => q.id);

  const questions = await prisma.question.findMany({
    where: { id: { in: picked } },
    include: { options: { orderBy: { order: "asc" } } },
  });

  // Return in the exact draw order (findMany's `in` has no ordering guarantee).
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = picked.map((id) => byId.get(id)!).filter(Boolean);

  return { questions: ordered, available };
}

/** Distinct exam years with at least one PUBLISHED question under the filter. */
export async function distinctYears(filters: QuestionSelectionFilters): Promise<number[]> {
  const rows = await prisma.question.groupBy({
    by: ["examYear"],
    where: {
      examId: filters.examId,
      status: QuestionStatus.PUBLISHED,
      subjectId: filters.subjectId ?? undefined,
      examYear: { not: null },
    },
    _count: { _all: true },
    orderBy: { examYear: "desc" },
  });
  return rows.map((r) => r.examYear as number).filter((y): y is number => y !== null);
}