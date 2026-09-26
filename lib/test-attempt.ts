import "server-only";
/**
 * TEST ENGINE CORE — HIGH RISK SHARED PATH.
 * Changes to option selection, answer persistence, navigation, attempt
 * snapshots, timer, submission or answer reveal require the focused
 * test-engine regression suite before deployment (see ops/TEST-ENGINE.md):
 *   scripts/verify-test-engine-core.ts  (server, disposable DB)
 *   scripts/verify-test-engine-ui.mjs   (real browser, local server)
 */
import {
  AnswerStatus,
  AttemptAnswerMode,
  AttemptDurationMode,
  AttemptEntryMode,
  AttemptSourceType,
  AttemptStatus,
  CustomModuleStatus,
  GrandTestStatus,
  QuestionStatus,
  TestType,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logActivity } from "@/lib/student-data";
import { isExpired, elapsedSecondsFor, remainingSecondsFor, type ServerTimedAttempt } from "@/lib/attempt-timing";
import { deriveLiveTestState } from "@/lib/live-test";
import { deriveMockTestAvailability, isMockTestAvailable, LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import { selectPublishedQuestions, type QuestionSelectionFilters, InsufficientQuestionsError } from "@/lib/question-selection";
import { assertContentAccess } from "@/lib/payments/access";
import { TestEngineError } from "@/lib/test-engine-log";

export { remainingSecondsFor, InsufficientQuestionsError, TestEngineError };
export type { QuestionSelectionFilters } from "@/lib/question-selection";

export interface QuestionSnapshot {
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null }[];
  correctLabel: string;
}

export interface QuestionWithOptions {
  id: string;
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null; isCorrect: boolean; order?: number }[];
}

/** Hard ceiling for a student-entered CUSTOM duration (minutes). */
export const MAX_CUSTOM_DURATION_MINUTES = 600;

/**
 * Minutes for a student-practice duration mode, computed ONCE at attempt
 * creation from the effective (actually frozen) question count:
 * PER_QUESTION = 1 min/question, CUSTOM = the student's explicit total,
 * UNLIMITED = 0 (never read as a window — see toServerTimedAttempt).
 */
export function practiceDurationMinutes(mode: AttemptDurationMode, questionCount: number, customMinutes?: number | null): number {
  if (mode === AttemptDurationMode.UNLIMITED) return 0;
  if (mode === AttemptDurationMode.CUSTOM) {
    const m = Math.floor(Number(customMinutes));
    if (!Number.isFinite(m) || m < 1 || m > MAX_CUSTOM_DURATION_MINUTES) {
      throw new TestEngineError("NOT_ALLOWED", `Custom time must be between 1 and ${MAX_CUSTOM_DURATION_MINUTES} minutes.`);
    }
    return m;
  }
  return Math.max(questionCount, 1);
}

/**
 * Instant (per-question) answer reveal is a student-practice capability only.
 * Mock Tests, PYQ papers, Grand/Live tests and admin-authored custom modules
 * are ALWAYS exam mode, whatever a caller asks for.
 */
export function instantAnswerAllowed(sourceType: AttemptSourceType, opts: { studentOwnedModule?: boolean } = {}): boolean {
  if (sourceType === AttemptSourceType.SUBJECT_TEST) return true;
  if (sourceType === AttemptSourceType.CUSTOM_MODULE) return opts.studentOwnedModule === true;
  return false;
}

/** Legacy source-grouping → production-facing test type, kept in one place. */
const TEST_TYPE_BY_SOURCE: Record<AttemptSourceType, TestType> = {
  [AttemptSourceType.MOCK_TEST]: TestType.FULL_MOCK,
  [AttemptSourceType.PREVIOUS_YEAR_PAPER]: TestType.PREVIOUS_YEAR_PAPER,
  [AttemptSourceType.CUSTOM_MODULE]: TestType.CUSTOM_MODULE,
  [AttemptSourceType.SUBJECT_TEST]: TestType.SUBJECT_TEST,
  [AttemptSourceType.GRAND_TEST]: TestType.GRAND_TEST,
  [AttemptSourceType.LIVE_TEST]: TestType.LIVE_TEST,
};

/**
 * Builds the shape lib/attempt-timing.ts needs, threading the test's global
 * window end through as the cap: a legacy Live Test's endAt, or a Fixed
 * Window Mock Test's availableUntil (whichever applies — an attempt belongs
 * to at most one of them).
 */
