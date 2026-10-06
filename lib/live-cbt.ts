import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertExamLive } from "@/lib/exam-live";
import { getContentAccess } from "@/lib/payments/access";
import { LIVE_MOCK_TEST_WHERE, deriveMockTestAvailability } from "@/lib/mock-test-schedule";
import { enrollmentWindowState } from "@/lib/live-cbt-core";
import { finalizeIfExpired } from "@/lib/test-attempt";

/**
 * Live CBT (a Mock Test with a Fixed Window + optional enrollment). No
 * separate engine: the attempt, timer, autosave, submit, result, review,
 * Ask AI and leaderboard are the normal Mock Test ones. This module only
 * adds per-test enrollment and the window-end sweep.
 */

export class EnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollmentError";
  }
}

export async function isEnrolledInMockTest(studentId: string, mockTestId: string): Promise<boolean> {
  const row = await prisma.mockTestEnrollment.findUnique({ where: { mockTestId_studentId: { mockTestId, studentId } }, select: { id: true } });
  return row !== null;
}

export async function countMockTestEnrollments(mockTestId: string): Promise<number> {
  return prisma.mockTestEnrollment.count({ where: { mockTestId } });
}

/**
 * Enroll a student in one enrollment-enabled Mock Test. Idempotent (the
 * unique (mockTestId, studentId) index decides a race); never creates a
 * TestAttempt. Refuses: unpublished/hidden test, inactive exam, enrollment
 * off, outside the enrollment window, test window already closed, or no
 * access to a PAID test (enrolling can't bypass payment).
 */
export async function enrollInMockTest(studentId: string, mockTestId: string, now: Date = new Date()): Promise<"ENROLLED" | "ALREADY_ENROLLED"> {
  const mock = await prisma.mockTest.findFirst({
    where: { id: mockTestId, ...LIVE_MOCK_TEST_WHERE },
    select: {
      id: true,
      examId: true,
      testSeriesId: true,
      accessType: true,
      availableFrom: true,
      availableUntil: true,
      enrollmentEnabled: true,
      enrollmentOpensAt: true,
      enrollmentClosesAt: true,
    },
  });
  if (!mock) throw new EnrollmentError("This test is not available.");
  await assertExamLive(mock.examId);
  if (await isEnrolledInMockTest(studentId, mockTestId)) return "ALREADY_ENROLLED";

  const state = enrollmentWindowState(mock, now);
  if (state === "DISABLED") throw new EnrollmentError("Enrollment is not open for this test.");
  if (state === "NOT_OPEN_YET") throw new EnrollmentError("Enrollment has not opened yet.");
  if (state === "CLOSED" || deriveMockTestAvailability(mock, now) === "CLOSED") throw new EnrollmentError("Enrollment for this test has closed.");

  const access = await getContentAccess(studentId, {
    kind: "MOCK_TEST",
    id: mock.id,
    examId: mock.examId,
    testSeriesId: mock.testSeriesId,
    accessType: mock.accessType,
  });
  if (!access.allowed) throw new EnrollmentError("Unlock this test first — enrollment needs access to the test.");

  try {
    await prisma.mockTestEnrollment.create({ data: { mockTestId, studentId } });
    return "ENROLLED";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "ALREADY_ENROLLED";
    throw error;
  }
}

/**
 * Window-end sweep (cron: scripts/finalize-live-attempts.ts, every minute).
 * Finalizes every IN_PROGRESS Mock Test attempt whose Fixed Window has
 * closed, through the engine's own idempotent finalizeIfExpired →
 * submitAttempt: grades only answers saved before the deadline (saves after
 * it are refused), caps time at the window, and flips IN_PROGRESS →
 * SUBMITTED conditionally — a SUBMITTED or ABANDONED attempt is never
 * touched. Scoped to closed windows only, so ordinary practice attempts are
 * left exactly as before.
 */
export async function finalizeClosedWindowAttempts(now: Date = new Date(), batch = 500): Promise<{ candidates: number; finalized: number }> {
  const candidates = await prisma.testAttempt.findMany({
    where: { status: "IN_PROGRESS", sourceType: "MOCK_TEST", mockTest: { is: { availableUntil: { lte: now } } } },
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
    orderBy: { startedAt: "asc" },
    take: batch,
  });
  let finalized = 0;
  for (const attempt of candidates) {
    if (await finalizeIfExpired(attempt)) finalized += 1;
  }
  return { candidates: candidates.length, finalized };
}

export type LiveCandidateStatus = "NOT_STARTED" | "ABSENT" | "IN_PROGRESS" | "SUBMITTED" | "AUTO_SUBMITTED" | "FINALIZED_AFTER_WINDOW";

export interface LiveCandidateRow {
  studentDbId: string;
  name: string;
  studentCode: string;
  contact: string | null;
  enrolledAt: Date | null;
  status: LiveCandidateStatus;
  attemptId: string | null;
  startedAt: Date | null;
  submittedAt: Date | null;
  score: number | null;
  maxScore: number | null;
  correct: number | null;
  incorrect: number | null;
  unanswered: number | null;
  rank: number | null;
  /** Submitted attempts this student started after the window (later practice); never ranked as the live attempt. */
  laterAttempts: number;
}

