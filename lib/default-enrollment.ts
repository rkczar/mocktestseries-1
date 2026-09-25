import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Default exam enrollment — the ONE place that decides which exam a student
 * is enrolled into automatically, and the one idempotent writer for it.
 *
 * Configuration lives in the existing key-value `Setting` table (no schema
 * change), key `student.defaultExam`, value `{ examId: string | null }`:
 *   - row present, examId set  → that exam (only while it is isActive)
 *   - row present, examId null → auto-enrollment explicitly disabled
 *   - row absent               → the sole active exam, if exactly one exists
 * So today (RUHS MO is the only active exam) every new student is enrolled
 * into it; once a second exam is activated without choosing a default,
 * auto-enrollment simply stops and the Dashboard's existing "Enroll in an
 * exam" prompt takes over — nobody is ever auto-enrolled into every exam.
 *
 * Enrollment itself stays the existing StudentExamEnrollment row (unique on
 * studentId+examId), written by upsert, so repeated calls, concurrent logins
 * and the backfill script can never create a duplicate.
 */

export const DEFAULT_EXAM_SETTING_KEY = "student.defaultExam";

interface StoredDefaultExam {
  examId: string | null;
}

/** The configured default exam id, `null` when disabled, `undefined` when never configured. */
export async function getConfiguredDefaultExamId(): Promise<string | null | undefined> {
  const row = await prisma.setting.findUnique({ where: { key: DEFAULT_EXAM_SETTING_KEY } });
  if (!row) return undefined;
  const value = row.value as Partial<StoredDefaultExam> | null;
  return typeof value?.examId === "string" ? value.examId : null;
}

export async function setConfiguredDefaultExamId(examId: string | null): Promise<void> {
  const value: StoredDefaultExam = { examId };
  await prisma.setting.upsert({
    where: { key: DEFAULT_EXAM_SETTING_KEY },
    update: { value: value as unknown as Prisma.InputJsonValue },
    create: { key: DEFAULT_EXAM_SETTING_KEY, value: value as unknown as Prisma.InputJsonValue },
  });
}

/** The exam new students are enrolled into, or null when there is no (active) default. */
export async function resolveDefaultExam(): Promise<{ id: string; name: string } | null> {
  const configured = await getConfiguredDefaultExamId();
  if (configured === null) return null;
  if (configured) {
    return prisma.exam.findFirst({ where: { id: configured, isActive: true }, select: { id: true, name: true } });
  }
  const active = await prisma.exam.findMany({ where: { isActive: true }, select: { id: true, name: true }, take: 2 });
  return active.length === 1 ? active[0] : null;
}

export type DefaultEnrollmentOutcome =
  | { status: "ENROLLED"; examId: string }
  | { status: "ALREADY_ENROLLED" }
  | { status: "OPTED_OUT"; examId: string }
  | { status: "NO_DEFAULT_EXAM" };

/**
 * Enroll the student into the default exam unless they already have an
 * enrollment in any ACTIVE exam (they've chosen, or were already given, an
 * exam — never overwrite that) or they deliberately unenrolled from the
 * default exam before (EXAM_UNENROLLED activity — respected forever, so the
 * Dashboard safety net never re-adds an exam a student removed).
 */
export async function ensureDefaultExamEnrollment(studentId: string): Promise<DefaultEnrollmentOutcome> {
  const hasActiveEnrollment = await prisma.studentExamEnrollment.findFirst({
    where: { studentId, exam: { isActive: true } },
    select: { id: true },
  });
  if (hasActiveEnrollment) return { status: "ALREADY_ENROLLED" };

  const exam = await resolveDefaultExam();
  if (!exam) return { status: "NO_DEFAULT_EXAM" };

  const optedOut = await prisma.studentActivity.findFirst({
    where: { studentId, activity: "EXAM_UNENROLLED", metadata: { path: ["examId"], equals: exam.id } },
    select: { id: true },
  });
  if (optedOut) return { status: "OPTED_OUT", examId: exam.id };

  try {
    await prisma.studentExamEnrollment.upsert({
      where: { studentId_examId: { studentId, examId: exam.id } },
      update: {},
      create: { studentId, examId: exam.id },
    });
  } catch (error) {
    // Two concurrent first logins can both reach the create branch; the
    // unique constraint rejects the second, which is exactly the outcome we want.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { status: "ALREADY_ENROLLED" };
    throw error;
  }
  await prisma.studentActivity.create({
    data: { studentId, activity: "EXAM_ENROLLED", metadata: { examId: exam.id, source: "DEFAULT_EXAM" } },
  });
  return { status: "ENROLLED", examId: exam.id };
}

/** Never lets default enrollment break sign-up/sign-in — the Dashboard safety net retries on next visit. */
export async function ensureDefaultExamEnrollmentSafely(studentId: string): Promise<void> {
  try {
    await ensureDefaultExamEnrollment(studentId);
  } catch (error) {
    console.error("[default-enrollment] failed for student", studentId, error);
  }
}