export function toServerTimedAttempt(attempt: {
  startedAt: Date;
  durationMinutes: number;
  durationMode?: AttemptDurationMode | null;
  liveTest?: { endAt: Date } | null;
  mockTest?: { availableUntil: Date | null } | null;
}): ServerTimedAttempt {
  const windowEnd = attempt.liveTest?.endAt ?? attempt.mockTest?.availableUntil ?? null;
  return {
    startedAt: attempt.startedAt,
    durationMinutes: attempt.durationMinutes,
    liveTestEndAt: windowEnd,
    unlimited: attempt.durationMode === AttemptDurationMode.UNLIMITED,
  };
}

function toSnapshot(question: QuestionWithOptions): QuestionSnapshot {
  // Options are frozen in their authored order (then label) — several start
  // paths load options without an orderBy, which previously froze e.g. B,A,C,D.
  const options = [...question.options].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  return {
    code: question.code,
    text: question.text,
    imageUrl: question.imageUrl,
    difficulty: question.difficulty,
    options: options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
    correctLabel: question.options.find((o) => o.isCorrect)?.label ?? "",
  };
}

/**
 * Create a TestAttempt from an already-resolved, fixed question set, then
 * freeze every question/option into TestAttemptQuestion.questionSnapshot and
 * seed an UNANSWERED Answer per question. The set is persisted verbatim at
 * start time and never re-resolved or reshuffled on resume. Also acts as a
 * guardrail so a test with no questions can never be started.
 */
async function createAttemptFromQuestions(params: {
  studentId: string;
  sourceType: AttemptSourceType;
  examId: string;
  mockTestId?: string;
  customModuleId?: string;
  previousYearPaperId?: string;
  grandTestId?: string;
  liveTestId?: string;
  subjectId?: string;
  topicIds?: string[];
  selection?: Record<string, unknown> | null;
  testType?: TestType;
  durationMinutes: number;
  negativeMarking: number;
  questions: QuestionWithOptions[];
  entryMode?: AttemptEntryMode;
  durationMode?: AttemptDurationMode;
  answerMode?: AttemptAnswerMode;
}) {
  if (params.questions.length === 0) {
    throw new Error("This test has no questions yet. Please try again later.");
  }
  // Never silently duplicate a question to pad a set.
  const questions = params.questions.filter((q, i, all) => all.findIndex((x) => x.id === q.id) === i);

  // The attempt, its frozen question snapshots and one UNANSWERED Answer per
  // question are written in ONE transaction: a half-created attempt (row but
  // no questions) used to be resumable and crashed the player.
  const attempt = await prisma.$transaction(async (tx) => {
    const created = await tx.testAttempt.create({
    data: {
      studentId: params.studentId,
      sourceType: params.sourceType,
      testType: params.testType ?? TEST_TYPE_BY_SOURCE[params.sourceType],
      examId: params.examId,
      mockTestId: params.mockTestId,
      customModuleId: params.customModuleId,
      previousYearPaperId: params.previousYearPaperId,
      grandTestId: params.grandTestId,
      liveTestId: params.liveTestId,
      subjectId: params.subjectId,
      topicIds: params.topicIds && params.topicIds.length > 0 ? params.topicIds : undefined,
      selection: (params.selection ?? undefined) as Prisma.InputJsonValue | undefined,
      durationMinutes: params.durationMinutes,
      durationMode: params.durationMode ?? AttemptDurationMode.FIXED,
      answerMode: params.answerMode ?? AttemptAnswerMode.EXAM,
      negativeMarking: params.negativeMarking,
      totalQuestions: questions.length,
      entryMode: params.entryMode ?? AttemptEntryMode.ONLINE,
    },
  });
    await tx.testAttemptQuestion.createMany({
      data: questions.map((q, order) => ({
        attemptId: created.id,
        questionId: q.id,
        order,
        questionSnapshot: toSnapshot(q) as never,
      })),
    });
    const rows = await tx.testAttemptQuestion.findMany({ where: { attemptId: created.id }, select: { id: true, questionId: true } });
    await tx.answer.createMany({
      data: rows.map((r) => ({
        attemptId: created.id,
        attemptQuestionId: r.id,
        studentId: params.studentId,
        questionId: r.questionId,
        status: AnswerStatus.UNANSWERED,
      })),
    });
    return created;
  }, { timeout: 20_000 });

  await logActivity(params.studentId, "TEST_STARTED", { attemptId: attempt.id, sourceType: params.sourceType });
  return attempt;
}

