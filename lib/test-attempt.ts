import "server-only";
import { assertPlatformOpen } from "@/lib/platform-controls";
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
import { deriveMockTestAvailability, isMockTestAvailable, isMockResultReleased, LIVE_MOCK_TEST_WHERE } from "@/lib/mock-test-schedule";
import { selectPublishedQuestions, type QuestionSelectionFilters, InsufficientQuestionsError } from "@/lib/question-selection";
import { assertContentAccess } from "@/lib/payments/access";
import { assertExamLive } from "@/lib/exam-live";
import { TestEngineError } from "@/lib/test-engine-log";
import { MAX_CUSTOM_DURATION_MINUTES, type AttemptConfigChoice } from "@/lib/attempt-config";
import { explanationView, toSnapshotAssets, type SnapshotAsset } from "@/lib/rich-content";
import type { ContentFormat, ExplanationView } from "@/lib/rich-content-types";
import {
  gradeLabelSet,
  normalizeLabelSet,
  readMatchSpec,
  snapshotCorrectLabels,
  snapshotQuestionType,
  toQuestionType,
  type MatchSpec,
  type QuestionTypeName,
} from "@/lib/question-types";

export { remainingSecondsFor, InsufficientQuestionsError, TestEngineError, MAX_CUSTOM_DURATION_MINUTES };
export type { AttemptConfigChoice } from "@/lib/attempt-config";
export type { QuestionSelectionFilters } from "@/lib/question-selection";

/**
 * A frozen question. v1 (no `v` key) is the original shape and is still what
 * every PLAIN question without an explanation freezes to, byte for byte.
 * v2 adds the rich-content keys; readers treat a missing `v` as v1 and ignore
 * keys they don't know. `correctLabel` and `explanation` are answer-key data:
 * lib/test-player-data.ts strips both until an authorized reveal.
 * v3 (NEET Phase 4) is written ONLY for MULTIPLE_CORRECT / MATCH_THE_FOLLOWING
 * questions: every v2 key + `questionType`, and `correctLabels` (MULTIPLE_CORRECT,
 * answer-key data; its `correctLabel` is "" so no reader can mistake one option
 * for the key) or `matchSpec` (MATCH_THE_FOLLOWING, presentation). SINGLE_CORRECT
 * questions never freeze to v3.
 */
export interface QuestionSnapshot {
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null }[];
  correctLabel: string;
  v?: 2 | 3;
  contentFormat?: ContentFormat;
  explanation?: string | null;
  assets?: SnapshotAsset[];
  questionType?: QuestionTypeName;
  correctLabels?: string[];
  matchSpec?: MatchSpec | null;
}

export interface QuestionWithOptions {
  id: string;
  code: string;
  text: string;
  imageUrl: string | null;
  difficulty: string;
  options: { label: string; text: string; imageUrl: string | null; isCorrect: boolean; order?: number }[];
  contentFormat?: ContentFormat;
  explanation?: string | null;
  questionType?: string;
  matchSpec?: unknown;
}

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
 * Instant (per-question) answer reveal for the practice sources (Subject Test,
 * student-owned Custom Module). Admin-authored custom modules are always exam
 * mode. Formal tests (Mock / PYQ) decide through studentConfigAllowed below;
 * Grand/Live never reveal.
 */
export function instantAnswerAllowed(sourceType: AttemptSourceType, opts: { studentOwnedModule?: boolean } = {}): boolean {
  if (sourceType === AttemptSourceType.SUBJECT_TEST) return true;
  if (sourceType === AttemptSourceType.CUSTOM_MODULE) return opts.studentOwnedModule === true;
  return false;
}

/**
 * Formal tests: admin-defined question set; admin-defined timing and EXAM
 * mode unless the student's Pre-Test Setup choice is allowed
 * (studentConfigAllowed). Enforced where every attempt is created
 * (createAttemptFromQuestions) and again on reveal — never just by hiding UI.
 */
const FORMAL_SOURCES: ReadonlySet<AttemptSourceType> = new Set([
  AttemptSourceType.MOCK_TEST,
  AttemptSourceType.PREVIOUS_YEAR_PAPER,
  AttemptSourceType.GRAND_TEST,
  AttemptSourceType.LIVE_TEST,
]);
export function isFormalSource(sourceType: AttemptSourceType): boolean {
  return FORMAL_SOURCES.has(sourceType);
}

/**
 * Pre-Test Setup for formal tests: may the student choose the time mode
 * (Standard / 1 min per question / Custom) and the answer review mode for a
 * NEW attempt? Only for a Previous Year Paper, or a Mock Test whose answer
 * key is public the moment it is submitted (IMMEDIATE release, no shared
 * Fixed Window). A scheduled/competitive mock (window, AFTER_WINDOW or
 * CUSTOM_DATE release) keeps the formal EXAM + admin timing, because a
 * per-question reveal there would leak a held answer key. Grand/Live never.
 *
 * A Live CBT (enrollment ON) is never configurable, whatever its schedule:
 * its page has no Pre-Test Setup, so a "configurable" Live CBT sent Start
 * back to the same page forever (7 Oct 2026 incident: enrollment ON +
 * Scheduled Release + Immediate result — Start did nothing).
 */
