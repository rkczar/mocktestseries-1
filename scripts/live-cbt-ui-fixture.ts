/**
 * Fixture for scripts/verify-live-cbt-ui.mjs, in a DISPOSABLE copy of
 * production. Live mock L1 (enrollment ON, Single Attempt, results after the
 * window, public enrolled count, a Solution PDF "after submission"); the
 * browser test sets L1's window to start ~70 s after it begins. Ordinary
 * mock L2 (enrollment OFF). Mock L3 (Available Now) for the admin Fixed
 * Window defaults check. Students: viewer (desktop), early (mobile, submits
 * early), abandon (starts then closes the browser), latecomer (registers via
 * the share link during the window). Plus a MASTER_ADMIN.
 *
 *   DATABASE_URL=<scratch> STORAGE_DIR=<disposable dir> NODE_OPTIONS="--conditions=react-server" npx tsx scripts/live-cbt-ui-fixture.ts setup > /tmp/lcb.json
 *   … cleanup
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import argon2 from "argon2";
import { QuestionStatus, StudentAuthProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { testResourcesDir } from "@/lib/test-resources";

const PASSWORD = "QaLiveCbt!2345678";
const ADMIN = "qa-lcb-admin";
const TAG = "QALCB";
const EMAILS = { viewer: "qa-lcb-viewer@example.test", early: "qa-lcb-early@example.test", abandon: "qa-lcb-abandon@example.test" };
const LATE_EMAIL = "qa-lcb-late@example.test";
/** The late joiner's number; with mobile verification ON it signs up by OTP and has no email. */
const LATE_MOBILE = "+919000007999";

if (/\/mocktestseries(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against what looks like the production database.");
  process.exit(2);
}
if (!process.env.STORAGE_DIR) {
  console.error("STORAGE_DIR must point at a disposable directory.");
  process.exit(2);
}

async function cleanup() {
  const admin = await prisma.adminUser.findUnique({ where: { username: ADMIN }, select: { id: true } });
  if (admin) {
    await prisma.loginAttempt.deleteMany({ where: { adminUserId: admin.id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: admin.id } }).catch(() => {});
    await prisma.testResource.deleteMany({ where: { createdByAdminId: admin.id } });
    await prisma.adminUser.delete({ where: { id: admin.id } });
  }
  const students = await prisma.student.findMany({ where: { OR: [{ email: { in: [...Object.values(EMAILS), LATE_EMAIL] } }, { mobile: LATE_MOBILE }, { studentId: { startsWith: `${TAG}-` } }] }, select: { id: true } });
  const ids = students.map((s) => s.id);
  await prisma.testAttempt.deleteMany({ where: { studentId: { in: ids } } });
  for (const model of ["studentLoginAttempt", "studentActivity", "studentSession", "deviceSecurityEvent", "studentDevice", "studentExamEnrollment", "studentProfile"] as const) {
    await (prisma[model] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { studentId: { in: ids } } });
  }
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  const mocks = await prisma.mockTest.findMany({ where: { title: { startsWith: `${TAG} ` } }, select: { id: true } });
  await prisma.testResource.deleteMany({ where: { mockTestId: { in: mocks.map((m) => m.id) } } });
  await prisma.testAttempt.deleteMany({ where: { mockTestId: { in: mocks.map((m) => m.id) } } });
  await prisma.mockTest.deleteMany({ where: { id: { in: mocks.map((m) => m.id) } } });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "cleanup") return cleanup();
  if (mode !== "setup") throw new Error("usage: live-cbt-ui-fixture.ts setup|cleanup");
  await cleanup();

  const exam = await prisma.exam.findFirstOrThrow({
    where: { isActive: true, questions: { some: { status: QuestionStatus.PUBLISHED } } },
    orderBy: { questions: { _count: "desc" } },
  });
  const bank = await prisma.question.findMany({
    where: { examId: exam.id, status: QuestionStatus.PUBLISHED, questionType: "SINGLE_CORRECT", contentFormat: "PLAIN", options: { some: { isCorrect: true } } },
    take: 4,
    orderBy: { code: "asc" },
  });
  const passwordHash = await argon2.hash(PASSWORD);
  const role = await prisma.role.findUniqueOrThrow({ where: { name: "MASTER_ADMIN" }, select: { id: true } });
  const admin = await prisma.adminUser.create({ data: { name: "QA Live CBT Admin", username: ADMIN, passwordHash, roleId: role.id } });

  const far = new Date(Date.now() + 30 * 864e5);
  const mk = (title: string, data: Record<string, unknown>) =>
    prisma.mockTest.create({
      data: { examId: exam.id, title: `${TAG} ${title}`, durationMinutes: 10, status: "PUBLISHED", accessType: "FREE", ...data, questions: { create: bank.map((q, order) => ({ questionId: q.id, order })) } },
    });
  const l1 = await mk("Live CBT", {
    availableFrom: far,
    availableUntil: new Date(far.getTime() + 3_600_000),
    enrollmentEnabled: true,
    showEnrolledCount: true,
    attemptPolicy: "SINGLE_ATTEMPT",
    resultReleaseMode: "AFTER_WINDOW",
  });
  const l2 = await mk("Ordinary", {});
  const l3 = await mk("Becomes Live", {});

  mkdirSync(testResourcesDir(), { recursive: true });
  const file = `qa-lcb-solution-${Date.now().toString(36)}.pdf`;
  writeFileSync(path.join(testResourcesDir(), file), "%PDF-1.4\n% QA live CBT solution fixture\n%%EOF\n");
  const solution = await prisma.testResource.create({
    data: {
      type: "SOLUTION_PDF",
      title: "QA Solution",
      fileUrl: `/storage/test-resources/${file}`,
      mimeType: "application/pdf",
      fileSizeBytes: 48,
      releasePolicy: "AFTER_SUBMISSION",
      mockTestId: l1.id,
      createdByAdminId: admin.id,
    },
  });

  const out: Record<string, unknown> = { password: PASSWORD, adminUsername: ADMIN, examId: exam.id, examName: exam.name, l1: l1.id, l2: l2.id, l3: l3.id, solutionId: solution.id, lateEmail: LATE_EMAIL, students: {} };
  let n = 0;
  for (const [key, email] of Object.entries(EMAILS)) {
    n += 1;
    const s = await prisma.student.create({
      data: { studentId: `${TAG}-${n}`, name: `Live ${key[0].toUpperCase()}${key.slice(1)} Tester`, email, mobile: `+9190000071${n}0`, passwordHash, authProvider: StudentAuthProvider.CREDENTIALS },
    });
    await prisma.studentProfile.create({ data: { studentId: s.id } });
    await prisma.studentExamEnrollment.create({ data: { studentId: s.id, examId: exam.id } });
    (out.students as Record<string, unknown>)[key] = { id: s.id, email };
  }
  console.log(JSON.stringify(out));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