async function findResumableAttempt(studentId: string, where: Record<string, unknown>) {
  return prisma.testAttempt.findFirst({
    where: { studentId, status: AttemptStatus.IN_PROGRESS, ...where },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * Starts (or resumes) a Mock Test attempt. `availableFrom` is enforced here,
 * server-side, as the ONLY gate — no TestAttempt/TestAttemptQuestion row
 * (hence no question payload) can be created before this check passes, so
 * there is no direct-URL or early-access bypass to defend against downstream
 * (see lib/mock-test-schedule.ts#isMockTestAvailable). `attemptPolicy`
 * SINGLE_ATTEMPT additionally blocks a fresh start once a prior SUBMITTED
 * attempt exists for this student+test; MULTIPLE_PRACTICE (the default)
 * keeps today's unrestricted-retake behavior.
 */
export async function startMockTestAttempt(studentId: string, mockTestId: string, entryMode: AttemptEntryMode = AttemptEntryMode.ONLINE) {
  // Payment/entitlement gate runs BEFORE resume too, so an attempt started
  // while the content was free can't be resumed once it requires payment.
  const gate = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { examId: true, testSeriesId: true, accessType: true } });
  if (gate) await assertContentAccess(studentId, { kind: "MOCK_TEST", id: mockTestId, ...gate });

  const resumable = await findResumableAttempt(studentId, { mockTestId });
  if (resumable) return resumable;

  const mockTest = await prisma.mockTest.findFirst({
    // A published mock inside an unpublished (draft/archived) series is not live.
    where: { id: mockTestId, ...LIVE_MOCK_TEST_WHERE },
    // Only PUBLISHED questions reach students: a bulk import may attach rows
    // it auto-saved as Draft (missing image / no correct answer), which stay
    // reserved in the test's order until an admin reviews and publishes them.
    include: {
      questions: {
        where: { question: { status: QuestionStatus.PUBLISHED } },
        orderBy: { order: "asc" },
        include: { question: { include: { options: true } } },
      },
    },
  });
  if (!mockTest) throw new Error("This mock test is not available.");
  if (!isMockTestAvailable(mockTest)) {
    throw new Error(
      deriveMockTestAvailability(mockTest) === "CLOSED"
        ? "This test window has closed. New attempts are no longer accepted."
        : "This test is not available yet."
    );
  }

  if (mockTest.attemptPolicy === "SINGLE_ATTEMPT") {
    const priorSubmission = await prisma.testAttempt.findFirst({
      where: { studentId, mockTestId, status: AttemptStatus.SUBMITTED },
      select: { id: true },
    });
    if (priorSubmission) throw new Error("You have already attempted this test. Retakes are not allowed.");
  }

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.MOCK_TEST,
    examId: mockTest.examId,
    mockTestId: mockTest.id,
    durationMinutes: mockTest.durationMinutes,
    negativeMarking: mockTest.negativeMarking,
    questions: mockTest.questions.map((mq) => mq.question as unknown as QuestionWithOptions),
    entryMode,
  });
}

/**
 * Offline OMR Answer Entry (spec Phase 3): a student who printed the Paper
 * PDF + OMR sheet and answered on paper can key the answers in afterward.
 * This is NOT a separate scoring path — it's the exact same
 * createAttemptFromQuestions/saveAnswer/submitAttempt pipeline as
 * startMockTestAttempt, just tagged with entryMode so the UI can show an
 * answer-only entry screen instead of the question player.
 */
export async function startOfflineOmrEntryAttempt(studentId: string, mockTestId: string) {
  return startMockTestAttempt(studentId, mockTestId, AttemptEntryMode.OFFLINE_OMR_ENTRY);
}

const CUSTOM_MODULE_QUESTIONS_INCLUDE = {
  questions: { orderBy: { order: "asc" as const }, include: { question: { include: { options: true } } } },
};

type CustomModuleWithQuestions = Awaited<
  ReturnType<typeof prisma.customModule.findFirstOrThrow<{ include: typeof CUSTOM_MODULE_QUESTIONS_INCLUDE }>>
>;

