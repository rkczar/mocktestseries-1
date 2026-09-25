/**
 * Default exam enrollment backfill for EXISTING students.
 *
 * New students are enrolled at sign-up (lib/default-enrollment.ts) and the
 * Dashboard enrolls any active student on their next visit; this script does
 * the same for everyone at once so the admin enrollment view is complete
 * without waiting for logins. It goes through the exact same
 * ensureDefaultExamEnrollment() — upsert on the (studentId, examId) unique
 * key, never touches existing rows, skips students who unenrolled from the
 * default exam, and only considers ACTIVE (non-deleted, non-suspended)
 * students. Enrollment gates no content (see lib/student-data.ts "My Exams"),
 * so the write is purely additive.
 *
 *   npx tsx scripts/backfill-default-enrollment.ts           # dry run (counts only)
 *   npx tsx scripts/backfill-default-enrollment.ts --apply   # write
 */
import "dotenv/config";
import { StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureDefaultExamEnrollment, resolveDefaultExam } from "@/lib/default-enrollment";

const apply = process.argv.includes("--apply");

async function main() {
  const exam = await resolveDefaultExam();
  if (!exam) {
    console.log("No default exam resolves (none configured / not exactly one active exam) — nothing to do.");
    return;
  }
  console.log(`Default exam: ${exam.name} (${exam.id})  mode: ${apply ? "APPLY" : "DRY RUN"}`);

  const students = await prisma.student.findMany({
    where: { status: StudentStatus.ACTIVE },
    select: {
      id: true,
      examEnrollments: { select: { examId: true, exam: { select: { isActive: true } } } },
    },
  });

  const counts = { checked: students.length, alreadyEnrolled: 0, backfilled: 0, skippedOptedOut: 0, wouldBackfill: 0 };
  for (const s of students) {
    if (s.examEnrollments.some((e) => e.exam.isActive)) {
      counts.alreadyEnrolled++;
      continue;
    }
    const optedOut = await prisma.studentActivity.findFirst({
      where: { studentId: s.id, activity: "EXAM_UNENROLLED", metadata: { path: ["examId"], equals: exam.id } },
      select: { id: true },
    });
    if (optedOut) {
      counts.skippedOptedOut++;
      continue;
    }
    if (!apply) {
      counts.wouldBackfill++;
      continue;
    }
    const outcome = await ensureDefaultExamEnrollment(s.id);
    if (outcome.status === "ENROLLED") counts.backfilled++;
    else if (outcome.status === "ALREADY_ENROLLED") counts.alreadyEnrolled++;
    else counts.skippedOptedOut++;
  }

  const nonActive = await prisma.student.count({ where: { status: { not: StudentStatus.ACTIVE } } });
  console.log(JSON.stringify({ ...counts, skippedNonActiveStudents: nonActive }, null, 2));

  const dupes = await prisma.studentExamEnrollment.groupBy({ by: ["studentId", "examId"], _count: true, having: { studentId: { _count: { gt: 1 } } } });
  console.log(`Duplicate (studentId, examId) enrollment rows: ${dupes.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
