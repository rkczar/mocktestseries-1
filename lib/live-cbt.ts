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