async function startFromCustomModuleRow(studentId: string, customModule: CustomModuleWithQuestions) {
  await assertContentAccess(studentId, {
    kind: "CUSTOM_MODULE",
    id: customModule.id,
    examId: customModule.examId,
    accessType: customModule.accessType,
  });
  const resumable = await findResumableAttempt(studentId, { customModuleId: customModule.id });
  if (resumable) return resumable;

  // FIXED is every admin module and every module created before duration
  // modes existed: exactly the old `durationMinutes ?? 30` behavior.
  const durationMode = customModule.durationMode;
  const durationMinutes =
    durationMode === AttemptDurationMode.FIXED
      ? (customModule.durationMinutes ?? 30)
      : practiceDurationMinutes(durationMode, customModule.questions.length, customModule.durationMinutes);
  const answerMode =
    customModule.answerMode === AttemptAnswerMode.INSTANT &&
    instantAnswerAllowed(AttemptSourceType.CUSTOM_MODULE, { studentOwnedModule: customModule.isStudentOwned })
      ? AttemptAnswerMode.INSTANT
      : AttemptAnswerMode.EXAM;

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.CUSTOM_MODULE,
    examId: customModule.examId,
    customModuleId: customModule.id,
    durationMinutes,
    durationMode,
    answerMode,
    negativeMarking: customModule.negativeMarking,
    questions: customModule.questions.map((mq) => mq.question as unknown as QuestionWithOptions),
  });
}

/**
 * A student-owned Custom Module V2 (isStudentOwned) is private to its
 * creator through this path — the `OR` clause is the entire enforcement
 * point, so a student can never start another student's private module just
 * by guessing/enumerating its id. Sharing is handled separately, by
 * shareToken, never by id (see startSharedCustomModuleAttempt).
 */
export async function startCustomModuleAttempt(studentId: string, moduleId: string) {
  const customModule = await prisma.customModule.findFirst({
    where: {
      id: moduleId,
      status: { in: [CustomModuleStatus.PUBLISHED, CustomModuleStatus.ACTIVE] },
      OR: [{ isStudentOwned: false }, { createdByStudentId: studentId }],
    },
    include: CUSTOM_MODULE_QUESTIONS_INCLUDE,
  });
  if (!customModule) throw new Error("This custom module is not available.");
  return startFromCustomModuleRow(studentId, customModule);
}

/**
 * Start (or resume) an attempt against a module the student reached via its
 * unguessable share link rather than ownership — the token itself is the
 * authorization, so any signed-in student holding it may start their own
 * independent attempt against the same fixed question set.
 */
export async function startSharedCustomModuleAttempt(studentId: string, shareToken: string) {
  const customModule = await prisma.customModule.findFirst({
    where: { shareToken, status: { in: [CustomModuleStatus.PUBLISHED, CustomModuleStatus.ACTIVE] } },
    include: CUSTOM_MODULE_QUESTIONS_INCLUDE,
  });
  if (!customModule) throw new Error("This shared module link is invalid or no longer available.");
  return startFromCustomModuleRow(studentId, customModule);
}

/**
 * Generate (or resume) a GRAND_TEST attempt from a Grand Test's already
 * publish-time-resolved, immutable GrandTestQuestion set. Every student who
 * starts the same Grand Test gets the exact same question set/order — the
 * blueprint is resolved once at publish, never per-student and never here.
 */
export async function startGrandTestAttempt(studentId: string, grandTestId: string) {
  const gate = await prisma.grandTest.findUnique({ where: { id: grandTestId }, select: { examId: true, accessType: true } });
  if (gate) await assertContentAccess(studentId, { kind: "GRAND_TEST", id: grandTestId, ...gate });

  const resumable = await findResumableAttempt(studentId, { grandTestId });
  if (resumable) return resumable;

  const grandTest = await prisma.grandTest.findFirst({
    where: { id: grandTestId, status: GrandTestStatus.PUBLISHED },
    include: { questions: { orderBy: { order: "asc" }, include: { question: { include: { options: true } } } } },
  });
  if (!grandTest) throw new Error("This grand test is not available.");

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.GRAND_TEST,
    testType: TestType.GRAND_TEST,
    examId: grandTest.examId,
    grandTestId: grandTest.id,
    durationMinutes: grandTest.durationMinutes,
    negativeMarking: grandTest.negativeMarking,
    questions: grandTest.questions.map((gq) => gq.question as unknown as QuestionWithOptions),
  });
}

/**
 * Generate (or resume) a LIVE_TEST attempt from a Live Test's already
 * lock-time-resolved, immutable LiveTestQuestion set. Starting is only ever
 * allowed while the DERIVED state is LIVE — never based on a stale client
 * clock or on the persisted `status` alone (see lib/live-test.ts). The
 * attempt's nominal duration is `studentDurationMinutes`; the actual,
 * possibly-shorter effective window (capped by the test's global `endAt`)
 * is enforced by lib/attempt-timing.ts via `liveTest.endAt` on every read.
 */