/**
 * Admin Live CBT Monitor (read-only): every enrolled student plus anyone
 * who attempted the test inside its window, with the live attempt's state.
 * The live attempt = the student's earliest attempt started before the
 * window end. How it ended is derived from stored times (no new column):
 * submitted before its own deadline = by the student; within 10 s after =
 * the player's time-up auto-submit; later = finalized by the window-end
 * sweep (browser closed). Ranks come from lib/leaderboard.ts (same rules
 * students see); the page shows scores and ranks only once the result is
 * released (lib/mock-test-schedule.ts#isMockResultReleased).
 */
export async function getLiveCbtMonitor(mockTestId: string, now: Date = new Date()) {
  const { getTestRanksForAdmin } = await import("@/lib/leaderboard");
  const mock = await prisma.mockTest.findUniqueOrThrow({
    where: { id: mockTestId },
    select: { id: true, availableFrom: true, availableUntil: true, enrollmentEnabled: true, durationMinutes: true },
  });
  const windowEnd = mock.availableUntil;
  const [enrollments, attempts, ranks] = await Promise.all([
    prisma.mockTestEnrollment.findMany({ where: { mockTestId }, select: { studentId: true, enrolledAt: true } }),
    prisma.testAttempt.findMany({
      where: { mockTestId, sourceType: "MOCK_TEST" },
      orderBy: { startedAt: "asc" },
      select: {
        id: true, studentId: true, status: true, startedAt: true, submittedAt: true, durationMinutes: true,
        score: true, maxScore: true, correctCount: true, incorrectCount: true, unansweredCount: true,
      },
    }),
    getTestRanksForAdmin({ kind: "MOCK_TEST", id: mockTestId }),
  ]);

  const liveByStudent = new Map<string, (typeof attempts)[number]>();
  const later = new Map<string, number>();
  for (const a of attempts) {
    const inWindow = !windowEnd || a.startedAt < windowEnd;
    if (inWindow && !liveByStudent.has(a.studentId)) liveByStudent.set(a.studentId, a);
    else if (a.status === "SUBMITTED") later.set(a.studentId, (later.get(a.studentId) ?? 0) + 1);
  }
  const studentIds = [...new Set([...enrollments.map((e) => e.studentId), ...liveByStudent.keys()])];
  const students = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, name: true, studentId: true, email: true, mobile: true },
  });
  const studentById = new Map(students.map((s) => [s.id, s]));
  const enrolledAt = new Map(enrollments.map((e) => [e.studentId, e.enrolledAt]));
  const windowClosed = !!windowEnd && now >= windowEnd;

  const rows: LiveCandidateRow[] = studentIds.map((id) => {
    const s = studentById.get(id);
    const a = liveByStudent.get(id) ?? null;
    let status: LiveCandidateStatus = windowClosed ? "ABSENT" : "NOT_STARTED";
    if (a?.status === "IN_PROGRESS") status = "IN_PROGRESS";
    else if (a?.status === "SUBMITTED" && a.submittedAt) {
      const ownEnd = a.startedAt.getTime() + a.durationMinutes * 60_000;
      const deadline = windowEnd ? Math.min(ownEnd, windowEnd.getTime()) : ownEnd;
      const t = a.submittedAt.getTime();
      status = t < deadline - 2_000 ? "SUBMITTED" : t <= deadline + 10_000 ? "AUTO_SUBMITTED" : "FINALIZED_AFTER_WINDOW";
    }
    const rank = a ? ranks.byStudent.get(id) : undefined;
    return {
      studentDbId: id,
      name: s?.name ?? "Former Student",
      studentCode: s?.studentId ?? "—",
      contact: s?.email ?? s?.mobile ?? null,
      enrolledAt: enrolledAt.get(id) ?? null,
      status,
      attemptId: a?.id ?? null,
      startedAt: a?.startedAt ?? null,
      submittedAt: a?.submittedAt ?? null,
      score: a?.score ?? null,
      maxScore: a?.maxScore ?? null,
      correct: a?.correctCount ?? null,
      incorrect: a?.incorrectCount ?? null,
      unanswered: a?.unansweredCount ?? null,
      rank: rank && rank.attemptId === a?.id ? rank.rank : null,
      laterAttempts: later.get(id) ?? 0,
    };
  });
  const order: Record<LiveCandidateStatus, number> = { IN_PROGRESS: 0, SUBMITTED: 1, AUTO_SUBMITTED: 1, FINALIZED_AFTER_WINDOW: 1, NOT_STARTED: 2, ABSENT: 2 };
  rows.sort((x, y) => order[x.status] - order[y.status] || (x.rank ?? 1e9) - (y.rank ?? 1e9) || x.name.localeCompare(y.name));

  const count = (st: LiveCandidateStatus) => rows.filter((r) => r.status === st).length;
  const started = rows.filter((r) => r.attemptId).length;
  return {
    windowClosed,
    summary: {
      enrolled: enrollments.length,
      started,
      notStarted: count("NOT_STARTED"),
      absent: count("ABSENT"),
      inProgress: count("IN_PROGRESS"),
      submittedByStudent: count("SUBMITTED"),
      autoSubmitted: count("AUTO_SUBMITTED"),
      finalizedAfterWindow: count("FINALIZED_AFTER_WINDOW"),
      completed: count("SUBMITTED") + count("AUTO_SUBMITTED") + count("FINALIZED_AFTER_WINDOW"),
      startedWithoutEnrollment: rows.filter((r) => r.attemptId && !r.enrolledAt).length,
      ranked: ranks.total,
      laterPracticeAttempts: [...later.values()].reduce((x, y) => x + y, 0),
    },
    rows,
  };
}