export function studentConfigAllowed(
  sourceType: AttemptSourceType,
  mockTest?: { resultReleaseMode: string; availableUntil: Date | null; enrollmentEnabled?: boolean } | null
): boolean {
  if (sourceType === AttemptSourceType.PREVIOUS_YEAR_PAPER) return true;
  if (sourceType === AttemptSourceType.MOCK_TEST) {
    return !!mockTest && !mockTest.enrollmentEnabled && mockTest.resultReleaseMode === "IMMEDIATE" && mockTest.availableUntil === null;
  }
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

/** Snapshot v2 is written only when a question has rich content or an explanation. */
function needsSnapshotV2(question: QuestionWithOptions): boolean {
  return question.contentFormat === "RICH_V1" || (typeof question.explanation === "string" && question.explanation.trim() !== "");
}

function toSnapshot(question: QuestionWithOptions, assets: SnapshotAsset[] = []): QuestionSnapshot {
  // Options are frozen in their authored order (then label) — several start
  // paths load options without an orderBy, which previously froze e.g. B,A,C,D.
  const options = [...question.options].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  const v1: QuestionSnapshot = {
    code: question.code,
    text: question.text,
    imageUrl: question.imageUrl,
    difficulty: question.difficulty,
    options: options.map((o) => ({ label: o.label, text: o.text, imageUrl: o.imageUrl })),
    correctLabel: question.options.find((o) => o.isCorrect)?.label ?? "",
  };
  const type = toQuestionType(question.questionType);
  if (type !== "SINGLE_CORRECT") {
    // Advanced types only (NEET Phase 4): v3 = every v2 key + the type's own frozen data.
    return {
      ...v1,
      correctLabel: type === "MULTIPLE_CORRECT" ? "" : v1.correctLabel,
      v: 3,
      contentFormat: question.contentFormat === "RICH_V1" ? "RICH_V1" : "PLAIN",
      explanation: question.explanation?.trim() ? question.explanation : null,
      assets: question.contentFormat === "RICH_V1" ? assets : [],
      questionType: type,
      ...(type === "MULTIPLE_CORRECT" ? { correctLabels: options.filter((o) => o.isCorrect).map((o) => o.label) } : {}),
      ...(type === "MATCH_THE_FOLLOWING" ? { matchSpec: readMatchSpec(question.matchSpec) } : {}),
    };
  }
  if (!needsSnapshotV2(question)) return v1;
  return {
    ...v1,
    v: 2,
    contentFormat: question.contentFormat === "RICH_V1" ? "RICH_V1" : "PLAIN",
    explanation: question.explanation?.trim() ? question.explanation : null,
    assets: question.contentFormat === "RICH_V1" ? assets : [],
  };
}

/** QuestionAsset rows for the RICH_V1 questions being frozen (no query when there are none). */
async function loadSnapshotAssets(questions: QuestionWithOptions[]): Promise<Map<string, SnapshotAsset[]>> {
  const richIds = questions.filter((q) => q.contentFormat === "RICH_V1").map((q) => q.id);
  const byQuestion = new Map<string, SnapshotAsset[]>();
  if (richIds.length === 0) return byQuestion;
  const rows = await prisma.questionAsset.findMany({ where: { questionId: { in: richIds } } });
  for (const id of richIds) byQuestion.set(id, toSnapshotAssets(rows.filter((r) => r.questionId === id)));
  return byQuestion;
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
  /**
   * Formal tests only: the student's Pre-Test Setup choice. Callers pass it
   * only after studentConfigAllowed() said yes; without it a formal attempt
   * is exactly the legacy FIXED admin duration + EXAM mode.
   */
  studentConfig?: AttemptConfigChoice;
}) {
  if (params.questions.length === 0) {
    throw new TestEngineError("UNAVAILABLE", "This test has no questions yet. Please try again later.");
  }
  // Inactive (private / pre-launch) exams never get a new attempt, whatever
  // path reached here. Each start* also checks this before resume.
  await assertExamLive(params.examId);
  // Platform Controls → Start New Tests (also Lockdown / Maintenance). This
  // is the only place a TestAttempt row is created, and every start* helper
  // returns an existing IN_PROGRESS attempt before reaching it, so resume,
  // save, heartbeat, submit and auto-submit are never affected.
  await assertPlatformOpen("tests");
  // Never silently duplicate a question to pad a set.
  const questions = params.questions.filter((q, i, all) => all.findIndex((x) => x.id === q.id) === i);

  // Formal-test policy overrides any practice capability a caller passes:
  // Mock / PYQ / Grand / Live run in EXAM mode on their fixed timing unless
  // the caller passes a Pre-Test Setup choice it was allowed to offer
  // (studentConfigAllowed). Then Practice Mode (INSTANT) is always UNLIMITED
  // whatever time was posted, and Exam Mode is always timed.
  const formal = isFormalSource(params.sourceType);
  let durationMode = formal ? AttemptDurationMode.FIXED : (params.durationMode ?? AttemptDurationMode.FIXED);
  let answerMode = formal ? AttemptAnswerMode.EXAM : (params.answerMode ?? AttemptAnswerMode.EXAM);
  let durationMinutes = params.durationMinutes;
  if (formal && params.studentConfig) {
    const choice = params.studentConfig;
    if (choice.answerMode === "INSTANT") {
      answerMode = AttemptAnswerMode.INSTANT;
      durationMode = AttemptDurationMode.UNLIMITED;
      durationMinutes = 0;
    } else {
      if (choice.durationMode === "UNLIMITED") throw new TestEngineError("NOT_ALLOWED", "Choose a valid test duration.");
      answerMode = AttemptAnswerMode.EXAM;
      durationMode = AttemptDurationMode[choice.durationMode];
      // Standard = the admin-configured duration; the others follow the
      // EFFECTIVE (de-duplicated, actually frozen) question count.
      durationMinutes =
        durationMode === AttemptDurationMode.FIXED
          ? params.durationMinutes
          : practiceDurationMinutes(durationMode, questions.length, choice.customMinutes);
    }
  }

  const snapshotAssets = await loadSnapshotAssets(questions);

  // What makes an IN_PROGRESS attempt "the same test" for resume — the same
  // rule each start* helper's findResumableAttempt() uses.
  const resumeWhere: Prisma.TestAttemptWhereInput | null = params.mockTestId
    ? { mockTestId: params.mockTestId }
    : params.customModuleId
      ? { customModuleId: params.customModuleId }
      : params.grandTestId
        ? { grandTestId: params.grandTestId }
        : params.liveTestId
          ? { liveTestId: params.liveTestId }
          : params.previousYearPaperId
            ? { previousYearPaperId: params.previousYearPaperId }
            : params.testType === TestType.SUBJECT_TEST && params.subjectId
              ? { testType: TestType.SUBJECT_TEST, subjectId: params.subjectId }
              : null;

  // The attempt, its frozen question snapshots and one UNANSWERED Answer per
  // question are written in ONE transaction: a half-created attempt (row but
  // no questions) used to be resumable and crashed the player.
  const result = await prisma.$transaction(async (tx) => {
    // Idempotent start. The callers' findResumableAttempt() runs outside any
    // lock, so a double-clicked Start (or two tabs) used to create one
    // IN_PROGRESS attempt per request. A transaction-scoped advisory lock per
    // student+test serializes concurrent starts; the loser re-checks after
    // the winner commits and resumes the winner's attempt.
    if (resumeWhere) {
      const lockKey = `test-start:${params.studentId}:${JSON.stringify(resumeWhere)}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const existing = await tx.testAttempt.findFirst({
        where: { studentId: params.studentId, status: AttemptStatus.IN_PROGRESS, ...resumeWhere },
        orderBy: { startedAt: "desc" },
        include: { liveTest: { select: { endAt: true } }, mockTest: { select: { availableUntil: true } } },
      });
      if (existing && !isExpired(toServerTimedAttempt(existing))) return { attempt: existing, created: false };
    }
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
      durationMinutes,
      durationMode,
      answerMode,
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
        questionSnapshot: toSnapshot(q, snapshotAssets.get(q.id)) as never,
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
    return { attempt: created, created: true };
  }, { timeout: 20_000, maxWait: 20_000 });

  if (result.created) {
    await logActivity(params.studentId, "TEST_STARTED", { attemptId: result.attempt.id, sourceType: params.sourceType });
  }
  return result.attempt;
}

/**
 * The student's live IN_PROGRESS attempt for this test, if any. An attempt
 * whose time ran out while the student was away is finalized here (the same
 * idempotent submit getOwnedAttempt applies on read) and is NOT resumed:
 * "Start" used to hand back the dead attempt, which was then auto-submitted
 * on the next page, so the student landed on an old result instead of a test.
 */
async function findResumableAttempt(studentId: string, where: Record<string, unknown>) {
  const candidates = await prisma.testAttempt.findMany({
    where: { studentId, status: AttemptStatus.IN_PROGRESS, ...where },
    orderBy: { startedAt: "desc" },
    include: { liveTest: { select: { endAt: true } }, mockTest: { select: { availableUntil: true } } },
  });
  for (const candidate of candidates) {
    if (!(await finalizeIfExpired(candidate))) return candidate;
  }
  return null;
}

type CreateAttemptParams = Parameters<typeof createAttemptFromQuestions>[0];
type ResumableAttempt = NonNullable<Awaited<ReturnType<typeof findResumableAttempt>>>;

/** What the Pre-Test Setup screen shows before any attempt exists. Display only. */
export interface TestStartSummary {
  kind: "MOCK_TEST" | "PREVIOUS_YEAR_PAPER";
  id: string;
  title: string;
  examName: string;
  questionCount: number;
  /** The admin-configured ("Standard") duration in minutes. */
  standardMinutes: number;
  negativeMarking: number;
  instructions: string | null;
  /** False = formal fixed exam: no choices are offered (studentConfigAllowed). */
  configurable: boolean;
}

/**
 * Every gate a formal start passes, in order, WITHOUT writing anything:
 * entitlement → resume an IN_PROGRESS attempt → availability → policy. Both
 * the real start (start*Attempt) and the Pre-Test Setup preview run this
 * same plan, so the setup screen can never be reached past a gate the start
 * itself would refuse, and there is exactly one implementation of the gates.
 */
type StartPlan =
  | { resume: ResumableAttempt }
  | { resume: null; create: CreateAttemptParams; summary: TestStartSummary };

function uniqueQuestionCount(questions: { id: string }[]): number {
  return new Set(questions.map((q) => q.id)).size;
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
async function planMockTestStart(studentId: string, mockTestId: string, entryMode: AttemptEntryMode): Promise<StartPlan> {
  // Payment/entitlement gate runs BEFORE resume too, so an attempt started
  // while the content was free can't be resumed once it requires payment.
  const gate = await prisma.mockTest.findUnique({ where: { id: mockTestId }, select: { examId: true, testSeriesId: true, accessType: true } });
  if (gate) await assertExamLive(gate.examId);
  if (gate) await assertContentAccess(studentId, { kind: "MOCK_TEST", id: mockTestId, ...gate });

  const resumable = await findResumableAttempt(studentId, { mockTestId });
  if (resumable) return { resume: resumable };

  const mockTest = await prisma.mockTest.findFirst({
    // A published mock inside an unpublished (draft/archived) series is not live.
    where: { id: mockTestId, ...LIVE_MOCK_TEST_WHERE },
    // Only PUBLISHED questions reach students: a bulk import may attach rows
    // it auto-saved as Draft (missing image / no correct answer), which stay
    // reserved in the test's order until an admin reviews and publishes them.
    include: {
      exam: { select: { name: true, instructions: true } },
      testSeries: { select: { instructions: true } },
      questions: {
        where: { question: { status: QuestionStatus.PUBLISHED } },
        orderBy: { order: "asc" },
        include: { question: { include: { options: true } } },
      },
    },
  });
  if (!mockTest) throw new TestEngineError("UNAVAILABLE", "This mock test is not available.");
  if (!isMockTestAvailable(mockTest)) {
    throw new TestEngineError("UNAVAILABLE",
      deriveMockTestAvailability(mockTest) === "CLOSED"
        ? "This test window has closed. New attempts are no longer accepted."
        : "This test is not available yet."
    );
  }

  // Live CBT enrollment (lib/live-cbt.ts): when enabled, only an enrolled
  // student may start. Off (every existing mock) = unchanged behaviour.
  if (mockTest.enrollmentEnabled) {
    const enrolled = await prisma.mockTestEnrollment.findUnique({
      where: { mockTestId_studentId: { mockTestId, studentId } },
      select: { id: true },
    });
    if (!enrolled) throw new TestEngineError("UNAVAILABLE", "Enroll in this live test to start it.");
  }

  if (mockTest.attemptPolicy === "SINGLE_ATTEMPT") {
    const priorSubmission = await prisma.testAttempt.findFirst({
      where: { studentId, mockTestId, status: AttemptStatus.SUBMITTED },
      select: { id: true },
    });
    if (priorSubmission) throw new TestEngineError("UNAVAILABLE", "You have already attempted this test. Retakes are not allowed.");
  }

  const questions = mockTest.questions.map((mq) => mq.question as unknown as QuestionWithOptions);
  return {
    resume: null,
    create: {
      studentId,
      sourceType: AttemptSourceType.MOCK_TEST,
      examId: mockTest.examId,
      mockTestId: mockTest.id,
      durationMinutes: mockTest.durationMinutes,
      negativeMarking: mockTest.negativeMarking,
      questions,
      entryMode,
    },
    summary: {
      kind: "MOCK_TEST",
      id: mockTest.id,
      title: mockTest.title,
      examName: mockTest.exam.name,
      questionCount: uniqueQuestionCount(questions),
      standardMinutes: mockTest.durationMinutes,
      negativeMarking: mockTest.negativeMarking,
      instructions: mockTest.instructions ?? mockTest.testSeries?.instructions ?? mockTest.exam.instructions ?? null,
      // Offline OMR entry is bulk answer keying from a printed paper: always
      // the formal exam (no per-question reveal while transcribing a sheet).
      configurable: entryMode === AttemptEntryMode.ONLINE && studentConfigAllowed(AttemptSourceType.MOCK_TEST, mockTest),
    },
  };
}

/**
 * Applies a plan. A resumable attempt is always returned untouched (its
 * frozen configuration wins over whatever was submitted now); otherwise the
 * student's choice is applied only when the plan allows configuration.
 */
async function executeStartPlan(plan: StartPlan, config?: AttemptConfigChoice | null) {
  if (plan.resume) return plan.resume;
  return createAttemptFromQuestions({
    ...plan.create,
    studentConfig: plan.summary.configurable && config ? config : undefined,
  });
}

/**
 * Pre-Test Setup preview: the same gates as the real start, plus Platform
 * Controls → Start New Tests, but nothing is written. Returns the attempt to
 * resume when one is running (no setup is shown for it), else the summary.
 * Throws exactly what the start would (PaymentRequiredError,
 * PlatformPausedError, TestEngineError) so callers reuse startOrExplain.
 */
export async function previewFormalTestStart(
  studentId: string,
  target: { kind: "MOCK_TEST" | "PREVIOUS_YEAR_PAPER"; id: string }
): Promise<{ resume: ResumableAttempt } | { resume: null; summary: TestStartSummary }> {
  const plan =
    target.kind === "MOCK_TEST"
      ? await planMockTestStart(studentId, target.id, AttemptEntryMode.ONLINE)
      : await planPreviousYearPaperStart(studentId, target.id);
  if (plan.resume) return { resume: plan.resume };
  await assertPlatformOpen("tests");
  if (plan.summary.questionCount === 0) throw new TestEngineError("UNAVAILABLE", "This test has no questions yet. Please try again later.");
  return { resume: null, summary: plan.summary };
}

export async function startMockTestAttempt(
  studentId: string,
  mockTestId: string,
  entryMode: AttemptEntryMode = AttemptEntryMode.ONLINE,
  config?: AttemptConfigChoice | null
) {
  return executeStartPlan(await planMockTestStart(studentId, mockTestId, entryMode), config);
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
  // An OMR sheet has one bubble per question: a multiple-correct answer can't be
  // entered from it (NEET Phase 4), so such a mock is online-only.
  const multi = await prisma.mockTestQuestion.count({ where: { mockTestId, question: { questionType: "MULTIPLE_CORRECT" } } });
  if (multi > 0) {
    throw new TestEngineError("UNAVAILABLE", "This test has multiple-correct questions, which can't be entered from an OMR sheet. Take it online instead.");
  }
  return startMockTestAttempt(studentId, mockTestId, AttemptEntryMode.OFFLINE_OMR_ENTRY);
}

const CUSTOM_MODULE_QUESTIONS_INCLUDE = {
  questions: { orderBy: { order: "asc" as const }, include: { question: { include: { options: true } } } },
};

type CustomModuleWithQuestions = Awaited<
  ReturnType<typeof prisma.customModule.findFirstOrThrow<{ include: typeof CUSTOM_MODULE_QUESTIONS_INCLUDE }>>
>;

async function startFromCustomModuleRow(studentId: string, customModule: CustomModuleWithQuestions) {
  await assertExamLive(customModule.examId);
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
  if (!customModule) throw new TestEngineError("UNAVAILABLE", "This custom module is not available.");
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
  if (!customModule) throw new TestEngineError("UNAVAILABLE", "This shared module link is invalid or no longer available.");
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
  if (!grandTest) throw new TestEngineError("UNAVAILABLE", "This grand test is not available.");

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
  if (!liveTest) throw new TestEngineError("UNAVAILABLE", "This live test does not exist.");

  const state = deriveLiveTestState(liveTest, new Date());
  if (state === "DRAFT") throw new TestEngineError("UNAVAILABLE", "This live test has not been published yet.");
  if (state === "CANCELLED") throw new TestEngineError("UNAVAILABLE", "This live test was cancelled.");
  if (state === "SCHEDULED") throw new TestEngineError("UNAVAILABLE", "This live test has not started yet.");
  if (state === "ENDED" || state === "RESULT_PUBLISHED") throw new TestEngineError("UNAVAILABLE", "This live test has ended.");

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

async function planPreviousYearPaperStart(studentId: string, paperId: string): Promise<StartPlan> {
  const gate = await prisma.previousYearPaper.findUnique({ where: { id: paperId }, select: { examId: true } });
  if (gate) await assertExamLive(gate.examId);
  if (gate) await assertContentAccess(studentId, { kind: "PREVIOUS_YEAR_PAPER", id: paperId, examId: gate.examId });

  const resumable = await findResumableAttempt(studentId, { previousYearPaperId: paperId });
  if (resumable) return { resume: resumable };

  const paper = await prisma.previousYearPaper.findFirst({
    where: { id: paperId, isActive: true },
    include: { exam: true },
  });
  if (!paper) throw new TestEngineError("UNAVAILABLE", "This paper is not available.");

  // Full-paper integrity: the whole published paper in its original order
  // (import order = paper order; code breaks ties). Never sampled or shuffled.
  const questions = (await prisma.question.findMany({
    where: { previousYearPaperId: paperId, status: QuestionStatus.PUBLISHED },
    orderBy: [{ createdAt: "asc" }, { code: "asc" }],
    include: { options: true },
  })) as unknown as QuestionWithOptions[];

  // Paper-level duration wins; frozen onto the NEW attempt only (history is immutable).
  const standardMinutes = paper.durationMinutes ?? paper.exam.durationMinutes ?? 120;
  return {
    resume: null,
    create: {
      studentId,
      sourceType: AttemptSourceType.PREVIOUS_YEAR_PAPER,
      examId: paper.examId,
      previousYearPaperId: paper.id,
      durationMinutes: standardMinutes,
      negativeMarking: paper.exam.negativeMarking ?? 0,
      questions,
    },
    summary: {
      kind: "PREVIOUS_YEAR_PAPER",
      id: paper.id,
      title: paper.year ? `${paper.title} (${paper.year})` : paper.title,
      examName: paper.exam.name,
      questionCount: uniqueQuestionCount(questions),
      standardMinutes,
      negativeMarking: paper.exam.negativeMarking ?? 0,
      instructions: paper.exam.instructions ?? null,
      configurable: studentConfigAllowed(AttemptSourceType.PREVIOUS_YEAR_PAPER),
    },
  };
}

export async function startPreviousYearPaperAttempt(studentId: string, paperId: string, config?: AttemptConfigChoice | null) {
  return executeStartPlan(await planPreviousYearPaperStart(studentId, paperId), config);
}

export interface SubjectTestSelection extends QuestionSelectionFilters {
  durationMinutes: number;
  /** Requested size. The attempt uses min(count, eligible pool) — see selectPublishedQuestions#allowFewer. */
  count: number;
  /** Test on the Go: 1 question = 1 minute, so the duration follows the EFFECTIVE count, not the requested one. */
  minutesPerQuestion?: number;
  /** Student-practice answer mode; INSTANT is permitted for subject practice (instantAnswerAllowed). */
  answerMode?: AttemptAnswerMode;
  /**
   * UniversalTestSetup time choice. When set, the frozen minutes come from
   * practiceDurationMinutes (PER_QUESTION = effective count, UNLIMITED =
   * untimed, CUSTOM = customMinutes). Unset keeps the legacy behaviour.
   */
  durationMode?: AttemptDurationMode;
  customMinutes?: number;
}

function subjectTestTiming(selection: SubjectTestSelection, effectiveCount: number) {
  if (selection.durationMode) {
    return {
      durationMode: selection.durationMode,
      durationMinutes: practiceDurationMinutes(selection.durationMode, effectiveCount, selection.customMinutes),
    };
  }
  return selection.minutesPerQuestion
    ? { durationMode: AttemptDurationMode.PER_QUESTION, durationMinutes: effectiveCount * selection.minutesPerQuestion }
    : { durationMode: AttemptDurationMode.CUSTOM, durationMinutes: selection.durationMinutes };
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
  if (selection.examId) await assertExamLive(selection.examId);
  if (selection.examId) await assertContentAccess(studentId, { kind: "SUBJECT_TEST", id: null, examId: selection.examId });

  const resumable = await findResumableAttempt(studentId, { testType: TestType.SUBJECT_TEST, subjectId: selection.subjectId });
  if (resumable) return resumable;
  if (!selection.subjectId) throw new TestEngineError("UNAVAILABLE", "A subject is required to start a subject test.");
  if (!selection.examId) throw new TestEngineError("UNAVAILABLE", "An exam is required to start a subject test.");

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
    ...subjectTestTiming(selection, questions.length),
    answerMode: selection.answerMode === AttemptAnswerMode.INSTANT ? AttemptAnswerMode.INSTANT : AttemptAnswerMode.EXAM,
    negativeMarking: 0,
    questions: questions as unknown as QuestionWithOptions[],
  });
}

const EDITABLE_ATTEMPT_SELECT = {
  id: true,
  sourceType: true,
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
    select: { id: true, questionSnapshot: true, answer: { select: { selectedOptionLabel: true, selectedLabels: true, revealedAt: true, status: true } } },
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
  // A multiple-correct question is saved only as a label set (saveAnswerLabels).
  if (snapshotQuestionType(attemptQuestion.questionSnapshot as unknown as QuestionSnapshot) === "MULTIPLE_CORRECT") {
    throw new TestEngineError("INVALID_OPTION", "This question takes one or more options.");
  }
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
 * May this IN_PROGRESS attempt reveal a question's answer right now? Only
 * when it was frozen INSTANT at creation. Grand/Live never. A formal Mock
 * additionally needs its answer key to be public right now: if an admin
 * switched the mock to a held result (window / AFTER_WINDOW / CUSTOM_DATE)
 * after the attempt started, the reveal is refused rather than leaking a key
 * the Review page itself would still hold back.
 */
async function instantRevealPermitted(attempt: { id: string; sourceType: AttemptSourceType; answerMode: AttemptAnswerMode }): Promise<boolean> {
  if (attempt.answerMode !== AttemptAnswerMode.INSTANT) return false;
  if (attempt.sourceType === AttemptSourceType.GRAND_TEST || attempt.sourceType === AttemptSourceType.LIVE_TEST) return false;
  if (attempt.sourceType !== AttemptSourceType.MOCK_TEST) return true;
  const row = await prisma.testAttempt.findUnique({
    where: { id: attempt.id },
    select: { mockTest: { select: { availableUntil: true, resultReleaseMode: true, resultReleaseAt: true, enrollmentEnabled: true } } },
  });
  return !!row?.mockTest && studentConfigAllowed(AttemptSourceType.MOCK_TEST, row.mockTest) && isMockResultReleased(row.mockTest);
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
): Promise<{ selectedOptionLabel: string | null; correctLabel: string; isCorrect: boolean; explanation?: ExplanationView }> {
  if (!selectedOptionLabel) throw new TestEngineError("NO_SELECTION", "Choose an option to check your answer.");
  const { attempt, attemptQuestion } = await loadEditableQuestion(attemptId, studentId, questionId, selectedOptionLabel);
  if (snapshotQuestionType(attemptQuestion.questionSnapshot as unknown as QuestionSnapshot) === "MULTIPLE_CORRECT") {
    throw new TestEngineError("INVALID_OPTION", "This question takes one or more options.");
  }
  if (!(await instantRevealPermitted(attempt))) {
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
  const snapshot = attemptQuestion.questionSnapshot as unknown as QuestionSnapshot;
  const correctLabel = snapshot.correctLabel ?? "";
  // A v2 human explanation is released together with the answer key, only here.
  const explanation = explanationView(snapshot);
  return {
    selectedOptionLabel: answer.selectedOptionLabel,
    correctLabel,
    isCorrect: !!answer.selectedOptionLabel && answer.selectedOptionLabel === correctLabel,
    ...(explanation ? { explanation } : {}),
  };
}

/**
 * MULTIPLE_CORRECT only (NEET Phase 4): persist one answer as a label SET.
 * Same contract as saveAnswer — one conditional UPDATE guarded by the
 * monotonic `seq`, IN_PROGRESS and not-revealed, so a stale or replayed
 * request never overwrites a newer set and exactly one Answer row exists.
 * The set is validated against the frozen options and stored normalized
 * (unique, option order); `[]` is "no answer". selectedOptionLabel stays null.
 */
export async function saveAnswerLabels(
  attemptId: string,
  studentId: string,
  questionId: string,
  labels: unknown,
  markForReview: boolean,
  seq?: number
): Promise<{ applied: boolean }> {
  const { attemptQuestion } = await loadEditableQuestion(attemptId, studentId, questionId, null);
  const set = multiLabelSet(attemptQuestion.questionSnapshot, labels);
  const saveSeq = typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : Date.now();
  const status = answerStatusFor(set.length ? set[0] : null, markForReview);
  const revealed = !!attemptQuestion.answer?.revealedAt;
  if (revealed && !sameStoredSet(attemptQuestion.answer?.selectedLabels, set)) {
    throw new TestEngineError("LOCKED", "This answer was already checked and can no longer be changed.");
  }
  const result = await prisma.answer.updateMany({
    where: {
      attemptQuestionId: attemptQuestion.id,
      saveSeq: { lt: saveSeq },
      attempt: { status: AttemptStatus.IN_PROGRESS },
      ...(revealed ? { selectedLabels: { equals: set } } : { revealedAt: null }),
    },
    data: { selectedLabels: set, selectedOptionLabel: null, status, answeredAt: set.length ? new Date() : null, saveSeq },
  });
  return { applied: result.count === 1 };
}

/**
 * MULTIPLE_CORRECT Practice Mode check (NEET Phase 4): the student's set is
 * committed and frozen in the same conditional update that stamps revealedAt
 * (first commit wins), and only then is the full correct set returned.
 */
export async function revealAnswerLabels(
  attemptId: string,
  studentId: string,
  questionId: string,
  labels: unknown,
  seq?: number
): Promise<{ selectedLabels: string[]; correctLabels: string[]; isCorrect: boolean; explanation?: ExplanationView }> {
  const { attempt, attemptQuestion } = await loadEditableQuestion(attemptId, studentId, questionId, null);
  const set = multiLabelSet(attemptQuestion.questionSnapshot, labels);
  if (set.length === 0) throw new TestEngineError("NO_SELECTION", "Choose at least one option to check your answer.");
  if (!(await instantRevealPermitted(attempt))) {
    throw new TestEngineError("NOT_ALLOWED", "Answers are shown after you submit this test.");
  }
  const marked =
    attemptQuestion.answer?.status === AnswerStatus.ANSWERED_AND_MARKED || attemptQuestion.answer?.status === AnswerStatus.MARKED_FOR_REVIEW;
  const now = new Date();
  await prisma.answer.updateMany({
    where: { attemptQuestionId: attemptQuestion.id, revealedAt: null, attempt: { status: AttemptStatus.IN_PROGRESS } },
    data: {
      selectedLabels: set,
      selectedOptionLabel: null,
      status: answerStatusFor(set[0], marked),
      answeredAt: now,
      revealedAt: now,
      saveSeq: typeof seq === "number" && Number.isFinite(seq) && seq > 0 ? seq : now.getTime(),
    },
  });
  const answer = await prisma.answer.findUnique({ where: { attemptQuestionId: attemptQuestion.id }, select: { selectedLabels: true, revealedAt: true } });
  if (!answer?.revealedAt) throw new TestEngineError("NOT_EDITABLE", "This test has already been submitted.");
  const snapshot = attemptQuestion.questionSnapshot as unknown as QuestionSnapshot;
  const correctLabels = snapshotCorrectLabels(snapshot);
  const selectedLabels = answer.selectedLabels ?? [];
  const explanation = explanationView(snapshot);
  return {
    selectedLabels,
    correctLabels,
    isCorrect: gradeLabelSet(selectedLabels, correctLabels) === true,
    ...(explanation ? { explanation } : {}),
  };
}

/** The validated, normalized label set for a MULTIPLE_CORRECT snapshot; anything else is refused. */
function multiLabelSet(rawSnapshot: unknown, labels: unknown): string[] {
  const snapshot = rawSnapshot as QuestionSnapshot;
  if (snapshotQuestionType(snapshot) !== "MULTIPLE_CORRECT" || !Array.isArray(snapshot?.options)) {
    throw new TestEngineError("INVALID_OPTION", "This question takes a single option.");
  }
  const set = normalizeLabelSet(labels, snapshot.options.map((o) => o.label));
  if (!set.ok) throw new TestEngineError("INVALID_OPTION", "That option is not part of this question.");
  return set.labels;
}

function sameStoredSet(stored: string[] | null | undefined, set: string[]): boolean {
  const a = stored ?? [];
  return a.length === set.length && a.every((l, i) => l === set[i]);
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
  // SUBMITTED: idempotent. ABANDONED (content-reset): kept exactly as it was,
  // never graded or turned into a result by a stale tab's submit.
  if (attempt.status !== AttemptStatus.IN_PROGRESS) return attempt;

  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  // isCorrect is written with one updateMany per value (true / false / null)
  // instead of one UPDATE per question: the same final rows, but the submit
  // transaction holds a pooled connection for ~5 statements instead of ~110 —
  // what lets a Live CBT's whole cohort auto-submit at the same deadline.
  const idsByResult = { correct: [] as string[], incorrect: [] as string[], unanswered: [] as string[] };
  const creates: Prisma.PrismaPromise<unknown>[] = [];
  for (const tq of attempt.questions) {
    const snapshot = tq.questionSnapshot as unknown as QuestionSnapshot;
    const answer = tq.answer;
    const selected = answer?.selectedOptionLabel ?? null;
    let isCorrect: boolean | null = null;

    if (snapshotQuestionType(snapshot) === "MULTIPLE_CORRECT") {
      // ALL-OR-NOTHING on the frozen set, order-independent; [] = unanswered.
      isCorrect = gradeLabelSet(answer?.selectedLabels ?? [], snapshotCorrectLabels(snapshot));
      if (isCorrect === null) unansweredCount += 1;
      else if (isCorrect) correctCount += 1;
      else incorrectCount += 1;
    } else if (!selected) {
      unansweredCount += 1;
    } else if (selected === snapshot.correctLabel) {
      isCorrect = true;
      correctCount += 1;
    } else {
      isCorrect = false;
      incorrectCount += 1;
    }

    if (answer) idsByResult[isCorrect === true ? "correct" : isCorrect === false ? "incorrect" : "unanswered"].push(answer.id);
    else {
      creates.push(
        prisma.answer.create({
          data: { attemptId, attemptQuestionId: tq.id, studentId, questionId: tq.questionId, isCorrect, status: AnswerStatus.UNANSWERED },
        })
      );
    }
  }
  const updates: Prisma.PrismaPromise<unknown>[] = [
    ...([
      [idsByResult.correct, true],
      [idsByResult.incorrect, false],
      [idsByResult.unanswered, null],
    ] as const)
      .filter(([ids]) => ids.length > 0)
      .map(([ids, isCorrect]) => prisma.answer.updateMany({ where: { id: { in: [...ids] }, attemptId }, data: { isCorrect } })),
    ...creates,
  ];

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
  // Only an attempt taken as the real exam (Standard time + answers after the
  // test) can rank: a 1-min/question, custom-time or answer-after-each-question
  // attempt is practice, like a retake, and never displaces/creates a rank.
  let isLeaderboardAttempt = false;
  const examConditions = attempt.durationMode === AttemptDurationMode.FIXED && attempt.answerMode === AttemptAnswerMode.EXAM;
  if (attempt.sourceType === AttemptSourceType.MOCK_TEST && attempt.mockTestId && examConditions) {
    const priorLeaderboardAttempt = await prisma.testAttempt.findFirst({
      where: { studentId, mockTestId: attempt.mockTestId, status: AttemptStatus.SUBMITTED, isLeaderboardAttempt: true },
      select: { id: true },
    });
    isLeaderboardAttempt = !priorLeaderboardAttempt;
  }

  // The status flip is conditional on IN_PROGRESS: two concurrent submits
  // (double click, timeout + manual, two tabs) grade the same frozen answers
  // to the same values, and only the one that actually flips the status logs
  // the submission.
  const results = await prisma.$transaction([
    ...updates,
    prisma.testAttempt.updateMany({
      where: { id: attemptId, status: AttemptStatus.IN_PROGRESS },
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

  const flipped = (results[results.length - 1] as { count: number }).count === 1;
  if (flipped) await logActivity(studentId, "TEST_SUBMITTED", { attemptId, score, maxScore });

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