export async function startLiveTestAttempt(studentId: string, liveTestId: string) {
  const gate = await prisma.liveTest.findUnique({ where: { id: liveTestId }, select: { examId: true, accessType: true } });
  if (gate) await assertContentAccess(studentId, { kind: "LIVE_TEST", id: liveTestId, ...gate });

  const resumable = await findResumableAttempt(studentId, { liveTestId });
  if (resumable) return resumable;

  const liveTest = await prisma.liveTest.findUnique({
    where: { id: liveTestId },
    include: { questions: { orderBy: { order: "asc" }, include: { question: { include: { options: true } } } } },
  });
  if (!liveTest) throw new Error("This live test does not exist.");

  const state = deriveLiveTestState(liveTest, new Date());
  if (state === "DRAFT") throw new Error("This live test has not been published yet.");
  if (state === "CANCELLED") throw new Error("This live test was cancelled.");
  if (state === "SCHEDULED") throw new Error("This live test has not started yet.");
  if (state === "ENDED" || state === "RESULT_PUBLISHED") throw new Error("This live test has ended.");

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.LIVE_TEST,
    testType: TestType.LIVE_TEST,
    examId: liveTest.examId,
    liveTestId: liveTest.id,
    durationMinutes: liveTest.studentDurationMinutes,
    negativeMarking: liveTest.negativeMarking,
    questions: liveTest.questions.map((lq) => lq.question as unknown as QuestionWithOptions),
  });
}

export async function startPreviousYearPaperAttempt(studentId: string, paperId: string) {
  const gate = await prisma.previousYearPaper.findUnique({ where: { id: paperId }, select: { examId: true } });
  if (gate) await assertContentAccess(studentId, { kind: "PREVIOUS_YEAR_PAPER", id: paperId, examId: gate.examId });

  const resumable = await findResumableAttempt(studentId, { previousYearPaperId: paperId });
  if (resumable) return resumable;

  const paper = await prisma.previousYearPaper.findFirst({
    where: { id: paperId, isActive: true },
    include: { exam: true },
  });
  if (!paper) throw new Error("This paper is not available.");

  const questions = await prisma.question.findMany({
    where: { previousYearPaperId: paperId, status: QuestionStatus.PUBLISHED },
    include: { options: true },
  });

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.PREVIOUS_YEAR_PAPER,
    examId: paper.examId,
    previousYearPaperId: paper.id,
    durationMinutes: paper.exam.durationMinutes ?? 60,
    negativeMarking: paper.exam.negativeMarking ?? 0,
    questions: questions as unknown as QuestionWithOptions[],
  });
}

export interface SubjectTestSelection extends QuestionSelectionFilters {
  durationMinutes: number;
  /** Requested size. The attempt uses min(count, eligible pool) — see selectPublishedQuestions#allowFewer. */
  count: number;
  /** Test on the Go: 1 question = 1 minute, so the duration follows the EFFECTIVE count, not the requested one. */
  minutesPerQuestion?: number;
  /** Student-practice answer mode; INSTANT is permitted for subject practice (instantAnswerAllowed). */
  answerMode?: AttemptAnswerMode;
}

/**
 * Generate (or resume) a SUBJECT_TEST attempt.
 *
 * The question set is resolved on the server from validated filters, then
 * frozen into the attempt at start. If the student already has an IN_PROGRESS
 * subject test for the same subject, that attempt is returned untouched —
 * resume never re-selects or re-shuffles. `durationMinutes` is authoritative
 * for the server-side window (see lib/attempt-timing.ts).
 */
export async function startSubjectTestAttempt(studentId: string, selection: SubjectTestSelection) {
  if (selection.examId) await assertContentAccess(studentId, { kind: "SUBJECT_TEST", id: null, examId: selection.examId });

  const resumable = await findResumableAttempt(studentId, { testType: TestType.SUBJECT_TEST, subjectId: selection.subjectId });
  if (resumable) return resumable;
  if (!selection.subjectId) throw new Error("A subject is required to start a subject test.");
  if (!selection.examId) throw new Error("An exam is required to start a subject test.");

  const { questions } = await selectPublishedQuestions({
    examId: selection.examId,
    year: selection.year,
    subjectId: selection.subjectId,
    topicId: selection.topicId,
    subTopicId: selection.subTopicId,
    source: selection.source,
    difficulty: selection.difficulty,
    count: selection.count,
    allowFewer: true,
  });

  const subject = await prisma.subject.findUnique({ where: { id: selection.subjectId }, select: { name: true } });

  return createAttemptFromQuestions({
    studentId,
    sourceType: AttemptSourceType.SUBJECT_TEST,
    examId: selection.examId,
    subjectId: selection.subjectId,
    topicIds: selection.topicId ? [selection.topicId] : undefined,
    selection: {
      year: selection.year ?? null,
      source: selection.source ?? null,
      difficulty: selection.difficulty ?? null,
      subTopicIds: selection.subTopicId ? [selection.subTopicId] : null,
      subjects: [{ id: selection.subjectId, name: subject?.name ?? null }],
    },
    durationMinutes: selection.minutesPerQuestion ? questions.length * selection.minutesPerQuestion : selection.durationMinutes,
    durationMode: selection.minutesPerQuestion ? AttemptDurationMode.PER_QUESTION : AttemptDurationMode.CUSTOM,
    answerMode: selection.answerMode === AttemptAnswerMode.INSTANT ? AttemptAnswerMode.INSTANT : AttemptAnswerMode.EXAM,
    negativeMarking: 0,
    questions: questions as unknown as QuestionWithOptions[],
  });
}

const EDITABLE_ATTEMPT_SELECT = {
  id: true,
  status: true,
  startedAt: true,
  durationMinutes: true,
  durationMode: true,
  answerMode: true,
  liveTest: { select: { endAt: true } },
  mockTest: { select: { availableUntil: true } },
} as const;

/**
 * Loads the attempt + the one attempt-question a save/reveal targets and
 * enforces every precondition: ownership, IN_PROGRESS, the server-side time
 * window, membership, and (when a label is given) that the label is one of
 * the frozen snapshot's options. Two small indexed reads — never the whole
 * attempt, never the Question Bank.
 */
async function loadEditableQuestion(attemptId: string, studentId: string, questionId: string, label: string | null) {
  const attempt = await prisma.testAttempt.findFirst({ where: { id: attemptId, studentId }, select: EDITABLE_ATTEMPT_SELECT });
  if (!attempt || attempt.status !== AttemptStatus.IN_PROGRESS) {
    throw new TestEngineError("NOT_EDITABLE", "This test has already been submitted.");
  }
  if (isExpired(toServerTimedAttempt(attempt))) {
    throw new TestEngineError("EXPIRED", "Time is up — this test has ended and answers can no longer be changed.");
  }
  const attemptQuestion = await prisma.testAttemptQuestion.findUnique({
    where: { attemptId_questionId: { attemptId, questionId } },
    select: { id: true, questionSnapshot: true, answer: { select: { selectedOptionLabel: true, revealedAt: true, status: true } } },
  });
  if (!attemptQuestion) throw new TestEngineError("NOT_IN_ATTEMPT", "Question does not belong to this attempt.");
  if (label !== null) {
    const snapshot = attemptQuestion.questionSnapshot as unknown as QuestionSnapshot;
    if (!Array.isArray(snapshot?.options) || !snapshot.options.some((o) => o.label === label)) {
      throw new TestEngineError("INVALID_OPTION", "That option is not part of this question.");
    }
  }
  return { attempt, attemptQuestion };
}

function answerStatusFor(selectedOptionLabel: string | null, markForReview: boolean): AnswerStatus {
  return selectedOptionLabel
    ? markForReview
      ? AnswerStatus.ANSWERED_AND_MARKED
      : AnswerStatus.ANSWERED
    : markForReview
      ? AnswerStatus.MARKED_FOR_REVIEW
      : AnswerStatus.UNANSWERED;
}

/**
 * Persist one answer. Ordered + idempotent by construction:
 *  - `seq` is the client's per-tab monotonic save sequence. The write is a
 *    single conditional UPDATE (`saveSeq < seq`), so a delayed/retried older
 *    request can never overwrite a newer answer, and replaying the same save
 *    is a no-op. Server-side callers omit it and get "now".
 *  - The same statement also requires the attempt to still be IN_PROGRESS
 *    and the question not revealed, so a save racing a submit or an instant
 *    reveal can't slip in afterwards.
 * Exactly one Answer row exists per attempt-question (unique
 * attemptQuestionId), so concurrent saves can never duplicate rows.
 * Returns applied=false for a stale (superseded) save — not an error.
 */
export async function saveAnswer(
  attemptId: string,
  studentId: string,
  questionId: string,
  selectedOptionLabel: string | null,
  markForReview: boolean,
  seq?: number
): Promise<{ applied: boolean }> {
  const label = selectedOptionLabel || null;
  const { attemptQuestion } = await loadEditableQuestion(attemptId, studentId, questionId, label);
  const saveSeq = typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : Date.now();
  const status = answerStatusFor(label, markForReview);

  if (attemptQuestion.answer?.revealedAt) {
    // A revealed practice answer is frozen: only the review flag may change.
    if (label !== attemptQuestion.answer.selectedOptionLabel) {
      throw new TestEngineError("LOCKED", "This answer was already checked and can no longer be changed.");
    }
  }

  const result = await prisma.answer.updateMany({
    where: {
      attemptQuestionId: attemptQuestion.id,
      saveSeq: { lt: saveSeq },
      attempt: { status: AttemptStatus.IN_PROGRESS },
      ...(attemptQuestion.answer?.revealedAt ? { selectedOptionLabel: label } : { revealedAt: null }),
    },
    data: { selectedOptionLabel: label, status, answeredAt: label ? new Date() : null, saveSeq },
  });
  return { applied: result.count === 1 };
}

/**
 * Server-authorized per-question answer reveal (INSTANT answer mode only).
 * The correct label never reaches the client before this succeeds. The
 * student's chosen option is recorded and frozen in the SAME conditional
 * update that stamps revealedAt, so revealing and then switching to the
 * correct option is impossible, and a refresh can't reset the reveal.
 * Idempotent: a second call returns the already-frozen result.
 */
export async function revealAnswer(
  attemptId: string,
  studentId: string,
  questionId: string,
  selectedOptionLabel: string,
  seq?: number
): Promise<{ selectedOptionLabel: string | null; correctLabel: string; isCorrect: boolean }> {
  if (!selectedOptionLabel) throw new TestEngineError("NO_SELECTION", "Choose an option before checking the answer.");
  const { attempt, attemptQuestion } = await loadEditableQuestion(attemptId, studentId, questionId, selectedOptionLabel);
  if (attempt.answerMode !== AttemptAnswerMode.INSTANT) {
    throw new TestEngineError("NOT_ALLOWED", "Answers are shown after you submit this test.");
  }

  const marked =
    attemptQuestion.answer?.status === AnswerStatus.ANSWERED_AND_MARKED || attemptQuestion.answer?.status === AnswerStatus.MARKED_FOR_REVIEW;
  const now = new Date();
  await prisma.answer.updateMany({
    where: { attemptQuestionId: attemptQuestion.id, revealedAt: null, attempt: { status: AttemptStatus.IN_PROGRESS } },
    data: {
      selectedOptionLabel,
      status: answerStatusFor(selectedOptionLabel, marked),
      answeredAt: now,
      revealedAt: now,
      saveSeq: typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : now.getTime(),
    },
  });

  const answer = await prisma.answer.findUnique({
    where: { attemptQuestionId: attemptQuestion.id },
    select: { selectedOptionLabel: true, revealedAt: true },
  });
  if (!answer?.revealedAt) throw new TestEngineError("NOT_EDITABLE", "This test has already been submitted.");
  const correctLabel = (attemptQuestion.questionSnapshot as unknown as QuestionSnapshot).correctLabel ?? "";
  return {
    selectedOptionLabel: answer.selectedOptionLabel,
    correctLabel,
    isCorrect: !!answer.selectedOptionLabel && answer.selectedOptionLabel === correctLabel,
  };
}

export async function submitAttempt(attemptId: string, studentId: string) {
  const attempt = await prisma.testAttempt.findFirst({
    where: { id: attemptId, studentId },
    include: {
      questions: { include: { answer: true } },
      liveTest: { select: { endAt: true } },
      mockTest: { select: { availableUntil: true } },
    },
  });
  if (!attempt) throw new Error("Attempt not found.");
  if (attempt.status === AttemptStatus.SUBMITTED) return attempt;

  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  const updates = attempt.questions.map((tq) => {
    const snapshot = tq.questionSnapshot as unknown as QuestionSnapshot;
    const answer = tq.answer;
    const selected = answer?.selectedOptionLabel ?? null;
    let isCorrect: boolean | null = null;

    if (!selected) {
      unansweredCount += 1;
    } else if (selected === snapshot.correctLabel) {
      isCorrect = true;
      correctCount += 1;
    } else {
      isCorrect = false;
      incorrectCount += 1;
    }

    return answer
      ? prisma.answer.update({ where: { id: answer.id }, data: { isCorrect } })
      : prisma.answer.create({
          data: { attemptId, attemptQuestionId: tq.id, studentId, questionId: tq.questionId, isCorrect, status: AnswerStatus.UNANSWERED },
        });
  });

  const score = correctCount * 1 - incorrectCount * attempt.negativeMarking;
  const maxScore = attempt.totalQuestions;
  // Late submits stay valid, but the reported time can never exceed the window:
  // answers could not have been changed after effectiveEnd, so capping is honest.
  const timeTakenSeconds = elapsedSecondsFor(toServerTimedAttempt(attempt));

  // Leaderboard eligibility: set exactly once, on this student's first
  // SUBMITTED attempt for this Mock Test — never recomputed afterward, so a
  // later practice retake (attemptPolicy MULTIPLE_PRACTICE) can never
  // displace it. A single student's submissions are inherently serial (one
  // browser, one in-flight submit at a time via the IN_PROGRESS uniqueness
  // findResumableAttempt already enforces), so a plain existence check here
  // is sufficient without extra locking.
  let isLeaderboardAttempt = false;
  if (attempt.sourceType === AttemptSourceType.MOCK_TEST && attempt.mockTestId) {
    const priorLeaderboardAttempt = await prisma.testAttempt.findFirst({
      where: { studentId, mockTestId: attempt.mockTestId, status: AttemptStatus.SUBMITTED, isLeaderboardAttempt: true },
      select: { id: true },
    });
    isLeaderboardAttempt = !priorLeaderboardAttempt;
  }

  await prisma.$transaction([
    ...updates,
    prisma.testAttempt.update({
      where: { id: attemptId },
      data: {
        status: AttemptStatus.SUBMITTED,
        submittedAt: new Date(),
        correctCount,
        incorrectCount,
        unansweredCount,
        score,
        maxScore,
        timeTakenSeconds,
        isLeaderboardAttempt,
      },
    }),
  ]);

  await logActivity(studentId, "TEST_SUBMITTED", { attemptId, score, maxScore });

  return prisma.testAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}

/**
 * Request-time reconciliation (Step 5.6): auto-finalizes an attempt that's
 * still IN_PROGRESS but whose effective window has already closed —
 * independent of any browser, cron, or PM2 process. Called from every
 * server-side read of an owned attempt (lib/student-data.ts#getOwnedAttempt),
 * so the very next time ANYONE touches the attempt (the student reopening
 * the app, an admin viewing history/analytics, a manual reconcile sweep)
 * finalizes it — a browser that never comes back no longer leaves the
 * attempt dangling forever. `submitAttempt` is itself idempotent (returns
 * immediately once SUBMITTED), so calling this repeatedly, including
 * concurrently, can never double-score or double-count.
 */
export async function finalizeIfExpired(attempt: {
  id: string;
  studentId: string;
  status: AttemptStatus;
  startedAt: Date;
  durationMinutes: number;
  durationMode?: AttemptDurationMode | null;
  liveTest?: { endAt: Date } | null;
  mockTest?: { availableUntil: Date | null } | null;
}): Promise<boolean> {
  if (attempt.status !== AttemptStatus.IN_PROGRESS) return false;
  if (!isExpired(toServerTimedAttempt(attempt))) return false;
  await submitAttempt(attempt.id, attempt.studentId);
  return true;
}

/**
 * Sweeps every IN_PROGRESS attempt whose window has closed and finalizes it.
 * Safe to call repeatedly/concurrently (submitAttempt is idempotent) and
 * safe to run from a request handler — there is no dependency on a cron
 * process or a specific PM2 worker. Used by the admin Live Test detail page
 * (both opportunistically on load and via an explicit "Reconcile Now"
 * action) since that is where a dangling attempt is most visible, but it is
 * general — any test type's timed-out attempts get swept.
 */
export async function reconcileExpiredAttempts(filter: { liveTestId?: string } = {}): Promise<number> {
  const candidates = await prisma.testAttempt.findMany({
    where: { status: AttemptStatus.IN_PROGRESS, ...filter },
    select: {
      id: true,
      studentId: true,
      status: true,
      startedAt: true,
      durationMinutes: true,
      durationMode: true,
      liveTest: { select: { endAt: true } },
      mockTest: { select: { availableUntil: true } },
    },
  });
  let finalized = 0;
  for (const attempt of candidates) {
    if (await finalizeIfExpired(attempt)) finalized += 1;
  }
  return finalized;
}